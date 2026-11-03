import type { WeaponId } from '../combat.ts';

export type GameCurve = readonly (readonly [number, number, string, number, number])[];
export interface GameDecay { curve: GameCurve; add: number; inc: number }
export interface GameChannel { curve: GameCurve; state: readonly number[]; adsMult: readonly number[]; adsAdd: readonly number[] }
export interface GameGun {
  rate: number; adsRate: number | null; error: GameChannel; pitch: GameChannel; yaw: GameChannel;
  pitchDecay: GameDecay; yawDecay: GameDecay; errorPowers: readonly number[]; incInterp: string; recInterp: string;
  recoveryEnabled: boolean; recovery: GameCurve;
  yawDir: { baseChance: number; mult: readonly number[]; timeToSwitch: number; protected: number; increaseInterp: string; recoveryInterp: string; overInterp: string };
  gunRecovery: number; tapEff: number; tapDeduct: number;
  cam: { followPitch: number; followYaw: number; popPitch: GameCurve; popYaw: GameCurve; pitchMinPop: number; pitchMaxPop: number; yawMinPop: number; yawMaxPop: number };
}
export interface GameMovement { move: readonly GameCurve[]; decay: GameDecay; tag: readonly GameCurve[]; tagMin: number; land: GameCurve; walkDelay: number; runTrigger: number; zoomed?: GameMovement | null }

const curve = (a: number, b: number): GameCurve => [[0, a, 'Linear', 0, 0], [10, b, 'Linear', 0, 0]];
const channel = (a: number, b: number): GameChannel => ({ curve: curve(a, b), state: [1], adsMult: [0.7], adsAdd: [0] });
const makeGun = (rate: number, spread: number, kick: number): GameGun => ({
  rate, adsRate: null, error: channel(spread, spread * 2), pitch: channel(0, kick), yaw: channel(0, kick * 0.25),
  pitchDecay: { curve: curve(1, 1), add: 0, inc: 0 }, yawDecay: { curve: curve(1, 1), add: 0, inc: 0 },
  errorPowers: [0.5], incInterp: 'Linear', recInterp: 'Linear', recoveryEnabled: true, recovery: curve(1, 1),
  yawDir: { baseChance: 0.5, mult: [1], timeToSwitch: 0, protected: 0, increaseInterp: 'Linear', recoveryInterp: 'Linear', overInterp: 'Linear' },
  gunRecovery: 3, tapEff: 1, tapDeduct: 0,
  cam: { followPitch: 0.5, followYaw: 0.5, popPitch: curve(0, 0), popYaw: curve(0, 0), pitchMinPop: 0, pitchMaxPop: 0, yawMinPop: 0, yawMaxPop: 0 },
});
const movement: GameMovement = { move: [], decay: { curve: curve(1, 1), add: 0, inc: 0 }, tag: [], tagMin: 0, land: curve(0, 0), walkDelay: 0, runTrigger: 0 };
const entry = (rate: number, spread: number, kick: number) => ({ hip: makeGun(rate, spread, kick), zoom: makeGun(rate, spread * 0.65, kick * 0.8), movement });
/** Independent tuning: spread and recoil curves are deliberately compact and shared by category. */
export const GAME_WEAPONS: Partial<Record<WeaponId, { hip: GameGun; zoom: GameGun | null; movement: GameMovement }>> = {
  classic: entry(5, 0.45, 3), shorty: entry(2, 4.5, 5), frenzy: entry(9, 0.8, 5), ghost: entry(5, 0.35, 3), sheriff: entry(3, 0.4, 6),
  stinger: entry(12, 0.8, 7), spectre: entry(11, 0.6, 6), bucky: entry(1, 4, 6), judge: entry(3, 3.5, 7),
  bulldog: entry(8, 0.45, 7), guardian: entry(4, 0.25, 5), phantom: entry(9, 0.4, 6), vandal: entry(8, 0.4, 8),
  marshal: entry(1.2, 1.8, 5), outlaw: entry(1.5, 2, 7), operator: entry(0.7, 2.5, 9), ares: entry(10, 0.7, 8), odin: entry(11, 0.8, 9),
};
