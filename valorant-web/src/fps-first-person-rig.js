import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

const ACTIONS = {
  idle: /AK_Idle$/,
  walk: /AK_Walk$/,
  run: /AK_Run$/,
  shot: /AK_Shot$/,
  reload: /AK_Reload$/,
};

// Godot demo's Camera3D/Hand and Sketchfab_Scene2 transforms, combined.
const VIEW_MOUNT = new THREE.Matrix4().set(
  -.324686, .00283114, -.0140075, .025,
  .00199273, .324416, .0193792, -.170168,
  .0141512, .0192746, -.324119, -.003,
  0, 0, 0, 1,
);

export class FPSFirstPersonRig {
  constructor(asset, camera) {
    this.root = new THREE.Group();
    this.root.renderOrder = 8;
    this.model = cloneSkeleton(asset.scene);
    this.model.applyMatrix4(VIEW_MOUNT);
    this.root.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = new Map();
    for (const [key, pattern] of Object.entries(ACTIONS)) {
      const clip = asset.animations.find((animation) => pattern.test(animation.name));
      if (!clip) throw new Error(`First-person animation missing: ${key}`);
      this.actions.set(key, this.mixer.clipAction(clip));
    }
    this.current = null;
    this.oneShot = null;
    this.lastReloading = false;
    this.spareMagazine = this.model.getObjectByName('Object_99');
    if (!this.spareMagazine?.isSkinnedMesh) throw new Error('First-person spare magazine is missing');
    this.spareMagazine.visible = false;
    this.model.traverse((object) => {
      if (object.isMesh) {
        object.renderOrder = 8;
        object.frustumCulled = false;
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });
    this.playBase('idle', 0);
    this.mixer.update(0);
    camera.add(this.root);
  }

  playBase(name, fade = .14) {
    const next = this.actions.get(name) || this.actions.get('idle');
    if (!next || next === this.current) return;
    this.current?.fadeOut(.14);
    this.oneShot?.fadeOut(.1);
    this.oneShot = null;
    next.reset().setLoop(THREE.LoopRepeat);
    if (fade > 0) next.fadeIn(fade);
    next.play();
    this.current = next;
  }

  playOnce(name, duration) {
    const next = this.actions.get(name);
    if (!next) return;
    if (next === this.oneShot && next.isRunning()) return;
    this.oneShot?.fadeOut(.05);
    this.current?.fadeOut(.06);
    this.current = null;
    next.reset().setLoop(THREE.LoopOnce, 1);
    next.setEffectiveTimeScale(1);
    if (duration > 0) next.setDuration(duration);
    next.clampWhenFinished = true;
    next.fadeIn(.06).play();
    this.oneShot = next;
  }

  fire() { if (this.oneShot !== this.actions.get('reload')) this.playOnce('shot'); }

  update(dt, { moving = false, walk = false, reloadRemaining = 0, alive = true } = {}) {
    this.root.visible = alive;
    const base = moving ? (walk ? 'walk' : 'run') : 'idle';
    const reloading = reloadRemaining > 0;
    if (!alive || (!reloading && this.lastReloading) || (this.oneShot && !this.oneShot.isRunning())) this.playBase(base);
    if (alive && reloading && !this.lastReloading) this.playOnce('reload', reloadRemaining);
    else if (!this.oneShot) this.playBase(base);
    this.lastReloading = reloading;
    this.mixer.update(Number.isFinite(dt) ? Math.max(0, dt) : 0);
    this.spareMagazine.visible = this.oneShot === this.actions.get('reload');
  }

  diagnostics() {
    const meshes = [];
    const textures = new Map();
    this.model.traverse((object) => {
      if (!object.isMesh) return;
      meshes.push({ name: object.name, triangles: (object.geometry.index?.count || object.geometry.attributes.position.count) / 3 });
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        for (const key of ['map', 'normalMap', 'metalnessMap', 'roughnessMap']) {
          const texture = material[key];
          if (texture && !textures.has(texture)) {
            textures.set(texture, {
              name: texture.name || key,
              width: texture.image?.width || texture.source?.data?.width || 0,
              height: texture.image?.height || texture.source?.data?.height || 0,
            });
          }
        }
      }
    });
    return {
      baseClip: this.current?.getClip().name || null,
      actionClip: this.oneShot?.getClip().name || null,
      meshes,
      textures: [...textures.values()],
    };
  }

  dispose() {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
  }
}
