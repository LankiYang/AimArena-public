// world.ts — 服务端地图世界：worker + 离线缓存加载（几何构建见 world-build.ts）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MapId } from '../shared/catalog.ts';
import { raycast, type BVH } from '../shared/world/bvh.ts';
import type { ServerWorld } from './world-build.ts';
import { worldCacheSize, worldFromCache, type CacheHeader } from './world-cache.ts';

export interface QueueState {
  map: MapId; position: number; total: number; residentBytes: number; budgetBytes: number;
  /** true = 真的被挡住（预算不足或前面有别的房间在等）；false = 只是正在加载，不应当提示用户排队 */
  blocked: boolean;
}
export class WorldLoadCancelled extends Error {
  constructor(map: MapId) { super(`${map}: 地图加载已取消`); this.name = 'WorldLoadCancelled'; }
}
export interface WorldLease {
  /** 世界所有权：租约有效期间这张图不会被回收，驻留字节计入全局预算 */
  promise: Promise<ServerWorld>;
  /** 归还：等待中则取消；已加载则减引用，最后一个引用释放后世界可被 GC 回收 */
  release(): void;
}

interface Job { map: MapId; resolve: (w: ServerWorld) => void; reject: (e: unknown) => void; onQueue?: (q: QueueState) => void; cancelled?: boolean }
interface Pin { world: ServerWorld; count: number; bytes: number }

const worldCache = new Map<MapId, WeakRef<ServerWorld>>();
const pinned = new Map<MapId, Pin>();
const queue: Job[] = [];
let pumpRunning = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_QUEUE = 32;

const residentBytes = () => [...pinned.values()].reduce((sum, p) => sum + p.bytes, 0);

let budgetCache: number | null = null;
/** 驻留预算：同时被对局持有的地图世界总字节上限。默认取进程可用内存上限的 55%（cgroup 优先），
 *  可用 MAP_RESIDENT_BUDGET_MB 覆盖。超出时新房间排队，已有对局不受影响。 */
async function residentBudgetBytes(): Promise<number> {
  if (budgetCache !== null) return budgetCache;
  const override = Number(process.env.MAP_RESIDENT_BUDGET_MB);
  if (Number.isFinite(override) && override > 0) return (budgetCache = override * 1024 * 1024);
  // 用内存上限（cgroup memory.max 或物理内存）的 55%，而不是“当下剩余”：
  // 预算是长期不变的上限，剩余内存受缓存/临时分配影响，不能每次重新估算。
  const limit = await memoryLimitBytes();
  return (budgetCache = Math.max(256 * 1024 * 1024, limit * 0.55));
}

async function memoryLimitBytes(): Promise<number> {
  if (process.platform !== 'linux') return os.totalmem();
  try {
    const membership = (await fs.promises.readFile('/proc/self/cgroup', 'utf8')).split('\n').find(l => l.startsWith('0::'));
    const relative = membership?.slice(3);
    if (!relative) return os.totalmem();
    const text = await fs.promises.readFile(path.posix.join('/sys/fs/cgroup', relative, 'memory.max'), 'utf8');
    const limit = Number(text.trim());
    if (Number.isFinite(limit) && limit > 0) return Math.min(limit, os.totalmem());
  } catch { /* fall through */ }
  return os.totalmem();
}

function notifyQueue() {
  void residentBudgetBytes().then((budgetBytes) => {
    const total = queue.length;
    const residentBytes_ = residentBytes();
    queue.forEach((job, i) => {
      const fits = pinned.has(job.map) || residentBytes_ + cacheBytes(job.map) <= budgetBytes;
      job.onQueue?.({ map: job.map, position: i + 1, total, residentBytes: residentBytes_, budgetBytes, blocked: i > 0 || !fits });
    });
  });
}

/** 每张图的缓存字节（用于预算与准入的峰值估算） */
function cacheBytes(map: MapId): number {
  try { return worldCacheSize(map); } catch { return 0; }
}

