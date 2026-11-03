import { clampPitch, type HitPart, type WeaponAmmo, type WeaponDef, type WeaponId, type WeaponState } from '../combat.ts';
import { TICK_RATE } from './tick.ts';
import { SOURCE_WEAPONS } from './weapon-source.ts';
import { advanceGameWeapon, cloneGameWeapon, fireGameWeapon, gameAim, newGameWeapon, type WeaponPose } from './weapon-game.ts';

export const ticksFor = (seconds: number) => Math.max(0, Math.ceil(seconds * TICK_RATE));
const gun = (id: WeaponId, name: string, automatic: boolean, magazine: number, reserve: number, rate: number, reload: number, range: number, body: number, pelletsPerShot = 1, penetrationBudget = 0.5): WeaponDef => ({
  id, name, automatic, magazine, reserve, rate, reload, equip: 0.7, range, pelletsPerShot, penetrationBudget,
  damage: { head: Math.round(body * 2.2), body, legs: Math.round(body * 0.75) },
  falloff: { distance: range * 0.55, damage: { head: Math.round(body * 1.65), body: Math.round(body * 0.75), legs: Math.round(body * 0.55) } },
});
/** Independently tuned weapon roster; damage for shotguns is per pellet. */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  classic: gun('classic', '标配', false, 12, 36, 5, 1.6, 45, 25),
  shorty: gun('shorty', '短炮', false, 2, 12, 2, 1.8, 20, 10, 9, 0.15),
  frenzy: gun('frenzy', '狂怒', true, 15, 45, 9, 1.7, 40, 20),
  ghost: gun('ghost', '鬼魅', false, 15, 45, 5, 1.6, 50, 28),
  sheriff: gun('sheriff', '正义', false, 6, 24, 3, 2, 55, 48, 1, 0.7),
  stinger: gun('stinger', '蜂刺', true, 20, 60, 12, 2, 45, 22),
  spectre: gun('spectre', '骇灵', true, 30, 90, 11, 2.2, 50, 24),
  bucky: gun('bucky', '雄鹿', false, 5, 20, 1, 2.5, 25, 11, 10, 0.2),
  judge: gun('judge', '判官', true, 7, 28, 3, 2.5, 25, 9, 10, 0.2),
  bulldog: gun('bulldog', '斗牛犬', true, 24, 72, 8, 2.3, 70, 31, 1, 0.8),
  guardian: gun('guardian', '戍卫', false, 12, 48, 4, 2.2, 75, 50, 1, 1),
  phantom: gun('phantom', '幻影', true, 30, 90, 9, 2.4, 70, 32, 1, 0.8),
  vandal: gun('vandal', '狂徒', true, 25, 75, 8, 2.4, 75, 36, 1, 0.9),
  marshal: gun('marshal', '飞将', false, 5, 20, 1.2, 2.5, 100, 75, 1, 1),
  outlaw: gun('outlaw', '亡命', false, 2, 16, 1.5, 2.7, 100, 100, 1, 1.2),
  operator: gun('operator', '冥驹', false, 5, 15, 0.7, 3, 110, 130, 1, 1.5),
  ares: gun('ares', '战神', true, 50, 100, 10, 3, 75, 28, 1, 1),
  odin: gun('odin', '奥丁', true, 75, 150, 11, 3.5, 80, 30, 1, 1.2),
  melee: { id: 'melee', name: '近战', automatic: true, magazine: 0, reserve: 0, rate: 2, reload: 0, equip: 0.4, range: 2, pelletsPerShot: 0, penetrationBudget: 0, damage: { head: 45, body: 45, legs: 45 }, heavyDamage: 75, melee: true },
};
export interface WeaponAdsProfile { zoomMultipliers: readonly number[]; transitionSeconds: number; zoomOutSeconds: number; zoomLockAfterShotSeconds: number; unscopeAfterShot: boolean }
export const WEAPON_ADS: Partial<Record<WeaponId, WeaponAdsProfile>> = Object.fromEntries(Object.entries(SOURCE_WEAPONS).flatMap(([id, profile]) => {
  const a = profile.stability?.ads;
  return a?.levels.length ? [[id, { zoomMultipliers: a.levels.map(l => l.zoomMultiplier), transitionSeconds: a.transitionSeconds, zoomOutSeconds: a.zoomOutSeconds, zoomLockAfterShotSeconds: a.zoomLockAfterShotSeconds, unscopeAfterShot: a.unscopeAfterShot }]] : [];
}));
export type WeaponSlot = 1 | 2 | 3;
export const WEAPON_GROUPS: readonly { name: string; slot: WeaponSlot; weapons: readonly WeaponId[] }[] = [
  { name: '手枪', slot: 2, weapons: ['classic', 'shorty', 'frenzy', 'ghost', 'sheriff'] },
  { name: '冲锋枪', slot: 1, weapons: ['stinger', 'spectre'] }, { name: '霰弹枪', slot: 1, weapons: ['bucky', 'judge'] },
  { name: '步枪', slot: 1, weapons: ['bulldog', 'guardian', 'phantom', 'vandal'] },
  { name: '狙击枪', slot: 1, weapons: ['marshal', 'outlaw', 'operator'] }, { name: '机枪', slot: 1, weapons: ['ares', 'odin'] },
  { name: '近战', slot: 3, weapons: ['melee'] },
];
const slots = Object.fromEntries(WEAPON_GROUPS.flatMap(g => g.weapons.map(id => [id, g.slot]))) as Record<WeaponId, WeaponSlot>;
export const weaponSlot = (id: WeaponId): WeaponSlot => slots[id];
export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];
export const isWeaponId = (v: unknown): v is WeaponId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, v);
export const weaponOf = (id: WeaponId) => WEAPONS[id];
export const DEFAULT_WEAPON: WeaponId = 'vandal';
export const DEFAULT_SIDEARM: WeaponId = 'ghost';
export const fireIntervalTicks = (id: WeaponId, aim = false) => TICK_RATE / (WEAPONS[id].rate * (aim ? SOURCE_WEAPONS[id].stability?.ads.fireRateMultiplier ?? 1 : 1));
export const weaponMovement = (id: WeaponId, zoom: number | boolean) => ({ gunM: SOURCE_WEAPONS[id].runSpeed / 6.75, zoomRatio: zoom ? SOURCE_WEAPONS[id].stability?.ads.movementRatio ?? 1 : 1 });
const fullAmmo = (): Record<WeaponId, WeaponAmmo> => Object.fromEntries(WEAPON_IDS.map(id => [id, { mag: WEAPONS[id].magazine, reserve: WEAPONS[id].reserve }])) as Record<WeaponId, WeaponAmmo>;
export function newWeaponState(id: WeaponId = DEFAULT_WEAPON): WeaponState { return { weapon: id, ammo: fullAmmo(), reloadUntil: 0, equipUntil: 0, nextFireTick: 0, burst: 0, lastFireTick: -1, aim: false, triggerHeld: false, burstRemaining: 0, attackSerial: 0, ackFire: 0, zoomLockUntil: 0, randomState: 0, game: newGameWeapon(id) }; }
export function cloneWeaponState(s: WeaponState): WeaponState { return { ...s, game: cloneGameWeapon(s.game), ammo: Object.fromEntries(WEAPON_IDS.map(id => [id, { ...s.ammo[id] }])) as Record<WeaponId, WeaponAmmo> }; }
export function cancelWeaponActions(s: WeaponState) { s.reloadUntil = 0; s.aim = false; s.triggerHeld = false; s.burst = 0; s.burstRemaining = 0; s.lastFireTick = -1; s.game = newGameWeapon(s.weapon); }
export function resetWeapon(s: WeaponState) { cancelWeaponActions(s); s.ammo = fullAmmo(); s.equipUntil = 0; s.nextFireTick = 0; s.zoomLockUntil = 0; }
export function firingState(s: WeaponState, _tick: number) { const a = gameAim(s.game, s.weapon, s.aim); return { progress: a.progress, stability: a.progress, pitch: a.pitch, yaw: a.yaw, cameraPitch: a.cameraPitch, cameraYaw: a.cameraYaw }; }
export const MELEE_HEAVY_TICKS = ticksFor(1);
export const ammoOf = (s: WeaponState, id: WeaponId = s.weapon) => s.ammo[id];
export const isReloading = (s: WeaponState, tick: number) => s.reloadUntil > tick;
export const burstIndex = (s: WeaponState, tick: number) => firingState(s, tick).progress;
export const canFire = (s: WeaponState, tick: number) => ammoOf(s).mag > 0 && !isReloading(s, tick) && tick >= s.equipUntil && tick >= s.nextFireTick;
export function weaponRandom(s: WeaponState): number { s.randomState = (Math.imul(s.randomState, 1664525) + 1013904223) >>> 0; return s.randomState / 4294967296; }
export function consumeShot(s: WeaponState, tick: number) { ammoOf(s).mag--; if (tick > s.nextFireTick + 1) s.nextFireTick = tick; s.nextFireTick += fireIntervalTicks(s.weapon, s.aim); fireGameWeapon(s.game, s.weapon, s.aim, fireIntervalTicks(s.weapon, s.aim) / TICK_RATE, weaponRandom(s)); s.burst = gameAim(s.game, s.weapon, s.aim).progress; s.lastFireTick = tick; }
export const canReload = (s: WeaponState, tick: number) => tick >= s.equipUntil && !isReloading(s, tick) && ammoOf(s).mag < WEAPONS[s.weapon].magazine && ammoOf(s).reserve > 0;
export function startReload(s: WeaponState, tick: number): number { s.burstRemaining = 0; s.aim = false; return s.reloadUntil = tick + ticksFor(WEAPONS[s.weapon].reload); }
export function finishReload(s: WeaponState) { const a = ammoOf(s), take = Math.min(WEAPONS[s.weapon].magazine - a.mag, a.reserve); a.mag += take; a.reserve -= take; s.reloadUntil = 0; }
export function startEquip(s: WeaponState, id: WeaponId, tick: number): number { s.weapon = id; cancelWeaponActions(s); s.zoomLockUntil = 0; s.nextFireTick = s.equipUntil = tick + ticksFor(WEAPONS[id].equip); return s.equipUntil; }
export const canAttack = (s: WeaponState, tick: number) => WEAPONS[s.weapon].melee ? tick >= s.equipUntil && tick >= s.nextFireTick : canFire(s, tick);
export function consumeMelee(s: WeaponState, tick: number, heavy: boolean) { if (tick > s.nextFireTick + 1) s.nextFireTick = tick; s.nextFireTick += heavy ? MELEE_HEAVY_TICKS : fireIntervalTicks(s.weapon); s.burst++; s.lastFireTick = tick; }
export const meleeDamage = (def: WeaponDef, part: HitPart, heavy: boolean) => heavy ? def.heavyDamage ?? def.damage[part] : def.damage[part];
export function baseDamage(def: WeaponDef, part: HitPart, distance: number): number { let damage = def.damage; for (const f of def.falloffs ?? []) { if (distance <= f.distance) break; damage = f.damage; } if (def.falloff && distance > def.falloff.distance) damage = def.falloff.damage; return damage[part]; }
export interface AimKick { yaw: number; pitch: number }
export interface WeaponInput { tick: number; fire: boolean; firePressed: boolean; reloadPressed: boolean; aim: boolean; aimPressed: boolean; alive: boolean; frozen: boolean; commandSeq?: number; pose?: WeaponPose }
export interface WeaponAttack { weapon: WeaponId; heavy: boolean; commandSeq: number; attackSerial: number; recoil: AimKick; cameraRecoil: AimKick; errorDegrees: number; errorPower: number; spread: readonly { angle: number; radius: number }[] }
export function stepWeaponInput(s: WeaponState, input: WeaponInput): { attack: WeaponAttack | null; reloadUntil?: number } {
  const { tick } = input, result: { attack: WeaponAttack | null; reloadUntil?: number } = { attack: null };
  s.triggerHeld = input.fire;
  if (!input.alive || input.frozen) { s.aim = false; s.burstRemaining = 0; return result; }
  if (s.reloadUntil > 0 && tick >= s.reloadUntil) finishReload(s);
  const profile = SOURCE_WEAPONS[s.weapon].stability;
  s.aim = input.aim && !!profile?.ads.levels.length && tick >= s.zoomLockUntil && tick >= s.equipUntil && !isReloading(s, tick);
  advanceGameWeapon(s.game, s.weapon, tick, s.aim, SOURCE_WEAPONS[s.weapon].runSpeed, input.pose);
  s.burst = gameAim(s.game, s.weapon, s.aim).progress;
  if ((input.reloadPressed || (ammoOf(s).mag === 0 && tick >= s.equipUntil)) && canReload(s, tick)) result.reloadUntil = startReload(s, tick);
  if (!canAttack(s, tick)) return result;
  const def = WEAPONS[s.weapon], heavy = !!def.melee && !input.fire && input.aimPressed;
  if (!heavy && !input.firePressed && !(def.automatic && input.fire)) return result;
  const recoil = gameAim(s.game, s.weapon, s.aim), errorDegrees = recoil.error + (s.game?.movement.degrees ?? 0);
  if (def.melee) consumeMelee(s, tick, heavy); else consumeShot(s, tick);
  s.attackSerial++; s.ackFire = input.commandSeq ?? 0;
  const spread = Array.from({ length: errorDegrees > 0 ? def.pelletsPerShot : 0 }, () => ({ angle: weaponRandom(s), radius: weaponRandom(s) }));
  result.attack = { weapon: s.weapon, heavy, commandSeq: s.ackFire, attackSerial: s.attackSerial, recoil: { yaw: recoil.yaw, pitch: recoil.pitch }, cameraRecoil: { yaw: recoil.cameraYaw, pitch: recoil.cameraPitch }, errorDegrees, errorPower: recoil.power, spread };
  if (s.aim && profile?.ads.unscopeAfterShot) { s.aim = false; s.zoomLockUntil = tick + ticksFor(profile.ads.zoomLockAfterShotSeconds); }
  return result;
}
export function shotAngles(baseYaw: number, basePitch: number, recoil: AimKick, spread: AimKick) { return { yaw: baseYaw + recoil.yaw + spread.yaw, pitch: clampPitch(basePitch + recoil.pitch + spread.pitch) }; }
