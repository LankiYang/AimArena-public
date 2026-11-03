import type { GameWeaponState } from './sim/weapon-game.ts';
import type { ArmorKind } from './economy.ts';
import type { SndEvent, SndView } from './snd.ts';
import type { TdmEvent, TdmView } from './tdm.ts';
import type { InfectionState } from './infection.ts';

// Stable wire identifiers; the presentation and weapon rules are independent.
export type WeaponId = 'classic' | 'shorty' | 'frenzy' | 'ghost' | 'sheriff' | 'stinger' | 'spectre' | 'bucky' | 'judge' | 'bulldog' | 'guardian' | 'phantom' | 'vandal' | 'marshal' | 'outlaw' | 'operator' | 'ares' | 'odin' | 'melee';
export type HitPart = 'head' | 'body' | 'legs';
export interface V3 { x: number; y: number; z: number }
export interface SurfaceImpact { position: V3; normal: V3; surface: number }
export interface CombatSelf {
  hp: number; alive: boolean; weapon: WeaponId; mag: number; reserve: number;
  reloadUntil: number; equipUntil: number; respawnAt: number; protectedUntil: number;
  recoilYaw: number; recoilPitch: number;
  armor: number; armorKind: ArmorKind | null; armorPool: number; armorRegen: boolean;
  credits: number; owned: WeaponId[]; prediction?: WeaponState;
  attackSerial: number; ackFire: number; inputSeq: number;
  role?: 'human' | 'infected'; moveSpeedMultiplier?: number;
}
export interface ShotRay { end: V3; hit: number | null; part: HitPart | null; damage: number; killed: boolean; penetrated: boolean; impacts: SurfaceImpact[] }
export type CombatEvent =
  | { kind: 'meleeStart'; player: number; attackSerial: number; commandSeq: number; heavy: boolean; origin: V3 }
  | { kind: 'shot'; id: number; shooter: number; weapon: WeaponId; origin: V3; rays: ShotRay[]; attackSerial: number; commandSeq: number; heavy?: boolean }
  | { kind: 'reload'; player: number; weapon: WeaponId; until: number }
  | { kind: 'equip'; player: number; weapon: WeaponId }
  | { kind: 'death'; player: number; killer: number; weapon: WeaponId }
  | { kind: 'respawn'; player: number }
  | Exclude<SndEvent, { kind: 'matchEnd' }>
  | Exclude<TdmEvent, { kind: 'matchEnd' }>;
// Squad details are sent only to eligible teammates.
export interface SquadMate { id: number; alive: boolean; hp: number; armor: number; armorKind: ArmorKind | null; weapon: WeaponId; mag: number; reserve: number }
export interface CombatUpdate { t: 'combat'; tick: number; self: CombatSelf; events: CombatEvent[]; squad?: SquadMate[]; infectionState?: InfectionState; round?: SndView; tdm?: TdmView }
export interface WeaponDamage { head: number; body: number; legs: number }
export interface WeaponFalloff { distance: number; damage: WeaponDamage }
export interface WeaponDef {
  id: WeaponId; name: string; automatic: boolean; magazine: number; pelletsPerShot: number;
  reserve: number; rate: number; reload: number; equip: number; range: number;
  damage: WeaponDamage; falloff?: WeaponFalloff; falloffs?: WeaponFalloff[];
  penetrationBudget: number; melee?: boolean; heavyDamage?: number;
}
export interface WeaponAmmo { mag: number; reserve: number }
export interface WeaponState {
  weapon: WeaponId; ammo: Record<WeaponId, WeaponAmmo>; reloadUntil: number; equipUntil: number;
  nextFireTick: number; burst: number; lastFireTick: number; aim: boolean; triggerHeld: boolean;
  burstRemaining: number; attackSerial: number; ackFire: number; zoomLockUntil: number;
  randomState: number; game: GameWeaponState | null;
}
export const AIM_PITCH_LIMIT = 1.5;
export function aimDir(yaw: number, pitch: number): V3 {
  const horizontal = Math.cos(pitch);
  return { x: -Math.sin(yaw) * horizontal, y: Math.sin(pitch), z: -Math.cos(yaw) * horizontal };
}
export const clampPitch = (pitch: number) => Math.max(-AIM_PITCH_LIMIT, Math.min(AIM_PITCH_LIMIT, pitch));