function candidate(job: Job): { world: ServerWorld; bytes: number } | null {
  const pin = pinned.get(job.map);
  if (pin) return { world: pin.world, bytes: pin.bytes };
  const cached = worldCache.get(job.map)?.deref();
  return cached ? { world: cached, bytes: cacheBytes(job.map) } : null;
}

/** 依次找第一个「能立即放行」的等待房间：已驻留的图不必等大图腾出空间。 */
function nextAdmissible(deferred: Set<MapId>): number {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    if (deferred.has(job.map)) continue;
    if (pinned.has(job.map)) return i;
    const bytes = cacheBytes(job.map);
    if (!bytes) return i; // 缺缓存：交给加载流程给出可操作的错误
    if (residentBytes() + bytes <= (budgetCache ?? 0)) return i;
  }
  return -1;
}

function pinTake(map: MapId, world: ServerWorld, bytes: number) {
  const entry = pinned.get(map);
  if (entry) entry.count++;
  else pinned.set(map, { world, count: 1, bytes });
}

async function pump() {
  if (pumpRunning) return;
  pumpRunning = true; // 必须在第一个 await 前持锁，冷启动的并发请求也只能进入一个泵。
  const deferred = new Set<MapId>();
  try {
    await residentBudgetBytes();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    for (;;) {
      const index = nextAdmissible(deferred);
      if (index < 0) break;
      const job = queue.splice(index, 1)[0];
      if (job.cancelled) continue;
      const ready = candidate(job);
      if (ready) {
        pinTake(job.map, ready.world, ready.bytes);
        job.resolve(ready.world);
      } else if (await loadInWorker(job)) {
        deferred.add(job.map);
      }
      notifyQueue();
    }
  } finally {
    pumpRunning = false;
    notifyQueue();
    if (queue.length && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; void pump(); }, 2000);
      retryTimer.unref();
    }
  }
}

/** true 表示余量不足，当前这一轮不再反复尝试同一张地图。 */
async function loadInWorker(job: Job): Promise<boolean> {
  const started = performance.now();
  console.log(`[world-load] time=${new Date().toISOString()} event=start map=${job.map}`);
  try {
    const bytes = cacheBytes(job.map);
    if (!bytes)
      throw new Error(`${job.map}: 缺少地图世界缓存；请重启服务器以重新生成`);
    const headroom = await availableMemoryBytes();
    if (job.cancelled) return false;
    const reserve = (Number(process.env.MAP_LOAD_RESERVE_MB) || 192) * 1024 * 1024;
    // shared worker mode retains the file Buffer while copying its bytes into a SAB.
    const shared = process.env.ROOM_WORKERS === '1';
    const required = bytes * (shared ? 2 : 1) + reserve;
    if (headroom < required) {
      console.log(`[world-load] time=${new Date().toISOString()} event=defer map=${job.map} headroom=${headroom} required=${required} shared=${shared}`);
      queue.unshift(job);
      return true;
    }
    const world = await readWorldInWorker(job.map);
    worldCache.set(job.map, new WeakRef(world));
    if (!job.cancelled) {
      pinTake(job.map, world, bytes);
      job.resolve(world);
    }
    // 首位等待者取消不能让其余同图房间重新读一次；完成时一并兑现所有有效租约。
    for (let i = 0; i < queue.length;) {
      const next = queue[i];
      if (next.map !== job.map) { i++; continue; }
      queue.splice(i, 1);
      if (!next.cancelled) {
        pinTake(next.map, world, bytes);
        next.resolve(world);
      }
    }
    console.log(`[world-load] time=${new Date().toISOString()} event=end map=${job.map} status=ok duration_ms=${(performance.now() - started).toFixed(0)} cache_bytes=${bytes} pawn_triangles=${world.pawn.count} projectile_triangles=${world.projectile.count} resident_bytes=${residentBytes()}`);
  } catch (error) {
    console.error(`[world-load] time=${new Date().toISOString()} event=end map=${job.map} status=error duration_ms=${(performance.now() - started).toFixed(0)} reason=${error instanceof Error ? error.message : String(error)}`);
    if (!job.cancelled) job.reject(error);
    for (let i = 0; i < queue.length;) {
      const next = queue[i];
      if (next.map !== job.map) { i++; continue; }
      queue.splice(i, 1);
      if (!next.cancelled) next.reject(error);
    }
  }
  return false;
}

