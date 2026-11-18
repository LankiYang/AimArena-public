import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AgentId } from '../../shared/catalog.ts';
import type { WeaponId } from '../../shared/combat.ts';
import { isWeaponId, WEAPONS, WEAPON_GROUPS } from '../../shared/sim/weapons.ts';
import { InfectedArms } from './infected-arms.ts';
import { makeWeapon, disposeProcedural } from './geometry.ts';
export type { WeaponId };
export const ADS_SIGHT_VIEWBOX = '-2 -2 4 4';
export const ADS_SIGHT_POLYGONS = ['-0.12,-1.4 0.12,-1.4 0.12,-0.4 -0.12,-0.4', '-0.12,0.4 0.12,0.4 0.12,1.4 -0.12,1.4', '-1.4,-0.12 -0.4,-0.12 -0.4,0.12 -1.4,0.12', '0.4,-0.12 1.4,-0.12 1.4,0.12 0.4,0.12'];
export function adsSightWidthPercent(weapon: WeaponId, zoom: number): number { return weapon === 'melee' ? 0 : 2 * zoom; }
export interface WeaponViewState { agent: AgentId; weapon: WeaponId; alive: boolean; moving: number; walking?: boolean; hidden?: boolean; adsProgress: number; zoom: number; reloadElapsed: number | null; equipElapsed: number | null; reloadProgress: number; infected?: boolean }

type RifleAnimation = 'idle' | 'walk' | 'run' | 'draw' | 'shot' | 'reload';
type BaseAnimation = 'idle' | 'walk' | 'run';
const RIFLE_ANIMATIONS: Record<RifleAnimation, RegExp> = {
  idle: /AK_Idle$/,
  walk: /AK_Walk$/,
  run: /AK_Run$/,
  draw: /AK_Draw$/,
  shot: /AK_Shot$/,
  reload: /AK_Reload$/,
};
const RIFLE_WEAPONS = new Set(WEAPON_GROUPS.find(group => group.name === '步枪')?.weapons ?? []);
const AK_VIEW_MOUNT = new THREE.Matrix4().set(
  -.324686, .00283114, -.0140075, .025,
  .00199273, .324416, .0193792, -.170168,
  .0141512, .0192746, -.324119, -.003,
  0, 0, 0, 1,
);
const isRifle = (weapon: WeaponId): boolean => RIFLE_WEAPONS.has(weapon);

