import * as THREE from 'three';
interface PoseDoc { bones: string[]; hold: string[]; frames: number; duration: number; source: string }
type CurveKey = [number, number, string, number, number];
interface MontageDoc extends PoseDoc { length: number; rate: number; blendIn: number; blendOut: number; blendOutTrigger?: number; autoBlendOut?: boolean; additiveDisable: CurveKey[] }
export interface MeleeManifest { attachBone: string; tScale: number; qScale: number; offsets: Record<string, [number, number]>; montages: Record<string, MontageDoc>; additives: Record<string, PoseDoc>; timing: { lightIntervalSeconds: number; heavyIntervalSeconds: number; comboWindowSeconds: number; comboNumber: number } }
export type MeleeAction = 'attack1' | 'attack2' | 'attack3' | 'heavy' | 'inspect';
export interface MeleeSample { action: MeleeAction | null; source: string | null; elapsed: number; weight: number; additive: 'idleAdd' | 'walkAdd' | 'runAdd' }
/** Procedural attack poses; no external animation data is loaded. */
export class MeleeAnimation {
  readonly attachBone: string;
  private current: MeleeSample = { action: null, source: null, elapsed: 0, weight: 0, additive: 'idleAdd' };
  private at = -Infinity;
  private action: MeleeAction | null = null;
  private lastLight = -Infinity;
  private combo = 0;
  constructor(_buf: ArrayBuffer, private readonly manifest: MeleeManifest, _names: readonly string[], _parents: readonly number[]) { this.attachBone = manifest.attachBone; }
  reset(): void { this.at = this.lastLight = -Infinity; this.action = null; this.combo = 0; }
  attack(at: number, heavy: boolean, authorityAt = at): void {
    if (heavy) this.action = 'heavy';
    else {
      this.combo = authorityAt - this.lastLight <= this.manifest.timing.lightIntervalSeconds + this.manifest.timing.comboWindowSeconds ? (this.combo + 1) % 3 : 0;
      this.lastLight = authorityAt; this.action = (['attack1', 'attack2', 'attack3'] as const)[this.combo];
    }
    this.at = at;
  }
  inspect(at: number): void { this.at = at; this.action = 'inspect'; }
  stats(): MeleeSample { return { ...this.current }; }
  sample(seconds: number, speed: number, walking: boolean, bones: readonly THREE.Bone[]): void {
    const elapsed = seconds - this.at;
    const duration = this.action === 'heavy' ? .6 : this.action === 'inspect' ? 1 : .35;
    const active = this.action && elapsed >= 0 && elapsed < duration ? this.action : null;
    const weight = active ? Math.sin(elapsed / duration * Math.PI) : 0;
    this.current = { action: active, source: null, elapsed: active ? elapsed : 0, weight, additive: speed > .4 ? (walking ? 'walkAdd' : 'runAdd') : 'idleAdd' };
    const bone = bones.find(item => item.name === this.attachBone);
    if (bone && active) bone.rotateX(-weight * (active === 'heavy' ? 1 : .6));
  }
}