/** 取一张图的使用权。等待期间通过 onQueue 收到排队位置；已有对局从不被排队影响。 */
export function acquireWorld(map: MapId, onQueue?: (q: QueueState) => void): WorldLease {
  let pending: Job | null = null;
  let held = false;

  const pin = pinned.get(map);
  if (pin) {
    pin.count++;
    held = true;
    return { promise: Promise.resolve(pin.world), release() { if (held) { held = false; dropPin(map); } } };
  }
  if (queue.length >= MAX_QUEUE)
    return { promise: Promise.reject(new Error(`${map}: 排队已满（${MAX_QUEUE} 个房间在等地图），请稍后再试`)), release() {} };

  const promise = new Promise<ServerWorld>((resolve, reject) => {
    const job: Job = { map, onQueue, resolve: (w) => { pending = null; held = true; resolve(w); }, reject: (e) => { pending = null; reject(e); } };
    pending = job;
    queue.push(job);
    notifyQueue();
    void pump();
  });
  return {
    promise,
    release() {
      const job = pending;
      pending = null;
      if (job && !held) {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        job.cancelled = true;
        job.reject(new WorldLoadCancelled(map));
        notifyQueue();
        void pump();
        return;
      }
      if (held) { held = false; dropPin(map); }
    },
  };
}

function dropPin(map: MapId) {
  const entry = pinned.get(map);
  if (entry) {
    entry.count--;
    if (entry.count <= 0) pinned.delete(map);
  }
  void pump();
}

/** 离线工具 / 冷启动预烘焙用：取一次、自动归还（调用方自己持有返回值，世界仍然活着）。 */
export function loadWorld(map: MapId, onQueue?: (q: QueueState) => void): Promise<ServerWorld> {
  const lease = acquireWorld(map, onQueue);
  lease.promise.then(() => lease.release(), () => lease.release());
  return lease.promise;
}

async function availableMemoryBytes(): Promise<number> {
  let available = os.freemem();
  if (process.platform !== 'linux') return available;
  try {
    const membership = (await fs.promises.readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'));
    const relative = membership?.slice(3);
    if (!relative) return available;
    const dir = path.posix.join('/sys/fs/cgroup', relative);
    const [currentText, limitText, statText] = await Promise.all([
      fs.promises.readFile(path.posix.join(dir, 'memory.current'), 'utf8'),
      fs.promises.readFile(path.posix.join(dir, 'memory.max'), 'utf8'),
      fs.promises.readFile(path.posix.join(dir, 'memory.stat'), 'utf8').catch(() => ''),
    ]);
    const current = Number(currentText.trim()), limit = Number(limitText.trim());
    // memory.current 包含可回收的非活跃文件页缓存；不能把这部分当作永久占用。
    const inactiveFile = Number(/^inactive_file\s+(\d+)$/m.exec(statText)?.[1] ?? 0);
    if (Number.isFinite(current) && Number.isFinite(limit) && limit > 0)
      available = Math.min(available, Math.max(0, limit - current + Math.min(current, inactiveFile)));
  } catch { /* Non-cgroup Linux hosts use the OS free-memory estimate. */ }
  return available;
}

async function readWorldInWorker(map: MapId): Promise<ServerWorld> {
  const worker = new Worker(new URL('./world-worker.ts', import.meta.url), {
    workerData: { map, mode: 'read', shared: process.env.ROOM_WORKERS === '1' },
    execArgv: process.execArgv,
  });
  try {
    const response = await new Promise<{ ok: boolean; world?: ServerWorld; header?: CacheHeader; payloadStart?: number; buffer?: ArrayBuffer; error?: string }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`${map}: world-cache worker exited before reply (code=${code})`)));
    });
    if (response.ok && response.world) return response.world;
    if (!response.ok || !response.header || !response.buffer || response.payloadStart === undefined)
      throw new Error(response.error ?? `${map}: world-cache worker returned no payload`);
    return worldFromCache({ header: response.header, buffer: response.buffer, payloadStart: response.payloadStart });
  } finally {
    await worker.terminate();
  }
}

