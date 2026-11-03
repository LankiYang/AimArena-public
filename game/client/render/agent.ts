import * as THREE from 'three';
import type { AgentId } from '../../shared/catalog.ts';
import type { WeaponId } from '../../shared/combat.ts';
import type { BVH } from '../../shared/world/bvh.ts';
import { radarEnemyVisible } from '../../shared/minimap.ts';
import { TeamMarker, TEAM_COLORS, type Allegiance } from './team-marker.ts';
import { makeWeapon, disposeProcedural } from './geometry.ts';

export const MODEL_YAW_OFFSET = 0;
const gatePoint = new THREE.Vector3();
export function inObserverView(world: BVH, camera: THREE.Camera, frustum: THREE.Frustum, x: number, y: number, z: number, crouch: number): boolean {
  gatePoint.set(x, y + 1.15 - .3 * crouch, z);
  return radarEnemyVisible(world, camera.position, gatePoint, frustum.containsPoint(gatePoint));
}
export interface MotionInput { vx: number; vz: number; yaw: number; crouch: number; grounded: boolean; onRope?: boolean; climb?: number }
export async function preloadAgents(_ids: AgentId[]): Promise<void> { /* Geometry is constructed locally. */ }

export class AgentModel {
  readonly root = new THREE.Group();
  readonly ready = Promise.resolve();
  private readonly body = new THREE.Group();
  private readonly leftLeg = new THREE.Group();
  private readonly rightLeg = new THREE.Group();
  private readonly rightArm = new THREE.Group();
  private readonly bodyMaterial: THREE.MeshLambertMaterial;
  private readonly skinMaterial = new THREE.MeshLambertMaterial({ color: 0xd8ad8e });
  private markerName = '';
  private readonly darkMaterial = new THREE.MeshLambertMaterial({ color: 0x303c48 });
  private marker: TeamMarker | null = null;
  private weapon: THREE.Group;
  private weaponId: WeaponId = 'vandal';
  private infected = false;
  private attack = 0;
  private time = 0;
  private disposed = false;
  constructor(_agent: AgentId, allegiance: Allegiance = 'neutral', name = '') {
    this.bodyMaterial = new THREE.MeshLambertMaterial({ color: TEAM_COLORS[allegiance] });
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z); parent.add(mesh);
    };
    this.root.add(this.body);
    box(this.body, .5, .62, .27, 0, 1.27, 0, this.bodyMaterial);
    box(this.body, .32, .34, .3, 0, 1.78, 0, this.skinMaterial);
    box(this.body, .34, .1, .32, 0, 1.98, 0, this.darkMaterial);
    for (const [leg, x] of [[this.leftLeg, -.14], [this.rightLeg, .14]] as const) {
      leg.position.set(x, .96, 0); this.body.add(leg);
      box(leg, .2, .86, .23, 0, -.43, 0, this.darkMaterial);
    }
    const leftArm = new THREE.Group(); leftArm.position.set(-.34, 1.52, 0); this.body.add(leftArm);
    box(leftArm, .16, .56, .19, 0, -.28, 0, this.bodyMaterial);
    this.rightArm.position.set(.34, 1.52, 0); this.body.add(this.rightArm);
    box(this.rightArm, .16, .48, .19, 0, -.24, 0, this.bodyMaterial);
    this.weapon = makeWeapon(this.weaponId);
    this.weapon.position.set(0, -.38, -.12); this.rightArm.add(this.weapon);
    this.setAllegiance(allegiance, name);
  }
  get allegiance(): Allegiance { return this.marker?.allegiance ?? 'neutral'; }
  setAllegiance(allegiance: Allegiance, name = ''): void {
    if (this.disposed || (this.allegiance === allegiance && this.markerName === name && this.root.userData.allegiance !== undefined)) return;
    this.markerName = name;
    this.marker?.dispose(); this.marker = allegiance === 'neutral' ? null : new TeamMarker(allegiance, name);
    if (this.marker) this.root.add(this.marker.root);
    this.root.userData.allegiance = allegiance;
    this.bodyMaterial.color.set(this.infected ? 0x718c5f : TEAM_COLORS[allegiance]);
  }
  setWeapon(id: WeaponId): void {
    if (this.disposed || id === this.weaponId) return;
    disposeProcedural(this.weapon); this.weaponId = id; this.weapon = makeWeapon(id);
    this.weapon.position.set(0, -.38, -.12); this.rightArm.add(this.weapon);
    this.weapon.visible = !this.infected;
  }
  setInfected(infected: boolean): void {
    if (this.disposed) return;
    this.infected = infected; this.weapon.visible = !infected;
    this.bodyMaterial.color.set(infected ? 0x718c5f : TEAM_COLORS[this.allegiance]);
    this.skinMaterial.color.set(infected ? 0x9cae80 : 0xd8ad8e);
  }
  infectedAttack(): void { if (this.infected) this.attack = .35; }
  getMuzzleWorld(out: THREE.Vector3): boolean {
    const muzzle = this.weapon.getObjectByName('held:muzzle');
    if (this.disposed || !this.root.visible || this.infected || this.weaponId === 'melee' || !muzzle) return false;
    muzzle.getWorldPosition(out); return true;
  }
  updateTeamMarker(camera: THREE.Camera, world: BVH, crouch: number): void { this.marker?.update(camera, world, crouch); }
  updateVisibility(world: BVH, camera: THREE.Camera, frustum: THREE.Frustum, crouch: number, alive: boolean, observer: boolean): boolean {
    const visible = alive && (this.allegiance !== 'enemy' || (observer && inObserverView(world, camera, frustum, this.root.position.x, this.root.position.y, this.root.position.z, crouch)));
    this.root.visible = visible; return visible;
  }
  update(m: MotionInput, dt: number): void {
    this.root.rotation.y = m.yaw + MODEL_YAW_OFFSET;
    this.time += Math.max(0, dt) * (m.onRope ? Math.abs(m.climb ?? 0) : Math.hypot(m.vx, m.vz));
    const swing = Math.sin(this.time * 5) * (m.grounded || m.onRope ? .5 : .1);
    this.leftLeg.rotation.x = swing; this.rightLeg.rotation.x = -swing;
    this.body.position.y = -.35 * Math.max(0, Math.min(1, m.crouch));
    this.attack = Math.max(0, this.attack - Math.max(0, dt));
    this.rightArm.rotation.x = this.infected ? -1 - (this.attack > 0 ? Math.sin((.35 - this.attack) / .35 * Math.PI) : 0) : -.6;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.marker?.dispose(); disposeProcedural(this.root);
  }
}
