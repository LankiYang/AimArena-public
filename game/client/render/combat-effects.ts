import * as THREE from 'three';
import type { CombatEvent, V3 } from '../../shared/combat.ts';
export type ShotEvent = Extract<CombatEvent, { kind: 'shot' }>;
interface Effect { mesh: THREE.Mesh; life: number; duration: number; start?: THREE.Vector3; end?: THREE.Vector3; normal?: THREE.Vector3; presented: boolean }

/** Server-provided shot rays and impact normals drive all visuals. */
export class CombatEffects {
  readonly scene = new THREE.Scene();
  private readonly effects: Effect[] = [];
  private readonly lineGeo = new THREE.BoxGeometry(1, .015, .015);
  private readonly impactGeo = new THREE.BoxGeometry(.07, .07, .003);
  private readonly tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd598 });
  private readonly impactMat = new THREE.MeshBasicMaterial({ color: 0x26211f });
  private readonly sparkMat = new THREE.MeshBasicMaterial({ color: 0xffc26a });
  private readonly dir = new THREE.Vector3();
  private readonly start = new THREE.Vector3();
  private readonly axis = new THREE.Vector3(1, 0, 0);
  private readonly normalAxis = new THREE.Vector3(0, 0, 1);
  private tracerRenders = 0;
  private impactRenders = 0;
  private burstRenders = 0;
  constructor(private readonly renderer: THREE.WebGLRenderer) {}
  shot(event: ShotEvent, muzzle?: V3): void {
    if (event.weapon === 'melee') return;
    for (const ray of event.rays) {
      this.dir.set(ray.end.x - event.origin.x, ray.end.y - event.origin.y, ray.end.z - event.origin.z);
      const distance = this.dir.length();
      if (distance > .05) {
        this.dir.multiplyScalar(1 / distance);
        this.start.set(muzzle?.x ?? event.origin.x, muzzle?.y ?? event.origin.y, muzzle?.z ?? event.origin.z);
        if (!muzzle) this.start.addScaledVector(this.dir, Math.min(.35, distance));
        const along = this.dir.dot(this.start.clone().sub(new THREE.Vector3(event.origin.x, event.origin.y, event.origin.z)));
        this.start.addScaledVector(this.dir, Math.max(0, Math.min(distance, along)) - along);
        const end = new THREE.Vector3(ray.end.x, ray.end.y, ray.end.z);
        const segment = end.clone().sub(this.start); const length = segment.length();
        if (length > .05) {
          const mesh = new THREE.Mesh(this.lineGeo, this.tracerMat);
          const direction = segment.normalize();
          const firstLength = Math.min(2, length);
          mesh.position.copy(this.start).addScaledVector(direction, firstLength / 2); mesh.quaternion.setFromUnitVectors(this.axis, direction); mesh.scale.x = firstLength;
          const duration = Math.min(.125, Math.max(.08, length / 800)) + .04;
          this.scene.add(mesh); this.effects.push({ mesh, life: duration, duration, start: this.start.clone(), end, presented: false });
        }
      }
      for (const impact of ray.impacts) {
        const n = new THREE.Vector3(impact.normal.x, impact.normal.y, impact.normal.z);
        if (n.lengthSq() < 1e-8) continue; n.normalize();
        const mesh = new THREE.Mesh(this.impactGeo, this.impactMat);
        mesh.position.set(impact.position.x, impact.position.y, impact.position.z); mesh.position.addScaledVector(n, .003);
        mesh.quaternion.setFromUnitVectors(this.normalAxis, n); this.scene.add(mesh);
        this.effects.push({ mesh, life: 8, duration: 8, normal: n, presented: false });
        const spark = new THREE.Mesh(this.impactGeo, this.sparkMat); spark.position.copy(mesh.position).addScaledVector(n, .005); spark.quaternion.copy(mesh.quaternion); spark.scale.setScalar(1.7); this.scene.add(spark);
        this.effects.push({ mesh: spark, life: .12, duration: .12, presented: false });
      }
    }
  }
  update(dt: number): void {
    const d = Math.max(0, Number.isFinite(dt) ? dt : 0);
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]; if (effect.presented) effect.life -= d;
      if (effect.life <= 0) { effect.mesh.removeFromParent(); this.effects.splice(i, 1); continue; }
      if (effect.start && effect.end) {
        this.dir.copy(effect.end).sub(effect.start);
        const distance = this.dir.length(); this.dir.multiplyScalar(1 / distance);
        const head = Math.min(distance, 2 + (effect.duration - effect.life) * 800);
        const tail = Math.max(0, head - 3);
        effect.mesh.position.copy(effect.start).addScaledVector(this.dir, (head + tail) / 2);
        effect.mesh.scale.x = head - tail;
      }
    }
  }
  render(camera: THREE.Camera): void {
    if (!this.effects.length) return;
    const autoClear = this.renderer.autoClear; this.renderer.autoClear = false; this.renderer.render(this.scene, camera); this.renderer.autoClear = autoClear;
    for (const effect of this.effects) {
      effect.presented = true;
      if (effect.start) this.tracerRenders++; else if (effect.normal) this.impactRenders++; else this.burstRenders++;
    }
  }
  stats() {
    const tracers = this.effects.filter(effect => effect.start);
    const impacts = this.effects.filter(effect => effect.normal);
    return { tracers: tracers.length, impacts: impacts.length, bursts: this.effects.length - tracers.length - impacts.length, tracerRenders: this.tracerRenders, impactRenders: this.impactRenders, burstRenders: this.burstRenders, entries: impacts.map(effect => ({ position: { x: effect.mesh.position.x, y: effect.mesh.position.y, z: effect.mesh.position.z }, normal: { x: effect.normal!.x, y: effect.normal!.y, z: effect.normal!.z } })), starts: tracers.map(effect => ({ x: effect.start!.x, y: effect.start!.y, z: effect.start!.z })), endpoints: tracers.map(effect => ({ x: effect.end!.x, y: effect.end!.y, z: effect.end!.z })), texturesReady: true };
  }
  dispose(): void { this.effects.length = 0; this.scene.clear(); this.lineGeo.dispose(); this.impactGeo.dispose(); this.tracerMat.dispose(); this.impactMat.dispose(); this.sparkMat.dispose(); }
}
