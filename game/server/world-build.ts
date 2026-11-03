import type { MapId } from '../shared/catalog.ts';
import { createPublicMap } from '../shared/public-map.ts';
import { buildBVH, type BVH } from '../shared/world/bvh.ts';
import { buildTerrain, type CollisionDoc, type RopesDoc } from '../shared/world/terrain.ts';
import type { RopeDef } from '../shared/rope.ts';

export interface ServerWorld {
  map: MapId;
  doc: CollisionDoc;
  pawn: BVH;
  projectile: BVH;
  codes: Uint8Array | null;
  projectileVolumeStart: number;
  ropes: RopesDoc | null;
  climbRopes: RopeDef[];
  buildMs: number;
}

/** Build authoritative collision from the same authored geometry rendered by the client. */
export async function buildWorld(map: MapId): Promise<ServerWorld> {
  const started = performance.now();
  const { scene, doc } = createPublicMap(map);
  const terrain = buildTerrain(scene, doc, null, null);
  const pawn = buildBVH(terrain.pawnTris);
  const projectile = buildBVH(terrain.projectileTris!);
  // The cache stores a single triangle array; append and remap the pawn indices.
  const projectileCount = projectile.count;
  const triangles = new Float32Array(projectile.tris.length + pawn.tris.length);
  triangles.set(projectile.tris);
  triangles.set(pawn.tris, projectile.tris.length);
  for (let i = 0; i < pawn.order.length; i++) pawn.order[i] += projectileCount;
  pawn.tris = triangles;
  projectile.tris = triangles;
  return { map, doc, pawn, projectile, codes: terrain.codes,
    projectileVolumeStart: terrain.projectileVolumeStart, ropes: null, climbRopes: [],
    buildMs: performance.now() - started };
}
