import fs from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import type { MapId } from '../shared/catalog.ts';
import { buildWorld } from './world-build.ts';
import { decodeWorldCache, worldCacheFingerprint, worldCachePath, worldFromCache, writeWorldCache } from './world-cache.ts';

interface Request { map: MapId; mode: 'read' | 'build'; shared?: boolean }
const request = workerData as Request;
if (!parentPort) throw new Error('world worker requires a parent port');

try {
  const fingerprint = await worldCacheFingerprint(request.map);
  if (request.mode === 'build') {
    const world = await buildWorld(request.map);
    const bytes = await writeWorldCache(world, fingerprint);
    parentPort.postMessage({
      ok: true, bytes, buildMs: world.buildMs,
      pawnTriangles: world.pawn.count, projectileTriangles: world.projectile.count,
    });
  } else {
    const raw = await fs.readFile(worldCachePath(request.map));
    const payload = decodeWorldCache(raw, request.map, fingerprint);
    if (request.shared) {
      // 一次加载只生成一份只读 SAB；房间线程收取视图，不各自复制整张地图。
      // 复制及 BVH 校验留在加载线程，避免阻塞正在联机的主线程。
      const buffer = new SharedArrayBuffer(payload.buffer.byteLength);
      new Uint8Array(buffer).set(new Uint8Array(payload.buffer));
      const world = worldFromCache(payload);
      const tris = new Float32Array(buffer, world.projectile.tris.byteOffset, world.projectile.tris.length);
      for (const bvh of [world.pawn, world.projectile]) {
        bvh.tris = tris;
        bvh.bounds = new Float32Array(buffer, bvh.bounds.byteOffset, bvh.bounds.length);
        bvh.right = new Int32Array(buffer, bvh.right.byteOffset, bvh.right.length);
        bvh.start = new Int32Array(buffer, bvh.start.byteOffset, bvh.start.length);
        bvh.leafCount = new Uint8Array(buffer, bvh.leafCount.byteOffset, bvh.leafCount.length);
        bvh.order = new Int32Array(buffer, bvh.order.byteOffset, bvh.order.length);
      }
      if (world.codes) world.codes = new Uint8Array(buffer, world.codes.byteOffset, world.codes.length);
      parentPort.postMessage({ ok: true, world });
    } else {
      // 单线程模式沿用 transfer：不复制整份地图数据。
      parentPort.postMessage({ ok: true, header: payload.header, payloadStart: payload.payloadStart, buffer: payload.buffer }, [payload.buffer]);
    }
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
