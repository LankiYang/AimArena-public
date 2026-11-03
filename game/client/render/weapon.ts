import * as THREE from 'three';
import type { AgentId } from '../../shared/catalog.ts';
import type { WeaponId } from '../../shared/combat.ts';
import { isWeaponId } from '../../shared/sim/weapons.ts';
import { InfectedArms } from './infected-arms.ts';
import { makeWeapon, disposeProcedural } from './geometry.ts';
export type { WeaponId };
export const ADS_SIGHT_VIEWBOX = '-2 -2 4 4';
export const ADS_SIGHT_POLYGONS = ['-0.12,-1.4 0.12,-1.4 0.12,-0.4 -0.12,-0.4', '-0.12,0.4 0.12,0.4 0.12,1.4 -0.12,1.4', '-1.4,-0.12 -0.4,-0.12 -0.4,0.12 -1.4,0.12', '0.4,-0.12 1.4,-0.12 1.4,0.12 0.4,0.12'];
export function adsSightWidthPercent(weapon: WeaponId, zoom: number): number { return weapon === 'melee' ? 0 : 2 * zoom; }
export interface WeaponViewState { agent: AgentId; weapon: WeaponId; alive: boolean; moving: number; walking?: boolean; hidden?: boolean; adsProgress: number; zoom: number; reloadElapsed: number | null; equipElapsed: number | null; reloadProgress: number; infected?: boolean }