function disposeViewModel(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  root.removeFromParent();
}

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
  private procedural: THREE.Group | null;
  private rifle: THREE.Group | null = null;
  private rifleModel: THREE.Object3D | null = null;
  private rifleMixer: THREE.AnimationMixer | null = null;
  private readonly rifleActions = new Map<RifleAnimation, THREE.AnimationAction>();
  private currentBase: THREE.AnimationAction | null = null;
  private oneShot: THREE.AnimationAction | null = null;
  private lastReloading = false;
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
    this.procedural = makeWeapon(this.weapon);
    this.active = this.procedural;
    this.holder.add(this.active);
    const sleeve = new THREE.MeshLambertMaterial({ color: 0x526778 });
    const skin = new THREE.MeshLambertMaterial({ color: 0xc99777 });
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(.12, .14, .5), sleeve);
      arm.position.set(side * .16, -.18, .12); this.arms.add(arm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(.13, .12, .15), skin);
      hand.position.set(side * .1, -.11, -.14); this.arms.add(hand);
    }
    this.holder.add(this.arms);
    this.flash = new THREE.Mesh(new THREE.BoxGeometry(.07, .07, .14), new THREE.MeshBasicMaterial({ color: 0xffd16a }));
    this.flash.renderOrder = 9;
    this.flash.visible = false; this.holder.add(this.flash);
    this.infectedArms = new InfectedArms(this.scene);
  }
  static async create(renderer: THREE.WebGLRenderer, agent: AgentId): Promise<WeaponView> {
    const view = new WeaponView(renderer, agent);
    try {
      const asset = await new GLTFLoader().loadAsync('/data/animations/fps-ak74m/scene.gltf');
      view.installRifle(asset.scene, asset.animations);
      return view;
    } catch (error) {
      view.dispose();
      throw error;
    }
  }
  private installRifle(model: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    const rig = new THREE.Group();
    model.applyMatrix4(AK_VIEW_MOUNT);
    model.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.renderOrder = 8;
        object.frustumCulled = false;
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });
    rig.add(model);
    this.rifle = rig;
    this.rifleModel = model;
    this.rifleMixer = new THREE.AnimationMixer(model);
    this.holder.add(rig);
    const muzzleBone = model.getObjectByName('Rif_end_079');
    if (!muzzleBone) throw new Error('AK-74M model is missing the muzzle marker bone');
    const muzzle = new THREE.Object3D();
    muzzle.name = 'held:muzzle';
    muzzleBone.add(muzzle);
    for (const [name, pattern] of Object.entries(RIFLE_ANIMATIONS) as [RifleAnimation, RegExp][]) {
      const clip = clips.find(animation => pattern.test(animation.name));
      if (!clip) throw new Error(`AK-74M animation is missing: ${name}`);
      this.rifleActions.set(name, this.rifleMixer.clipAction(clip));
    }
    if (this.procedural) disposeProcedural(this.procedural);
    this.procedural = null;
    this.active = rig;
    this.arms.visible = false;
    this.playBase('idle', 0);
    this.rifleMixer.update(0);
  }
  async prepare(id: WeaponId): Promise<void> { if (this.disposed || !isWeaponId(id)) throw new Error('WeaponView unavailable'); }
  ready(id: WeaponId): boolean { return !this.disposed && isWeaponId(id) && (!isRifle(id) || this.rifle !== null); }
  setWeapon(id: WeaponId): void {
    if (this.disposed || !isWeaponId(id) || id === this.weapon) return;
    const previousWasRifle = isRifle(this.weapon);
    const nextIsRifle = isRifle(id);
    this.active.removeFromParent();
    if (previousWasRifle && !nextIsRifle) this.rifleMixer?.stopAllAction();
    if (!previousWasRifle && this.procedural) {
      disposeProcedural(this.procedural);
      this.procedural = null;
    }
    if (nextIsRifle) {
      if (!this.rifle) throw new Error('AK-74M model is not ready');
      this.active = this.rifle;
    } else {
      this.procedural = makeWeapon(id);
      this.active = this.procedural;
    }
    this.holder.add(this.active);
    this.arms.visible = !nextIsRifle;
    this.weapon = id;
    this.flashPending = false; this.flashTime = 0; this.inspectTime = 0; this.lastReloading = false;
    if (nextIsRifle) this.playOnce('draw', WEAPONS[id].equip);
  }
  private playBase(name: BaseAnimation, fade = .14): void {
    const next = this.rifleActions.get(name) ?? this.rifleActions.get('idle');
    if (!next || next === this.currentBase) return;
    this.currentBase?.fadeOut(.14);
    this.oneShot?.fadeOut(.1);
    this.oneShot = null;
    next.reset().setLoop(THREE.LoopRepeat);
    if (fade > 0) next.fadeIn(fade);
    next.play();
    this.currentBase = next;
  }
  private playOnce(name: 'draw' | 'shot' | 'reload', duration = 0): void {
    const next = this.rifleActions.get(name);
    if (!next || (next === this.oneShot && next.isRunning())) return;
    this.oneShot?.fadeOut(.05);
    this.currentBase?.fadeOut(.06);
    this.currentBase = null;
    next.reset().setLoop(THREE.LoopOnce, 1);
    next.setEffectiveTimeScale(1);
    if (duration > 0) next.setDuration(duration);
    next.clampWhenFinished = true;
    next.fadeIn(.06).play();
    this.oneShot = next;
  }
  fire(_heavy = false, _authorityAt?: number): void {
    if (this.disposed) return;
    if (this.state?.infected) this.infectedArms.fire();
    else {
      this.flashTime = .18; this.flashPending = this.weapon !== 'melee';
      if (isRifle(this.weapon) && this.oneShot !== this.rifleActions.get('reload')) this.playOnce('shot');
    }
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
    const bob = Math.sin(this.motionTime * 6) * .012 * state.moving;
    const rifleMode = isRifle(this.weapon);
    this.holder.position.set(rifleMode ? .12 * (1 - ads) : .23 * (1 - ads), (rifleMode ? -.05 : -.2) + bob, rifleMode ? -.36 : -.55);
    this.holder.rotation.x = rifleMode
      ? 0
      : (this.flashTime > 0 ? (this.weapon === 'melee' ? -.5 * Math.sin((.18 - this.flashTime) / .18 * Math.PI) : .05) : 0) + (state.reloadElapsed !== null ? Math.sin(state.reloadProgress * Math.PI) * .35 : 0);
    this.holder.rotation.z = Math.sin(this.inspectTime * Math.PI) * .55;
    this.scene.updateMatrixWorld(true);
    const muzzle = this.active.getObjectByName('held:muzzle');
    if (muzzle) { muzzle.getWorldPosition(this.ndc); this.holder.worldToLocal(this.ndc); this.flash.position.copy(this.ndc); }
    this.flash.visible = this.holder.visible && state.weapon !== 'melee' && this.flashTime > 0;
    if (rifleMode && this.rifleMixer) {
      const moving = state.moving > .05;
      const base: BaseAnimation = moving ? (state.walking ? 'walk' : 'run') : 'idle';
      const reloading = state.reloadElapsed !== null;
      if (!state.alive || (!reloading && this.lastReloading) || (this.oneShot && !this.oneShot.isRunning())) this.playBase(base);
      if (state.alive && reloading && !this.lastReloading) {
        this.playOnce('reload', WEAPONS[this.weapon].reload);
      }
      else if (!this.oneShot) this.playBase(base);
      this.lastReloading = reloading;
      const reload = this.rifleActions.get('reload');
      if (this.oneShot === reload && reloading) {
        const elapsed = state.reloadElapsed ?? 0;
        reload.time = Math.max(reload.time, elapsed * reload.timeScale) - d * reload.timeScale;
      }
      this.rifleMixer.update(d);
    }
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
    return { flashVisible: this.flash.visible, flashRenders: this.flashRenders, flashMapped: false, muzzleNdc: null, texturesReady: this.rifle !== null, weapon: this.weapon, agent: this.agent, armsReady: this.rifle !== null, armsTexture: this.rifle !== null, reloadSample: this.state?.reloadProgress ?? 0, equipElapsed: this.state?.equipElapsed ?? null, equipDuration: 0, adsProgress: this.state?.adsProgress ?? 0, zoom: this.state?.zoom ?? 1, verticalFov: this.camera.fov, ready: this.ready(this.weapon), assetManifest: '/data/animations/fps-ak74m/scene.gltf', attackManifest: null, attachBone: 'Rif_end_079', melee: null };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rifleMixer?.stopAllAction();
    if (this.rifleModel && this.rifleMixer) this.rifleMixer.uncacheRoot(this.rifleModel);
    this.infectedArms.dispose();
    disposeViewModel(this.holder);
    this.scene.clear();
  }
}