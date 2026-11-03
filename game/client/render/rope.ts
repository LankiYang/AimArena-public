import * as THREE from 'three';
import { nearestRope, type RopeDef } from '../../shared/rope.ts';

export class RopeView {
  readonly root = new THREE.Group();
  private readonly materials: THREE.MeshLambertMaterial[] = [];
  constructor(private readonly defs: readonly RopeDef[]) {
    const up = new THREE.Vector3(0, 1, 0);
    for (const rope of defs) {
      const a = new THREE.Vector3(...rope.bottom);
      const end = rope.points?.[1] ?? rope.top;
      const b = new THREE.Vector3(...end);
      const material = new THREE.MeshLambertMaterial({ color: 0xcfc39a });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(.07, a.distanceTo(b), .07), material);
      mesh.position.copy(a).add(b).multiplyScalar(.5);
      mesh.quaternion.setFromUnitVectors(up, b.sub(a).normalize());
      this.materials.push(material); this.root.add(mesh);
    }
  }
  readonly count = (): number => this.defs.length;
  update(local: { x: number; y: number; z: number } | null, onRope: number): void {
    const near = local ? nearestRope(this.defs, local.x, local.y, local.z) : null;
    this.materials.forEach((mat, i) => mat.color.setHex(i === onRope ? 0x8fe3ff : near?.index === i ? 0xffe08a : 0xcfc39a));
  }
  hint(local: { x: number; y: number; z: number } | null, onRope: number): string | null {
    if (!local) return null;
    if (onRope >= 0) return '挂绳中 · 前进向上 / 后退向下';
    const near = nearestRope(this.defs, local.x, local.y, local.z, 1.6);
    if (!near) return null;
    return Math.abs(local.y - near.rope.bottom[1]) <= 1.2 ? '靠近绳索 · 按住前进自动攀爬' : '绳索附近 · 从边缘走下来可以抓住绳索';
  }
  dispose(): void {
    this.root.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose(); });
    for (const material of this.materials) material.dispose();
    this.root.removeFromParent();
  }
}
