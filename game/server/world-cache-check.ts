// world-cache-check.ts — 地图世界缓存自检（启动前与部署后使用）
//
// 与 world-cache.ts 分开：格式模块参与缓存指纹，改它会强制重建全部地图；这里只读文件头做诊断，
// 可以自由调整而不让 1.7 GB 缓存失效。
import fs from 'node:fs';
import { MAPS, type MapId } from '../shared/catalog.ts';
import { HEADER_MAGIC, HEADER_SLOTS, worldCacheFingerprint, worldCachePath, worldCacheSize, type CacheHeader } from './world-cache.ts';

export interface WorldCacheStatus { map: MapId; state: 'ok' | 'missing' | 'stale'; bytes: number }

/** 只读文件头：地图缓存单张数百 MB，自检不应该为读一行 JSON 把整块读进内存。 */
async function readHeader(map: MapId): Promise<CacheHeader | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(worldCachePath(map), 'r');
    const head = Buffer.alloc(HEADER_SLOTS * 4 + 4);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (bytesRead !== head.length || head.readUInt32LE(0) !== HEADER_MAGIC) return null;
    const headerLength = head.readUInt32LE(8);
    if (headerLength > 16 * 1024 * 1024) return null;
    const json = Buffer.alloc(headerLength);
    const read = await fh.read(json, 0, headerLength, head.length);
    if (read.bytesRead !== headerLength) return null;
    return JSON.parse(json.toString('utf8')) as CacheHeader;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** 每张图的缓存是否存在，指纹是否仍与当前素材、几何源码、依赖一致。 */
export async function checkWorldCaches(): Promise<WorldCacheStatus[]> {
  // 串行：指纹要读并哈希六份 GLB，并发扫描会给正在跑对局的机器制造无谓的 I/O 峰值。
  const out: WorldCacheStatus[] = [];
  for (const { id } of MAPS) {
    let bytes = 0;
    try { bytes = worldCacheSize(id); } catch { out.push({ map: id, state: 'missing', bytes: 0 }); continue; }
    const header = await readHeader(id);
    if (!header) { out.push({ map: id, state: 'stale', bytes }); continue; }
    const fingerprint = await worldCacheFingerprint(id);
    out.push({ map: id, state: header.fingerprint === fingerprint ? 'ok' : 'stale', bytes });
  }
  return out;
}