export class WeaponView {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, .01, 20);
  private readonly holder = new THREE.Group();
  private readonly infectedArms: InfectedArms;
  private readonly size = new THREE.Vector2();
  private readonly ndc = new THREE.Vector3();
  private readonly flash: THREE.Mesh;
  private readonly arms = new THREE.Group();
  private active: THREE.Group;
  private weapon: WeaponId = 'vandal';
  private agent: AgentId;
  private state: WeaponViewState | null = null;
  private inspectTime = 0;
  private flashTime = 0;
  private flashPending = false;
  private flashRenders = 0;
  private motionTime = 0;
  private disposed = false;
  private constructor(private readonly renderer: THREE.WebGLRenderer, agent: AgentId) {
    this.agent = agent;
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const light = new THREE.DirectionalLight(0xffffff, 1.2); light.position.set(1, 2, 1); this.scene.add(light);
    this.scene.add(this.holder);
    this.active = makeWeapon(this.weapon); this.holder.add(this.active);
    const sleeve = new THREE.MeshLambertMaterial({ color: 0x526778 });
    const skin = new THREE.MeshLambertMaterial({ color: 0xc99777 });
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(.12, .14, .5), sleeve);
      arm.position.set(side * .16, -.18, .12); this.arms.add(arm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(.13, .12, .15), skin);
      hand.position.set(side * .1, -.11, -.14); this.arms.add(hand);
    }
    this.holder.add(this.arms);
    this.flash = new THREE.Mesh(new THREE.BoxGeometry(.12, .12, .18), new THREE.MeshBasicMaterial({ color: 0xffd16a }));
    this.flash.visible = false; this.holder.add(this.flash);
    this.infectedArms = new InfectedArms(this.scene);
  }
  static async create(renderer: THREE.WebGLRenderer, agent: AgentId): Promise<WeaponView> { return new WeaponView(renderer, agent); }
  async prepare(id: WeaponId): Promise<void> { if (this.disposed || !isWeaponId(id)) throw new Error('WeaponView unavailable'); }
  ready(id: WeaponId): boolean { return !this.disposed && isWeaponId(id); }
  setWeapon(id: WeaponId): void {
    if (this.disposed || !isWeaponId(id) || id === this.weapon) return;
    disposeProcedural(this.active); this.weapon = id; this.active = makeWeapon(id); this.holder.add(this.active);
    this.flashPending = false; this.flashTime = 0; this.inspectTime = 0;
  }
  fire(_heavy = false, _authorityAt?: number): void {
    if (this.disposed) return;
    if (this.state?.infected) this.infectedArms.fire();
    else { this.flashTime = .18; this.flashPending = this.weapon !== 'melee'; }
  }
  inspect(): void { if (this.weapon === 'melee' && this.state?.alive) this.inspectTime = 1; }
  update(dt: number, state: WeaponViewState): void {
    if (this.disposed) return;
    this.state = state; this.agent = state.agent; this.setWeapon(state.weapon);
    const d = Math.max(0, Number.isFinite(dt) ? dt : 0);
    this.motionTime += d * Math.max(.3, state.moving);
    if (!this.flashPending) this.flashTime = Math.max(0, this.flashTime - d);
    this.inspectTime = Math.max(0, this.inspectTime - d);
    const infected = !!state.infected;
    this.infectedArms.setVisible(infected && state.alive && !state.hidden); this.infectedArms.update(d);
    this.holder.visible = !infected && state.alive && !state.hidden;
    if (!this.holder.visible) { this.flashPending = false; this.flashTime = 0; }
    const ads = Math.max(0, Math.min(1, state.adsProgress));
    this.holder.position.set(.23 * (1 - ads), -.2 + Math.sin(this.motionTime * 6) * .012 * state.moving, -.55);
    this.holder.rotation.x = (this.flashTime > 0 ? (this.weapon === 'melee' ? -.5 * Math.sin((.18 - this.flashTime) / .18 * Math.PI) : .05) : 0) + (state.reloadElapsed !== null ? Math.sin(state.reloadProgress * Math.PI) * .35 : 0);
    this.holder.rotation.z = Math.sin(this.inspectTime * Math.PI) * .55;
    const muzzle = this.active.getObjectByName('held:muzzle');
    if (muzzle) this.flash.position.copy(muzzle.position);
    this.flash.visible = this.holder.visible && state.weapon !== 'melee' && this.flashTime > 0;
  }
  render(): void {
    if (this.disposed) return;
    this.renderer.getSize(this.size);
    const aspect = this.size.x / Math.max(1, this.size.y);
    this.camera.aspect = aspect;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(70) / 2) / aspect / (this.state?.zoom || 1)));
    this.camera.updateProjectionMatrix();
    const autoClear = this.renderer.autoClear; this.renderer.autoClear = false;
    this.renderer.clearDepth(); this.renderer.render(this.scene, this.camera); this.renderer.autoClear = autoClear;
    if (this.flash.visible) { this.flashRenders++; this.flashPending = false; }
  }
  getMuzzleWorld(camera: THREE.PerspectiveCamera, out: THREE.Vector3): boolean {
    if (this.disposed || !this.state?.alive || this.state.infected || this.weapon === 'melee') return false;
    const muzzle = this.active.getObjectByName('held:muzzle'); if (!muzzle) return false;
    this.scene.updateMatrixWorld(true); this.camera.updateMatrixWorld(true);
    muzzle.getWorldPosition(this.ndc).project(this.camera);
    out.set(this.ndc.x, this.ndc.y, .5).unproject(camera);
    out.sub(camera.position).normalize().multiplyScalar(.6).add(camera.position);
    return true;
  }
  stats() {
    return { flashVisible: this.flash.visible, flashRenders: this.flashRenders, flashMapped: false, muzzleNdc: null, texturesReady: true, weapon: this.weapon, agent: this.agent, armsReady: true, armsTexture: null, reloadSample: this.state?.reloadProgress ?? 0, equipElapsed: this.state?.equipElapsed ?? null, equipDuration: 0, adsProgress: this.state?.adsProgress ?? 0, zoom: this.state?.zoom ?? 1, verticalFov: this.camera.fov, ready: this.ready(this.weapon), assetManifest: '', attackManifest: null, attachBone: null, melee: null };
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.infectedArms.dispose(); disposeProcedural(this.holder); this.scene.clear();
  }
}
