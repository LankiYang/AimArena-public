import { GAME_WEAPONS, type GameCurve } from './weapon-game-source.ts';
import { TICK_RATE } from './tick.ts';
import type { WeaponId } from '../combat.ts';

export interface GameInterval { s: number; t: number; tr: number; d: number; type: number }
export interface GameDecayState { cur: number; dsv: number; dst: number }
export interface GameRecoilState { iv: GameInterval[]; yawSwitch: GameInterval; bank: number; gunRecoveryRemaining: number; now: number; pitchDecay: GameDecayState; yawDecay: GameDecayState }
export interface WeaponPose { speed: number; grounded: boolean; crouch: number; crouchHeld?: boolean; walking?: boolean; landT?: number; landV?: number; tagged?: boolean; tagState?: number; tagSpeed?: number }
export interface GameMoveState { type: number; lastRun: number; runStart: number; normal: GameDecayState; zoom: GameDecayState; degrees: number }
export interface GameWeaponState { hip: GameRecoilState; zoom: GameRecoilState | null; movement: GameMoveState; tick: number; pose: WeaponPose }

export function gameCurve(curve: GameCurve, t: number): number {
  if (!curve.length) return 0;
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (t <= b[0]) return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0] || 1);
  }
  return curve[curve.length - 1][1];
}
const interval = (): GameInterval => ({ s: 0, t: 0, tr: 0, d: 0, type: 0 });
const decay = (): GameDecayState => ({ cur: 0, dsv: 0, dst: 0 });
const recoil = (): GameRecoilState => ({ iv: Array.from({ length: 4 }, interval), yawSwitch: interval(), bank: 0, gunRecoveryRemaining: 0, now: 0, pitchDecay: decay(), yawDecay: decay() });
export function newGameWeapon(id: WeaponId): GameWeaponState | null {
  if (!GAME_WEAPONS[id]) return null;
  return { hip: recoil(), zoom: recoil(), movement: { type: 0, lastRun: 0, runStart: 0, normal: decay(), zoom: decay(), degrees: 0 }, tick: -1, pose: { speed: 0, grounded: true, crouch: 0 } };
}
export function cloneGameWeapon(s: GameWeaponState | null): GameWeaponState | null {
  if (!s) return null;
  const copy = (r: GameRecoilState): GameRecoilState => ({ ...r, iv: r.iv.map(v => ({ ...v })), yawSwitch: { ...r.yawSwitch }, pitchDecay: { ...r.pitchDecay }, yawDecay: { ...r.yawDecay } });
  return { ...s, hip: copy(s.hip), zoom: s.zoom && copy(s.zoom), movement: { ...s.movement, normal: { ...s.movement.normal }, zoom: { ...s.movement.zoom } }, pose: { ...s.pose } };
}
export function gameAim(s: GameWeaponState | null, id: WeaponId, aim: boolean) {
  const data = GAME_WEAPONS[id];
  if (!s || !data) return { progress: 0, pitch: 0, yaw: 0, cameraPitch: 0, cameraYaw: 0, error: 0, power: 0.5 };
  const r = aim && s.zoom ? s.zoom : s.hip, gun = aim && data.zoom ? data.zoom : data.hip;
  const pitch = r.iv[2].s * Math.PI / 180, yaw = r.iv[3].s * Math.PI / 180;
  return { progress: r.iv[0].s, pitch, yaw, cameraPitch: pitch * 0.5, cameraYaw: yaw * 0.5, error: gameCurve(gun.error.curve, r.iv[0].s), power: 0.5 };
}
export function advanceGameWeapon(s: GameWeaponState | null, _id: WeaponId, tick: number, aim: boolean, runSpeed: number, pose?: WeaponPose) {
  if (!s) return;
  const dt = s.tick < 0 ? 0 : Math.max(0, tick - s.tick) / TICK_RATE;
  s.tick = tick;
  if (pose) s.pose = { ...pose };
  for (const r of [s.hip, s.zoom]) if (r) {
    r.iv[0].s = Math.max(0, r.iv[0].s - dt * 3);
    const fade = Math.exp(-dt * 5);
    r.iv[2].s *= fade; r.iv[3].s *= fade;
  }
  const speedRatio = Math.min(1, Math.max(0, s.pose.speed / Math.max(0.1, runSpeed)));
  s.movement.degrees = (speedRatio * 1.5 + (s.pose.grounded ? 0 : 1.5)) * (aim ? 0.8 : 1) * (1 - Math.max(0, Math.min(1, s.pose.crouch)) * 0.25);
}
export function fireGameWeapon(s: GameWeaponState | null, id: WeaponId, aim: boolean, _seconds: number, random: number) {
  const data = GAME_WEAPONS[id];
  if (!s || !data) return;
  const r = aim && s.zoom ? s.zoom : s.hip, gun = aim && data.zoom ? data.zoom : data.hip;
  r.iv[0].s = Math.min(10, r.iv[0].s + 1);
  r.iv[2].s = Math.min(gameCurve(gun.pitch.curve, 10), r.iv[2].s + gameCurve(gun.pitch.curve, 10) / 10);
  r.iv[3].s = Math.max(-3, Math.min(3, r.iv[3].s + (random * 2 - 1) * gameCurve(gun.yaw.curve, 10) / 4));
}
