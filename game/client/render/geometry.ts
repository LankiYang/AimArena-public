import * as THREE from 'three';
import type { WeaponId } from '../../shared/combat.ts';

/** Procedural, untextured weapon model. Its forward direction is -Z. */
export function makeWeapon(id: WeaponId): THREE.Group {
  const root = new THREE.Group();
  const metal = id === 'melee' ? null : new THREE.MeshLambertMaterial({ color: 0x333e48 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1b232b });
  const accent = new THREE.MeshLambertMaterial({ color: 0x81909a });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z); root.add(mesh);
  };
  if (id === 'melee') {
    box(.06, .07, .28, 0, 0, -.12, dark);
    box(.13, .04, .04, 0, 0, -.28, accent);
    box(.09, .025, .4, 0, 0, -.49, accent);
  } else {
    const pistol = ['classic', 'shorty', 'frenzy', 'ghost', 'sheriff'].includes(id);
    const len = pistol ? .34 : .65;
    box(.12, .15, len, 0, 0, -len / 2, metal!);
    box(.07, .07, .22, 0, .01, -len - .09, dark);
    box(.08, .22, .1, 0, -.16, -.15, dark);
    if (!pistol) {
      box(.08, .18, .12, 0, -.13, -.35, dark);
      box(.1, .13, .22, 0, -.04, .08, metal!);
    }
    box(.035, .045, .08, 0, .095, -.24, accent);
  }
  const muzzle = new THREE.Object3D(); muzzle.name = 'held:muzzle';
  muzzle.position.z = id === 'melee' ? -.7 : (['classic', 'shorty', 'frenzy', 'ghost', 'sheriff'].includes(id) ? -.55 : -.86);
  root.add(muzzle);
  return root;
}

export function disposeProcedural(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse(node => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
    }
  });
  for (const material of materials) material.dispose();
  root.removeFromParent();
}
