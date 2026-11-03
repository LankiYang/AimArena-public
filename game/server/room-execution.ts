import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { BuyItem } from '../shared/economy.ts';
import type { Member } from '../shared/lobby.ts';
import type { WeaponId } from '../shared/combat.ts';
import { Room, type Client, type Lobby, type MatchHandle } from './lobby.ts';
import { acquireWorld, WorldLoadCancelled, type WorldLease } from './world.ts';
import type { FromRoomWorker, RoomCommand, RoomData, RoomEvent, ToRoomWorker } from './room-execution-protocol.ts';

interface WorkerSlot {
  worker: Worker;
  rooms: Map<number, ProxyMatch>;
  nextSeq: number;
  busy: boolean;
  outputAckSeq: number;
  outputAckPending: boolean;
  failed: boolean;
  error: string | null;
}
interface ProxyMatch {
  key: number;
  room: Room;
  lobby: Lobby;
  handle: MatchHandle | null;
  slot: WorkerSlot | null;
  lease: WorldLease | null;
  queue: RoomCommand[];
  queuedBytes: number;
  epoch: Map<number, number>;
  inputs: Map<number, { client: Client; receive: (data: Uint8Array) => boolean }>;
  dead: boolean;
  closing: boolean;
  started: boolean;
}
const enabled = process.env.ROOM_WORKERS === '1';
const requestedWorkers = Number(process.env.ROOM_WORKER_COUNT);
const availableWorkers = Math.max(0, (os.availableParallelism?.() ?? os.cpus().length) - 1);
const workerBudgetMb = Number(process.env.ROOM_WORKER_MEMORY_BUDGET_MB ?? 1536);
const perWorkerReserveMb = 768; // 384 MiB heap + 64 MiB young generation + 320 MiB isolate/native headroom.
const configuredWorkers = Number.isInteger(requestedWorkers) && requestedWorkers > 0 ? requestedWorkers : 8;
const maxWorkers = Number.isFinite(workerBudgetMb) && workerBudgetMb >= perWorkerReserveMb
  ? Math.min(8, configuredWorkers, availableWorkers, Math.floor(workerBudgetMb / perWorkerReserveMb)) : 0;
const maxRoomsPerWorker = 32;
const maxPendingMatches = 128;
const maxQueuedCommands = 2048;
const maxQueuedBytes = 2 * 1024 * 1024;
const maxCommandsPerBatch = 64;
const slots: WorkerSlot[] = [];
const admissions: ProxyMatch[] = [];
let nextKey = 1;
const proxies = new WeakMap<MatchHandle, ProxyMatch>();

