// world-cache.ts — 服务端地图世界（碰撞汤 + BVH）的离线缓存格式
//
// 加载地图时的 GLB 解析、碰撞几何与 BVH 构建是 10 秒级的同步 CPU 工作，放进对局进程会卡住所有
// 房间的 tick。这里改为：发布前用 `node game/tools/world-cache-build.mjs` 单独构建并落盘；
// 线上只在 worker 里读文件、校验指纹，再把一整块 ArrayBuffer 转移给主线程（零拷贝）。
// 缓存缺失或指纹不匹配时明确失败，绝不在对局进程里现场重建。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MapId } from '../shared/catalog.ts';
import type { BVH } from '../shared/world/bvh.ts';
import { GAME_DIR, ROOT } from './paths.ts';
import type { ServerWorld } from './world-build.ts';

export const WORLD_CACHE_FORMAT = 2;
const CACHE_DIR = path.join(GAME_DIR, '.cache', 'worlds');
export const HEADER_MAGIC = 0x574d4941; // 'AIMW'
export const HEADER_SLOTS = 4; // magic + format + headerBytes + payloadStart
const ALIGN = 8;

export function worldCachePath(map: MapId): string {
  return path.join(CACHE_DIR, `${map}.v${WORLD_CACHE_FORMAT}.world`);
}

/** Hash all source inputs that determine authored world geometry and metadata. */
export async function worldCacheFingerprint(map: MapId): Promise<string> {
  const hash = createHash('sha256').update(`format=${WORLD_CACHE_FORMAT}\nmap=${map}\n`);
  for (const rel of [
    'game/server/world-build.ts',
    'game/server/world-cache.ts',
    'game/server/nav.ts',
    'game/server/mapdata.ts',
    'game/shared/public-map.ts',
    'game/shared/world/terrain.ts',
    'game/shared/world/bvh.ts',
  ]) {
    const data = await fs.promises.readFile(path.join(ROOT, rel));
    hash.update(rel).update('\0').update(data);
  }
  return hash.digest('hex');
}

interface CachedArray { key: string; type: 'f32' | 'f64' | 'i32' | 'u8'; length: number; offset: number }
export interface CacheHeader {
  format: number;
  map: MapId;
  fingerprint: string;
  payloadBytes: number;
  buildMs: number;
  projectileVolumeStart: number;
  arrays: CachedArray[];
  doc: unknown;
  ropes: unknown;
  climbRopes: unknown;
}
export interface CachePayload { header: CacheHeader; buffer: ArrayBuffer; payloadStart: number }

type TypedArray = Float32Array | Float64Array | Int32Array | Uint8Array;
const BYTES: Record<CachedArray['type'], number> = { f32: 4, f64: 8, i32: 4, u8: 1 };
const CTORS = { f32: Float32Array, f64: Float64Array, i32: Int32Array, u8: Uint8Array } as const;

/** 人物汤与子弹汤共享同一块三角形数组（见 world-build.ts 的 sharePawnTriangles），缓存里只存一份 `tris`。 */
const bvhArrays = (prefix: string, bvh: BVH): Array<[string, CachedArray['type'], TypedArray]> => [
  [`${prefix}.bounds`, 'f32', bvh.bounds.subarray(0, bvh.nodes * 6)],
  [`${prefix}.right`, 'i32', bvh.right.subarray(0, bvh.nodes)],
  [`${prefix}.start`, 'i32', bvh.start.subarray(0, bvh.nodes)],
  [`${prefix}.leafCount`, 'u8', bvh.leafCount.subarray(0, bvh.nodes)],
  [`${prefix}.order`, 'i32', bvh.order.subarray(0, bvh.count)],
];

/** 构建期编码：BVH 的定长数组按实际使用长度紧凑写出（构建时的容量是 2×，不裁剪会多占一倍内存）。 */
export function encodeWorldCache(world: ServerWorld, fingerprint: string): CachePayload {
  const arrays: Array<[string, CachedArray['type'], TypedArray]> = [
    ['tris', 'f32', world.projectile.tris.subarray(0, (world.projectile.tris.length / 9) * 9)],
    ...bvhArrays('pawn', world.pawn),
    ...bvhArrays('projectile', world.projectile),
    ...(world.codes ? [['codes', 'u8', world.codes] as [string, CachedArray['type'], TypedArray]] : []),
  ];
  let payloadBytes = 0;
  const entries: CachedArray[] = arrays.map(([key, type, data]) => {
    const length = data.length;
    const entry = { key, type, length, offset: payloadBytes };
    payloadBytes += length * BYTES[type];
    if (payloadBytes % ALIGN) payloadBytes += ALIGN - (payloadBytes % ALIGN);
    return entry;
  });
  const header: CacheHeader = {
    format: WORLD_CACHE_FORMAT,
    map: world.map,
    fingerprint,
    payloadBytes,
    buildMs: world.buildMs,
    projectileVolumeStart: world.projectileVolumeStart,
    arrays: entries,
    doc: world.doc,
    ropes: world.ropes,
    climbRopes: world.climbRopes,
  };
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headerStart = HEADER_SLOTS * 4 + 4;
  const start = Math.ceil((headerStart + headerJson.byteLength) / ALIGN) * ALIGN;
  const buffer = new ArrayBuffer(start + payloadBytes);
  const meta = new DataView(buffer, 0, start);
  meta.setUint32(0, HEADER_MAGIC, true);
  meta.setUint32(4, WORLD_CACHE_FORMAT, true);
  meta.setUint32(8, headerJson.byteLength, true);
  meta.setUint32(12, start, true);
  new Uint8Array(buffer).set(headerJson, headerStart);
  for (let i = 0; i < arrays.length; i++) {
    const [, , data] = arrays[i];
    new Uint8Array(buffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), start + entries[i].offset);
  }
  return { header, buffer, payloadStart: start };
}

