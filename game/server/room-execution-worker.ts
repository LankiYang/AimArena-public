// Real authoritative matches execute here; the parent retains the lobby and all transport connections.
import { parentPort, threadId } from 'node:worker_threads';
import { Room, type Client, type MatchHandle } from './lobby.ts';
import { createMatch, type MatchHost } from './match.ts';
import type { RoomCommand, RoomData, RoomEvent, FromRoomWorker, ToRoomWorker } from './room-execution-protocol.ts';

if (!parentPort) throw new Error('room-execution-worker requires a parent port');
const port = parentPort;
console.log(`[room-worker] online thread=${threadId}`);
interface RunningRoom { room: Room; host: MatchHost; handle: MatchHandle | null; epochs: Map<number, number> }
const rooms = new Map<number, RunningRoom>();
// Bound the MessagePort even if the parent is stalled. Exceeding this limit fails the worker explicitly.
const outstanding = new Map<number, number>();
let outputSeq = 0, outputBytes = 0;
function emit(key: number, event: RoomEvent) {
  const bytes = event.t === 'binary' ? event.data.byteLength : 4096;
  if (outstanding.size >= 2048 || outputBytes + bytes > 8 * 1024 * 1024)
    throw new Error('room worker output queue exceeded 2048 events / 8 MiB');
  const seq = ++outputSeq;
  outstanding.set(seq, bytes);
  outputBytes += bytes;
  const message: FromRoomWorker = { t: 'event', key, seq, event };
  // encodeSnapshot owns its buffer. JSON combat batches may be shared between recipients, so clone those normally.
  if (event.t === 'binary' && event.data.buffer instanceof ArrayBuffer)
    port.postMessage(message, [event.data.buffer]);
  else port.postMessage(message);
}
function synchronize(key: number, running: RunningRoom, data: RoomData) {
  const { room, host, epochs } = running;
  const previous = new Map(room.members.map(m => [m.id, m]));
  room.members = data.info.members.map(m => {
    const existing = previous.get(m.id);
    return existing ? Object.assign(existing, m) : m;
  });
  room.settings = data.info.settings;
  room.hostId = data.info.hostId;
  room.name = data.info.name;
  const present = new Set(data.clients.map(c => c.id));
  for (const id of host.clients.keys()) if (!present.has(id)) { host.clients.delete(id); epochs.delete(id); }
  for (const c of data.clients) {
    let client = host.clients.get(c.id);
    if (!client) {
      client = {
        id: c.id, name: c.name, agent: c.agent, build: c.build, roomId: room.id,
        onBinary: null,
        send(message) {
          const current = host.clients.get(c.id);
          if (current && !current.parked) emit(key, { t: 'json', id: c.id, epoch: epochs.get(c.id)!, message });
        },
        sendBinary(output) {
          const current = host.clients.get(c.id);
          if (current && !current.parked) emit(key, { t: 'binary', id: c.id, epoch: epochs.get(c.id)!, data: output });
        },
      };
      host.clients.set(c.id, client);
    }
    Object.assign(client, { name: c.name, agent: c.agent, build: c.build, mapRopeRevision: c.mapRopeRevision, parked: c.parked });
    epochs.set(c.id, c.epoch);
  }
}
function dispose(key: number, ended: boolean) {
  const running = rooms.get(key);
  if (running) {
    running.handle?.dispose();
    rooms.delete(key);
  }
  if (ended) emit(key, { t: 'end' });
  emit(key, { t: 'disposed' });
}
function execute(key: number, command: RoomCommand) {
  if (command.t === 'create') {
    if (rooms.has(key) || command.data.info.settings.map !== command.world.map) throw new Error('invalid room assignment');
    const info = command.data.info;
    const room = new Room(info.id, info.name, info.hostId, info.priv, info.settings);
    room.state = 'loading';
    const host: MatchHost = {
      clients: new Map<number, Client>(),
      broadcastRoom() { emit(key, { t: 'state', state: room.state }); },
      endMatch() { dispose(key, true); },
    };
    const running: RunningRoom = { room, host, handle: null, epochs: new Map() };
    rooms.set(key, running);
    synchronize(key, running, command.data);
    running.handle = createMatch(room, host, { world: command.world });
    return;
  }
  if (command.t === 'dispose') { dispose(key, false); return; }
  const running = rooms.get(key);
  if (!running?.handle) return;
  const h = running.handle;
  switch (command.t) {
    case 'sync': synchronize(key, running, command.data); break;
    case 'input': {
      const c = running.host.clients.get(command.id);
      if (c && !c.parked && running.epochs.get(command.id) === command.epoch) c.onBinary?.(command.data);
      break;
    }
    case 'loaded': h.playerLoaded(command.id); break;
    case 'left': h.playerLeft(command.id); break;
    case 'join': h.joinPlayer?.(command.member, command.replaceBotId); break;
    case 'resume': running.epochs.set(command.id, command.epoch); h.resumePlayer?.(command.id); break;
    case 'weapon': h.selectWeapon?.(command.id, command.weapon); break;
    case 'buy': h.buy?.(command.id, command.item); break;
    case 'spectate': h.spectate?.(command.id, command.dir); break;
  }
}
port.on('message', (message: ToRoomWorker) => {
  if (message.t === 'outputAck') {
    // Parent acknowledges a contiguous prefix: MessagePort delivers these events in order.
    for (const [seq, bytes] of outstanding) {
      if (seq > message.seq) break;
      outputBytes -= bytes;
      outstanding.delete(seq);
    }
    return;
  }
  for (const { key, command } of message.commands) {
    try {
      execute(key, command);
    } catch (error) {
      // A room command must not take down unrelated rooms sharing this worker or batch.
      console.error(`[room-worker] room=${key} command=${command.t} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      dispose(key, true);
    }
  }
  const ack: FromRoomWorker = { t: 'ack', seq: message.seq };
  port.postMessage(ack);
});
port.on('close', () => { for (const key of rooms.keys()) rooms.get(key)?.handle?.dispose(); });
