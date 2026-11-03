import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { dataPath } from '../paths.ts';

let assetPromise: Promise<GLTF> | null = null;
function loadArms(): Promise<GLTF> {
  return assetPromise ??= new GLTFLoader().loadAsync(dataPath('infected_firstperson_arms.glb')).catch(error => {
    assetPromise = null;
    throw error;
  });
}

/** Per-view skeleton and mixer; geometry and materials belong to the shared GLB cache. */
export class InfectedArms {
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private idle: THREE.AnimationAction | null = null;
  private attack: THREE.AnimationAction | null = null;
  private visible = false;
  private disposed = false;
  private loading = false;
  constructor(private readonly scene: THREE.Scene) {}

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.model) { this.model.visible = visible; return; }
    if (!visible || this.loading || this.disposed) return;
    this.loading = true;
    void loadArms().then(asset => {
      if (this.disposed) return;
      const model = cloneSkeleton(asset.scene);
      model.visible = this.visible;
      this.scene.add(model);
      this.model = model;
      const mixer = this.mixer = new THREE.AnimationMixer(model);
      const idle = asset.animations.find(c => c.name.toLowerCase() === 'idle');
      const attack = asset.animations.find(c => c.name.toLowerCase() === 'attack');
      if (idle) this.idle = mixer.clipAction(idle).play();
      if (attack) this.attack = mixer.clipAction(attack).setLoop(THREE.LoopOnce, 1);
    }).catch(error => console.error('[infection] arms model failed', error))
      .finally(() => { this.loading = false; });
  }

  fire(): void {
    if (!this.visible || !this.attack) return;
    this.idle?.fadeOut(.06);
    this.attack.reset().setEffectiveWeight(1).play();
  }

  update(dt: number): void {
    if (!this.visible || !this.mixer) return;
    const attacking = this.attack?.isRunning() === true;
    this.mixer.update(dt);
    if (attacking && !this.attack?.isRunning()) this.idle?.reset().fadeIn(.1).play();
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.model?.traverse(node => { if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose(); });
    this.model?.removeFromParent();
    this.model = null;
    this.mixer = null;
    this.idle = null;
    this.attack = null;
  }
}
