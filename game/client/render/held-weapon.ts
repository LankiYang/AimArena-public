import * as THREE from 'three';
import type { WeaponId } from '../../shared/combat.ts';
import { makeWeapon } from './geometry.ts';
export interface HeldWeaponPart { readonly name: string; readonly geometry: THREE.BufferGeometry; readonly material: THREE.Material }
export function bindRotation(parents: readonly number[], bindQ: ArrayLike<number>, bone: number): THREE.Quaternion {
  const result = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  for (let i = bone; i >= 0; i = parents[i]) { q.set(bindQ[i * 4], bindQ[i * 4 + 1], bindQ[i * 4 + 2], bindQ[i * 4 + 3]); result.premultiply(q); }
  return result;
}
export class HeldWeaponAsset {
  constructor(readonly id: WeaponId, readonly parts: readonly HeldWeaponPart[], readonly textureUrls: readonly string[], readonly attachOffset: THREE.Vector3, private readonly modelQuat: THREE.Quaternion, readonly muzzle: THREE.Vector3, readonly hasMuzzle: boolean, readonly socketBone: 'R_WeaponPoint' | 'MasterWeapon' = 'MasterWeapon') {}
  socketQuaternion(boneBindRotation: THREE.Quaternion): THREE.Quaternion {
    return this.socketBone === 'R_WeaponPoint' ? this.modelQuat.clone() : this.modelQuat.clone().premultiply(boneBindRotation.clone().invert());
  }
}
const assets = new Map<WeaponId, HeldWeaponAsset>();
export async function loadHeldWeapon(id: WeaponId): Promise<HeldWeaponAsset> {
  let asset = assets.get(id);
  if (!asset) {
    const model = makeWeapon(id); const parts: HeldWeaponPart[] = [];
    model.updateMatrixWorld(true);
    model.traverse(node => {
      if (node instanceof THREE.Mesh) {
        const geometry = node.geometry.clone(); geometry.applyMatrix4(node.matrixWorld);
        parts.push({ name: `part${parts.length}`, geometry, material: node.material as THREE.Material });
        node.geometry.dispose();
      }
    });
    const muzzle = model.getObjectByName('held:muzzle')?.position.clone() ?? new THREE.Vector3();
    asset = new HeldWeaponAsset(id, parts, [], new THREE.Vector3(), new THREE.Quaternion(), muzzle, id !== 'melee', 'R_WeaponPoint'); assets.set(id, asset);
  }
  return asset;
}
export function instantiateHeldWeapon(asset: HeldWeaponAsset, boneBindRotation: THREE.Quaternion): THREE.Group {
  const root = new THREE.Group(); root.name = `held:${asset.id}`;
  root.position.copy(asset.attachOffset); root.quaternion.copy(asset.socketQuaternion(boneBindRotation));
  for (const part of asset.parts) { const mesh = new THREE.Mesh(part.geometry, part.material); mesh.name = `held:${asset.id}:${part.name}`; root.add(mesh); }
  if (asset.hasMuzzle) { const muzzle = new THREE.Object3D(); muzzle.name = 'held:muzzle'; muzzle.position.copy(asset.muzzle); root.add(muzzle); }
  return root;
}
export function releaseHeldWeapon(root: THREE.Group | null): void { if (root) { root.removeFromParent(); root.clear(); } }