export type { ServerWorld } from './world-build.ts';
export { buildWorld } from './world-build.ts';

// —— 出生朝向 ——
// 出生时用碰撞几何测量前方净空，优先朝向开阔方向。
/** 候选方向：16 个等分方向（够用，且结果与遍历顺序无关、恒定） */
const YAW_CANDIDATES = 16;
/** 认为「正前方足够开阔」的净空（米）：达不到就不硬朝敌方，另选方向 */
export const CLEAR_ENOUGH = 4;
/** 硬要求：选定方向的正前方净空不得低于这个值（低于说明该出生点被墙围住，打日志） */
export const CLEAR_MIN = 3;
/** 净空射线的采样高度（脚底以上，米）：从膝盖到头顶，避开地面小起伏与地面自身 */
const CLEAR_HEIGHTS = [0.25, 0.5, 1.0, 1.5, 1.8];
/** 净空射线的最大长度（米）：这么远还没打到东西就算开阔 */
const CLEAR_MAX = 30;

/** 从 (x, y+h, z) 沿 yaw 水平打射线，返回正前方净空 = 各采样高度的最小值（上限 CLEAR_MAX） */
export function frontClearance(pawn: BVH, x: number, y: number, z: number, yaw: number): number {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  let clear = CLEAR_MAX;
  for (const h of CLEAR_HEIGHTS) {
    const hit = raycast(pawn, x, y + h, z, dx, 0, dz, CLEAR_MAX);
    if (hit && hit.t < clear) clear = hit.t;
  }
  return clear;
}

const angleDiff = (a: number, b: number) => {
  let d = a - b;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return d;
};

/** 已算过的出生朝向（地图 → 出生点 → 朝向）：射线只依赖世界数据，结果确定，按地图缓存 */
const spawnCache = new Map<MapId, Map<string, number>>();

/** 出生朝向：优先用「想要的朝向」preferYaw（数据里写的 yaw，没有就朝敌方出生区），
 *  只有它正前方不够开阔时才偏离：
 *  1) preferYaw 方向净空 ≥ CLEAR_ENOUGH → 直接用它；
 *  2) 否则在 16 个等分方向里选「净空 ≥ CLEAR_ENOUGH 且与 preferYaw 夹角最小」的（尽可能少偏离）；
 *  3) 一个都不达标（被墙围住）→ 取净空最大的方向兜底，并打日志。
 *  同一出生点每次得到同一朝向（射线确定、平局取序号小的）。 */
export function spawnYaw(w: ServerWorld, x: number, y: number, z: number, preferYaw: number): number {
  let byMap = spawnCache.get(w.map);
  if (!byMap) spawnCache.set(w.map, (byMap = new Map()));
  const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)},${preferYaw.toFixed(4)}`;
  const cached = byMap.get(key);
  if (cached !== undefined) return cached;

  let yaw = preferYaw;
  if (frontClearance(w.pawn, x, y, z, yaw) < CLEAR_ENOUGH) {
    let bestD = Infinity, openYaw = preferYaw, fallbackYaw = preferYaw, fallbackClear = -1;
    for (let k = 0; k < YAW_CANDIDATES; k++) {
      const cand = (k * 2 * Math.PI) / YAW_CANDIDATES;
      const clear = frontClearance(w.pawn, x, y, z, cand);
      if (clear > fallbackClear) { fallbackClear = clear; fallbackYaw = cand; }
      if (clear < CLEAR_ENOUGH) continue;
      const d = Math.abs(angleDiff(cand, preferYaw));
      if (d < bestD) { bestD = d; openYaw = cand; }
    }
    yaw = bestD === Infinity ? fallbackYaw : openYaw;
  }
  const clear = frontClearance(w.pawn, x, y, z, yaw);
  if (clear < CLEAR_MIN)
    console.warn(`[spawn] ${w.map} (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}): 正前方只有 ${clear.toFixed(2)} m 净空（不足 ${CLEAR_MIN} m）`);
  byMap.set(key, yaw);
  return yaw;
}