/** 校验并返回整块文件缓冲；buffer 直接 transfer 到主线程，避免再复制一份同尺寸内存。 */
export function decodeWorldCache(raw: Buffer | ArrayBuffer, map: MapId, fingerprint: string): CachePayload {
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.byteLength < HEADER_SLOTS * 4 + 4) throw new Error(`${map}: 世界缓存文件过短`);
  const meta = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (meta.getUint32(0, true) !== HEADER_MAGIC) throw new Error(`${map}: 世界缓存魔数不匹配`);
  const format = meta.getUint32(4, true);
  const headerLength = meta.getUint32(8, true);
  const payloadStart = meta.getUint32(12, true);
  if (format !== WORLD_CACHE_FORMAT) throw new Error(`${map}: 世界缓存版本 ${format} 与当前 ${WORLD_CACHE_FORMAT} 不符`);
  if (payloadStart < HEADER_SLOTS * 4 + 4 + headerLength || payloadStart % ALIGN || payloadStart > bytes.byteLength) throw new Error(`${map}: 世界缓存头部越界`);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_SLOTS * 4 + 4, HEADER_SLOTS * 4 + 4 + headerLength))) as CacheHeader;
  if (header.map !== map || header.fingerprint !== fingerprint || !Array.isArray(header.arrays))
    throw new Error(`${map}: 世界缓存与当前地图素材或构建代码不匹配；请运行 node game/tools/world-cache-build.mjs --map=${map}`);
  if (payloadStart + header.payloadBytes !== bytes.byteLength) throw new Error(`${map}: 世界缓存长度与头部不符`);
  // 地图缓存远大于 Buffer 池，readFile 返回的就是独占 ArrayBuffer，可以直接转移（不复制）。
  const buffer = raw instanceof ArrayBuffer
    ? raw
    : raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
      ? raw.buffer as ArrayBuffer
      : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  return { header, buffer, payloadStart };
}

function view<T extends TypedArray>(header: CacheHeader, buffer: ArrayBuffer, payloadStart: number, key: string, ctor: { new (b: ArrayBuffer, o: number, l: number): T }): T {
  const entry = header.arrays.find(e => e.key === key);
  if (!entry) throw new Error(`${key}: 世界缓存缺少数组`);
  return new ctor(buffer, payloadStart + entry.offset, entry.length);
}

function bvhFrom(header: CacheHeader, buffer: ArrayBuffer, payloadStart: number, tris: Float32Array, prefix: string): BVH {
  const right = view(header, buffer, payloadStart, `${prefix}.right`, Int32Array);
  const order = view(header, buffer, payloadStart, `${prefix}.order`, Int32Array);
  const bvh: BVH = {
    tris,
    count: order.length,
    bounds: view(header, buffer, payloadStart, `${prefix}.bounds`, Float32Array),
    right,
    start: view(header, buffer, payloadStart, `${prefix}.start`, Int32Array),
    leafCount: view(header, buffer, payloadStart, `${prefix}.leafCount`, Uint8Array),
    order,
    nodes: right.length,
  };
  if (bvh.bounds.length < bvh.nodes * 6 || bvh.start.length < bvh.nodes || bvh.leafCount.length < bvh.nodes)
    throw new Error(`${prefix}: 世界缓存的 BVH 数组长度不足`);
  const triLimit = tris.length / 9;
  for (let i = 0; i < order.length; i++) if (order[i] < 0 || order[i] >= triLimit) throw new Error(`${prefix}: 世界缓存的三角形下标越界`);
  return bvh;
}

export function worldFromCache({ header, buffer, payloadStart }: CachePayload): ServerWorld {
  // 人物汤与子弹汤共享同一块三角形数组：两个 BVH 只是各自的节点树不同，缓存里也只有一份 `tris`。
  const tris = view(header, buffer, payloadStart, 'tris', Float32Array);
  const pawn = bvhFrom(header, buffer, payloadStart, tris, 'pawn');
  const projectile = bvhFrom(header, buffer, payloadStart, tris, 'projectile');
  const codes = header.arrays.some(e => e.key === 'codes') ? view(header, buffer, payloadStart, 'codes', Uint8Array) : null;
  return {
    map: header.map,
    doc: header.doc as ServerWorld['doc'],
    pawn,
    projectile,
    codes,
    projectileVolumeStart: header.projectileVolumeStart,
    ropes: header.ropes as ServerWorld['ropes'],
    climbRopes: header.climbRopes as ServerWorld['climbRopes'],
    buildMs: header.buildMs,
  };
}

export async function writeWorldCache(world: ServerWorld, fingerprint: string): Promise<number> {
  const { buffer } = encodeWorldCache(world, fingerprint);
  const file = worldCachePath(world.map);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, Buffer.from(buffer));
  await fs.promises.rename(tmp, file);
  return buffer.byteLength;
}

export function worldCacheSize(map: MapId): number {
  return fs.statSync(worldCachePath(map)).size;
}
