// physics-worker.ts — 在 Worker 里把渲染场景抽出的美术三角形汤加工成人物碰撞汤 + BVH（几秒的 CPU 活，不卡界面）
//   输入：walk/cable 汤（主线程从 glb 场景抽出，transfer 过来）、collision.json、surfaces.json
//   输出：BVH 各数组（transfer 回主线程）
import { buildBVH } from '../../shared/world/bvh.ts';
import { artAugment, buildSurfaceCodes, concat, expandSet, type CollisionDoc, type SurfacesDoc } from '../../shared/world/terrain.ts';

export interface PhysicsJob {
  walk: Float32Array;
  cable: Float32Array | null;
  doc: CollisionDoc;
  surf: SurfacesDoc | null;
}

self.onmessage = (ev: MessageEvent<PhysicsJob>) => {
  const t0 = performance.now();
  const { walk, cable, doc, surf } = ev.data;
  let codes: Uint8Array | null = null;
  if (surf) {
    try {
      codes = buildSurfaceCodes(surf, doc, walk.length / 9, cable ? cable.length / 9 : 0);
    } catch {
      codes = null;
    }
  }
  const walkSet = (doc.walkSets ?? ['pawn', 'greybox']).map((s) => expandSet(doc, s)).reduce(concat);
  const pawn = concat(walkSet, artAugment(walkSet, walk, codes));
  const bvh = buildBVH(pawn);
  const msg = { ...bvh, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(msg, [bvh.tris.buffer, bvh.bounds.buffer, bvh.right.buffer, bvh.start.buffer, bvh.leafCount.buffer, bvh.order.buffer]);
};
