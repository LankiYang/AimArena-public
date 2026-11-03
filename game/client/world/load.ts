import * as THREE from 'three';
import type { MapId } from '../../shared/catalog.ts';
import { createPublicMap } from '../../shared/public-map.ts';
import { buildBVH, type BVH } from '../../shared/world/bvh.ts';
import { buildTerrain, type CollisionDoc } from '../../shared/world/terrain.ts';
import { buildMapRender, type MapRender } from '../render/map.ts';

export interface LoadedMap {
  id: MapId;
  render: MapRender;
  bvh: BVH;
  doc: CollisionDoc;
}

const mapCache = new Map<MapId, Promise<LoadedMap>>();

export async function loadMap(id: MapId, _renderer: THREE.WebGLRenderer, onProgress: (p: number, text: string) => void): Promise<LoadedMap> {
  let pending = mapCache.get(id);
  if (!pending) {
    pending = (async () => {
      onProgress(0.1, '生成地图…');
      const { scene, doc } = createPublicMap(id);
      scene.updateMatrixWorld(true);
      onProgress(0.35, '构建碰撞…');
      const terrain = buildTerrain(scene, doc, null, null, { projectile: false });
      const bvh = buildBVH(terrain.pawnTris);
      onProgress(0.7, '构建场景…');
      const render = await buildMapRender({ name: id, src: scene });
      return { id, render, bvh, doc };
    })();
    mapCache.set(id, pending);
    pending.catch(() => {
      if (mapCache.get(id) === pending) mapCache.delete(id);
    });
  }
  const loaded = await pending;
  loaded.render.reset();
  onProgress(1, '地图已就绪');
  return loaded;
}

export function clearMapCache() {
  mapCache.clear();
}
