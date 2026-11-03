import * as THREE from 'three';

export interface LmInst { a: number; cs: [number, number]; cb: [number, number] }
export interface LightmapsDoc { map: string; K: number; shRange: number; atlases: Record<string, { w: number; h: number; avif: { irr: string; sh: string } }>; inst: Record<string, LmInst> }
export interface PvsDoc { map: string; cell: number; layer: number; eyeOffset?: number; batches: string[]; cells: Record<string, string> }
export const LM_SHARED = { lmScale: { value: 1 }, lmUseSH: { value: 1 }, lmPerm: { value: new THREE.Matrix3().set(0, 1, 0, 0, 0, 1, 1, 0, 0) } };
/** Optional shader hooks for callers that supply their own locally generated lightmaps. */
export function patchVertex(src: string, instanced: boolean): string {
  const declarations = `#ifndef USE_UV1\nattribute vec2 uv1;\n#endif\n${instanced ? 'attribute vec4 lmXform;\n' : ''}varying vec2 vPublicLightUv;\n`;
  return declarations + src.replace('#include <begin_vertex>', `vPublicLightUv = ${instanced ? 'uv1 * lmXform.xy + lmXform.zw' : 'uv1'};\n#include <begin_vertex>`);
}
export function patchFragment(src: string): string {
  const declarations = 'uniform sampler2D lmIrr;\nuniform float lmK;\nuniform float lmScale;\nvarying vec2 vPublicLightUv;\n';
  return declarations + src.replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= texture2D(lmIrr, vPublicLightUv).rgb * lmK * lmScale;');
}
export interface MapRender {
  root: THREE.Group;
  update(camera: THREE.Camera, opts?: { disablePvs?: boolean }): void;
  reset(): void;
  stats: Record<string, unknown>;
  batches: { object: THREE.Mesh; bit: number; key: string }[];
  lightmapUniforms: typeof LM_SHARED;
}
/** The caller supplies the locally generated scene in world coordinates. */
export async function buildMapRender(opts: { name: string; src: THREE.Object3D; lmj?: LightmapsDoc; pvs?: PvsDoc | null; assetBase?: string; useLightmaps?: boolean }): Promise<MapRender> {
  const root = new THREE.Group();
  root.name = `map:${opts.name}`;
  root.add(opts.src);
  const batches: MapRender['batches'] = [];
  opts.src.traverse(object => {
    if (object instanceof THREE.Mesh) batches.push({ object, bit: -1, key: object.name });
  });
  const stats: Record<string, unknown> = { name: opts.name, batches: batches.length, visible: batches.length, pvsBits: 0, pvsMatched: 0, pvsOk: false };
  return {
    root, batches, lightmapUniforms: LM_SHARED, stats,
    update() { let visible = 0; for (const batch of batches) if (batch.object.visible) visible++; stats.visible = visible; },
    reset() { for (const batch of batches) batch.object.visible = true; stats.visible = batches.length; },
  };
}