function roomData(proxy: ProxyMatch): RoomData {
  return {
    info: proxy.room.info(),
    clients: [...proxy.lobby.clients.values()].filter(c => c.roomId === proxy.room.id).map(c => {
      let epoch = proxy.epoch.get(c.id);
      if (epoch === undefined) { epoch = 1; proxy.epoch.set(c.id, epoch); }
      return { id: c.id, name: c.name, agent: c.agent, build: c.build,
        mapRopeRevision: c.mapRopeRevision, parked: !!c.parked, epoch };
    }),
  };
}
function reportQueue() {
  admissions.forEach((proxy, index) => {
    const position = index + 1;
    for (const member of proxy.room.members) if (!member.bot)
      proxy.lobby.clients.get(member.id)?.send({ t: 'queue', map: proxy.room.settings.map,
        position, total: admissions.length, residentBytes: 0, budgetBytes: 0 });
  });
}
function finish(proxy: ProxyMatch) {
  if (proxy.dead) return;
  proxy.dead = true;
  proxy.queue.length = 0;
  proxy.queuedBytes = 0;
  for (const { client, receive } of proxy.inputs.values()) if (client.onBinary === receive) client.onBinary = null;
  proxy.inputs.clear();
  proxy.epoch.clear();
  const index = admissions.indexOf(proxy);
  if (index >= 0) admissions.splice(index, 1);
  proxy.slot?.rooms.delete(proxy.key);
  proxy.slot = null;
  proxy.lease?.release();
  proxy.lease = null;
}
function fail(proxy: ProxyMatch, reason: string) {
  if (proxy.dead) return;
  console.error(`[room-worker] room=${proxy.room.id} failed: ${reason}`);
  if (proxy.room.match === proxy.handle) proxy.lobby.endMatch(proxy.room);
  else proxy.handle?.dispose();
}
function sendQueueClear(proxy: ProxyMatch) {
  for (const member of proxy.room.members) if (!member.bot)
    proxy.lobby.clients.get(member.id)?.send({ t: 'queue', map: proxy.room.settings.map,
      position: 0, total: 0, residentBytes: 0, budgetBytes: 0 });
}
function deliver(proxy: ProxyMatch, event: RoomEvent) {
  if (proxy.dead || (proxy.closing && event.t !== 'disposed')) return;
  switch (event.t) {
    case 'json': {
      const client = proxy.lobby.clients.get(event.id);
      if (client && client.roomId === proxy.room.id && !client.parked && proxy.epoch.get(event.id) === event.epoch) client.send(event.message);
      break;
    }
    case 'binary': {
      const client = proxy.lobby.clients.get(event.id);
      if (client && client.roomId === proxy.room.id && !client.parked && proxy.epoch.get(event.id) === event.epoch) client.sendBinary(event.data);
      break;
    }
    case 'state':
      proxy.room.state = event.state;
      proxy.lobby.broadcastRoom(proxy.room);
      break;
    case 'end':
      if (proxy.room.match === proxy.handle) proxy.lobby.endMatch(proxy.room);
      break;
    case 'disposed':
      finish(proxy);
      admit();
      break;
  }
}
function enqueue(proxy: ProxyMatch, command: RoomCommand, priority = false) {
  if (proxy.dead || (proxy.closing && command.t !== 'dispose')) return;
  const bytes = command.t === 'input' ? command.data.byteLength : 0;
  if (proxy.queue.length >= maxQueuedCommands || proxy.queuedBytes + bytes > maxQueuedBytes) {
    fail(proxy, `command queue exceeded ${maxQueuedCommands} events / ${maxQueuedBytes} bytes`);
    return;
  }
  if (priority) proxy.queue.unshift(command);
  else proxy.queue.push(command);
  proxy.queuedBytes += bytes;
  if (proxy.slot) pump(proxy.slot);
}
function pump(slot: WorkerSlot) {
  if (slot.failed || slot.busy) return;
  const commands: { key: number; command: RoomCommand }[] = [];
  while (commands.length < maxCommandsPerBatch) {
    let selected: ProxyMatch | null = null;
    for (const proxy of slot.rooms.values()) {
      if (proxy.queue.length && !proxy.dead && (proxy.started || proxy.queue[0].t === 'create')) {
        selected = proxy;
        break;
      }
    }
    if (!selected) break;
    const command = selected.queue.shift()!;
    if (command.t === 'input') selected.queuedBytes -= command.data.byteLength;
    // Round-robin within a bounded batch: one IPC round trip must not serialize every player's packet.
    slot.rooms.delete(selected.key);
    slot.rooms.set(selected.key, selected);
    commands.push({ key: selected.key, command });
    // createMatch installs player input in a microtask; do not execute later commands
    // in this same worker callback before that initialization has run.
    if (command.t === 'create') { selected.started = true; break; }
  }
  if (!commands.length) return;
  slot.busy = true;
  const message: ToRoomWorker = { t: 'commands', seq: ++slot.nextSeq, commands };
  try {
    slot.worker.postMessage(message);
  } catch (error) {
    slot.error = String(error);
    void slot.worker.terminate(); // Release leases only after the worker actually exits.
  }
}
function crash(slot: WorkerSlot, reason: string) {
  if (slot.failed) return;
  slot.failed = true;
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
  for (const proxy of [...slot.rooms.values()]) {
    finish(proxy);
    console.error(`[room-worker] room=${proxy.room.id} failed: ${reason}`);
    if (proxy.room.match === proxy.handle) proxy.lobby.endMatch(proxy.room);
  }
  slot.rooms.clear();
  admit();
}
function spawnSlot(): WorkerSlot {
  if (maxWorkers < 1) throw new Error('ROOM_WORKERS=1 requires at least one available worker and ROOM_WORKER_MEMORY_BUDGET_MB >= 768');
  const worker = new Worker(new URL('./room-execution-worker.ts', import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64 },
  });
  const slot: WorkerSlot = { worker, rooms: new Map(), nextSeq: 0, busy: false, outputAckSeq: 0, outputAckPending: false, failed: false, error: null };
  slots.push(slot);
  console.log(`[room-worker] started thread=${worker.threadId}`);
  worker.on('message', (message: FromRoomWorker) => {
    if (message.t === 'ack') {
      if (message.seq !== slot.nextSeq) return;
      slot.busy = false;
      pump(slot);
      return;
    }
    const proxy = slot.rooms.get(message.key);
    if (proxy) deliver(proxy, message.event);
    // MessagePort preserves event order. A cumulative acknowledgement once per
    // event-loop turn releases every preceding output without one IPC per snapshot.
    slot.outputAckSeq = message.seq;
    if (!slot.outputAckPending) {
      slot.outputAckPending = true;
      setImmediate(() => {
        slot.outputAckPending = false;
        if (slot.failed) return;
        const ack: ToRoomWorker = { t: 'outputAck', seq: slot.outputAckSeq };
        try { worker.postMessage(ack); } catch { /* crash handler owns cleanup */ }
      });
    }
  });
  worker.on('error', error => { slot.error = error.message; });
  worker.on('exit', code => crash(slot, slot.error ?? `exit ${code}`));
  worker.unref();
  return slot;
}
async function startProxy(proxy: ProxyMatch) {
  const lease = acquireWorld(proxy.room.settings.map, q => {
    if (!q.blocked) return;
    for (const member of proxy.room.members) if (!member.bot)
      proxy.lobby.clients.get(member.id)?.send({ t: 'queue', map: q.map, position: q.position,
        total: q.total, residentBytes: q.residentBytes, budgetBytes: q.budgetBytes });
  });
  proxy.lease = lease;
  try {
    const world = await lease.promise;
    if (proxy.dead || proxy.closing) { lease.release(); proxy.lease = null; return; }
    enqueue(proxy, { t: 'create', data: roomData(proxy), world }, true);
    sendQueueClear(proxy);
  } catch (error) {
    if (error instanceof WorldLoadCancelled || proxy.dead) return;
    fail(proxy, error instanceof Error ? error.message : String(error));
  }
}
function admit() {
  while (admissions.length) {
    let leastLoaded: WorkerSlot | null = null;
    for (const slot of slots) if (!slot.failed && slot.rooms.size < maxRoomsPerWorker &&
      (!leastLoaded || slot.rooms.size < leastLoaded.rooms.size)) leastLoaded = slot;
    if (!leastLoaded && slots.length >= maxWorkers) break;
    const proxy = admissions.shift()!;
    if (proxy.dead) continue;
    const slot = slots.length < maxWorkers && (!leastLoaded || leastLoaded.rooms.size > 0)
      ? spawnSlot() : leastLoaded!;
    proxy.slot = slot;
    slot.rooms.set(proxy.key, proxy);
    void startProxy(proxy);
  }
  reportQueue();
}
function installInput(proxy: ProxyMatch, handle: MatchHandle, lobby: Lobby, room: Room) {
  for (const [id, hook] of proxy.inputs) {
    if (lobby.clients.get(id) === hook.client && hook.client.roomId === room.id && !hook.client.parked) continue;
    if (hook.client.onBinary === hook.receive) hook.client.onBinary = null;
    proxy.inputs.delete(id);
  }
  for (const client of lobby.clients.values()) if (client.roomId === room.id && !client.parked) {
    if (!proxy.epoch.has(client.id)) proxy.epoch.set(client.id, 1);
    let hook = proxy.inputs.get(client.id);
    if (!hook) {
      const receive = (data: Uint8Array) => lobby.clients.get(client.id) === client && client.onBinary === receive &&
        sendRoomInput(handle, client.id, data);
      hook = { client, receive };
      proxy.inputs.set(client.id, hook);
    }
    client.onBinary = hook.receive;
  }
}
export function roomWorkersEnabled() { return enabled; }
export function createRoomMatch(room: Room, lobby: Lobby): MatchHandle {
  if (!enabled) throw new Error('ROOM_WORKERS=1 未启用隔离房间执行');
  if (maxWorkers < 1) throw new Error('房间线程资源不足：至少需要 2 个可用 CPU 和 768 MiB 的线程预算');
  if (admissions.length >= maxPendingMatches)
    throw new Error(`房间执行排队已满（${maxPendingMatches}），请稍后重试`);
  const proxy: ProxyMatch = { key: nextKey++, room, lobby, handle: null, slot: null, lease: null,
    queue: [], queuedBytes: 0, epoch: new Map(), inputs: new Map(), dead: false, closing: false, started: false };
  admissions.push(proxy);
  const handle: MatchHandle = {
    playerLoaded(id) { enqueue(proxy, { t: 'loaded', id }); },
    playerLeft(id) { enqueue(proxy, { t: 'left', id }); },
    joinPlayer(member: Member, replaceBotId: number | null) { enqueue(proxy, { t: 'join', member, replaceBotId }); },
    resumePlayer(id) {
      const epoch = (proxy.epoch.get(id) ?? 0) + 1;
      proxy.epoch.set(id, epoch);
      installInput(proxy, handle, lobby, room);
      enqueue(proxy, { t: 'resume', id, epoch });
    },
    selectWeapon(id: number, weapon: WeaponId) { enqueue(proxy, { t: 'weapon', id, weapon }); },
    buy(id: number, item: BuyItem) { enqueue(proxy, { t: 'buy', id, item }); },
    spectate(id, dir) { enqueue(proxy, { t: 'spectate', id, dir }); },
    sync() {
      installInput(proxy, handle, lobby, room);
      enqueue(proxy, { t: 'sync', data: roomData(proxy) });
    },
    dispose() {
      if (proxy.dead || proxy.closing) return;
      proxy.closing = true;
      proxy.queue.length = 0;
      proxy.queuedBytes = 0;
      if (!proxy.started) {
        finish(proxy);
        admit();
        return;
      }
      enqueue(proxy, { t: 'dispose' });
    },
  };
  proxy.handle = handle;
  proxies.set(handle, proxy);
  installInput(proxy, handle, lobby, room);
  admit();
  return handle;
}
export function sendRoomInput(handle: MatchHandle, id: number, data: Uint8Array) {
  const proxy = proxies.get(handle);
  if (!proxy || proxy.dead || proxy.closing || proxy.room.match !== handle) return false;
  const client = proxy.lobby.clients.get(id);
  if (!client || client.parked || client.roomId !== proxy.room.id) return false;
  enqueue(proxy, { t: 'input', id, epoch: proxy.epoch.get(id) ?? 1, data });
  return true;
}
