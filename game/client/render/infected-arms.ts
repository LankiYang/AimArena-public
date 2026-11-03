import * as THREE from 'three';
import { disposeProcedural } from './geometry.ts';

/** First-person infected hands made from simple blocks. */
export class InfectedArms {
  private readonly root = new THREE.Group();
  private time = 0;
  private attack = 0;
  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshLambertMaterial({ color: 0x738f65 });
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(.15, .17, .52), mat);
      arm.position.set(side * .28, -.25, -.48); arm.rotation.z = side * -.2;
      this.root.add(arm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(.16, .1, .2), mat);
      hand.position.set(side * .23, -.2, -.8); this.root.add(hand);
    }
    this.root.visible = false; scene.add(this.root);
  }
  setVisible(visible: boolean): void { this.root.visible = visible; }
  fire(): void { if (this.root.visible) this.attack = .32; }
  update(dt: number): void {
    this.time += Math.max(0, dt); this.attack = Math.max(0, this.attack - Math.max(0, dt));
    this.root.position.y = Math.sin(this.time * 2) * .01;
    this.root.position.z = -Math.sin((.32 - this.attack) / .32 * Math.PI) * (this.attack > 0 ? .22 : 0);
  }
  dispose(): void { disposeProcedural(this.root); }
}
