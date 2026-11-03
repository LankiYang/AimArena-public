import * as THREE from 'three';
import type { AgentId } from '../../shared/catalog.ts';
export interface AgentBin { verts: number; tris: number; bin: string; albedo: string; ao: string; layout: number[] }
interface AgentAsset { geometry: THREE.BufferGeometry; material: THREE.Material; boneInverses: Float32Array }
const assets = new Map<AgentId, AgentAsset>();
/** Procedural replacement for the old external character asset. */
export async function loadAgentAsset(id: AgentId, doc: { agents: Record<string, AgentBin>; bones: string[] }): Promise<AgentAsset> {
  let asset = assets.get(id);
  if (!asset) {
    const geometry = new THREE.BoxGeometry(.5, 1, .3);
    const count = geometry.getAttribute('position').count;
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) weights[i * 4] = 1;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const material = new THREE.MeshLambertMaterial({ color: 0x73899a });
    const boneInverses = new Float32Array(doc.bones.length * 16);
    for (let i = 0; i < doc.bones.length; i++) for (let k = 0; k < 4; k++) boneInverses[i * 16 + k * 5] = 1;
    asset = { geometry, material, boneInverses }; assets.set(id, asset);
  }
  return asset;
}
