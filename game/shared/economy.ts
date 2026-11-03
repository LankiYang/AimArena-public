import type { HitPart, WeaponId } from './combat.ts';
import { TICK_DT, TICK_RATE } from './sim/tick.ts';
import { WEAPONS, isWeaponId, weaponSlot } from './sim/weapons.ts';

export type ArmorKind = 'light' | 'regen' | 'heavy';
export interface ArmorDef { name: string; points: number; absorb: number; pool: number; price: number }
/** Armor points absorb a fraction of non-head damage, one point per damage absorbed. */
export const ARMOR: Record<ArmorKind, ArmorDef> = {
  light: { name: '轻型护甲', points: 30, absorb: 0.5, pool: 0, price: 400 },
  regen: { name: '再生护甲', points: 30, absorb: 0.6, pool: 40, price: 1000 },
  heavy: { name: '重型护甲', points: 60, absorb: 0.7, pool: 0, price: 1000 },
};
export const ARMOR_KINDS: readonly ArmorKind[] = ['light', 'regen', 'heavy'];
export const isArmorKind = (v: unknown): v is ArmorKind => typeof v === 'string' && (ARMOR_KINDS as readonly string[]).includes(v);
export const ARMOR_REGEN = { delaySeconds: 4, perSecond: 8 } as const;
export const ARMOR_REGEN_DELAY_TICKS = Math.round(ARMOR_REGEN.delaySeconds * TICK_RATE);
export const ARMOR_REGEN_PER_TICK = ARMOR_REGEN.perSecond * TICK_DT;
export interface ArmorState { kind: ArmorKind | null; points: number; pool: number; hurtTick: number }
export const newArmorState = (): ArmorState => ({ kind: null, points: 0, pool: 0, hurtTick: -Infinity });
export function equipArmor(s: ArmorState, kind: ArmorKind): ArmorState { s.kind = kind; s.points = ARMOR[kind].points; s.pool = ARMOR[kind].pool; s.hurtTick = -Infinity; return s; }
export function clearArmor(s: ArmorState): ArmorState { s.kind = null; s.points = 0; s.pool = 0; s.hurtTick = -Infinity; return s; }
export const armorKindCode = (kind: ArmorKind | null): number => kind === null ? 0 : ARMOR_KINDS.indexOf(kind) + 1;
export const armorKindFromCode = (code: number): ArmorKind | null => ARMOR_KINDS[code - 1] ?? null;
export function absorbArmor(s: ArmorState, damage: number, part: HitPart, tick: number): { absorbed: number; healthLoss: number } {
  const amount = Number.isFinite(damage) ? Math.max(0, damage) : 0;
  if (!amount) return { absorbed: 0, healthLoss: 0 };
  s.hurtTick = tick;
  const absorbed = s.kind && part !== 'head' ? Math.min(Math.max(0, s.points), amount * ARMOR[s.kind].absorb) : 0;
  s.points -= absorbed;
  return { absorbed, healthLoss: amount - absorbed };
}
export function stepArmorRegen(s: ArmorState, tick: number): void {
  if (!armorRegenerating(s, tick)) return;
  const restored = Math.min(ARMOR.regen.points - s.points, s.pool, ARMOR_REGEN_PER_TICK);
  s.points += restored; s.pool -= restored;
}
export const armorRegenerating = (s: ArmorState, tick: number): boolean => s.kind === 'regen' && s.points < ARMOR.regen.points && s.pool > 0 && tick - s.hurtTick >= ARMOR_REGEN_DELAY_TICKS;
export const WEAPON_PRICES: Record<WeaponId, number> = {
  classic: 0, shorty: 200, frenzy: 300, ghost: 450, sheriff: 500, bucky: 900, judge: 900, stinger: 1000, spectre: 1250,
  bulldog: 2700, guardian: 2800, phantom: 2900, vandal: 3100, ares: 2900, odin: 3100, marshal: 4750, outlaw: 4750, operator: 4750, melee: 0,
};
export const FREE_WEAPONS: readonly WeaponId[] = ['melee', 'classic'];
export const SND_DEFAULT_SIDEARM: WeaponId = 'classic';
export const ECONOMY = { startCredits: 800, maxCredits: 16000, winReward: 3000, loseBase: 1900, loseStep: 500, loseCap: 3400 } as const;
export const lossBonus = (lossStreak: number): number => Math.min(ECONOMY.loseCap, ECONOMY.loseBase + Math.max(0, Math.trunc(lossStreak) - 1) * ECONOMY.loseStep);
export const roundReward = (won: boolean, lossStreak: number): number => won ? ECONOMY.winReward : lossBonus(Math.max(1, Math.trunc(lossStreak)));
export const addCredits = (credits: number, delta: number): number => Math.max(0, Math.min(ECONOMY.maxCredits, Math.trunc(credits) + Math.trunc(delta)));
export const nextLossStreak = (won: boolean, lossStreak: number): number => won ? 0 : Math.max(0, Math.trunc(lossStreak)) + 1;
export type BuyItem = { type: 'weapon'; id: WeaponId } | { type: 'armor'; id: ArmorKind };
export const buyItemId = (item: BuyItem): WeaponId | ArmorKind => item.id;
export const buyPrice = (item: BuyItem): number => item.type === 'weapon' ? WEAPON_PRICES[item.id] : ARMOR[item.id].price;
export const buyName = (item: BuyItem): string => item.type === 'weapon' ? WEAPONS[item.id].name : ARMOR[item.id].name;
export const buySlot = (item: BuyItem): number => item.type === 'weapon' ? weaponSlot(item.id) : 0;
export const isFreeItem = (item: BuyItem): boolean => item.type === 'weapon' && WEAPON_PRICES[item.id] === 0;
export function isBuyItem(v: unknown): v is BuyItem { if (!v || typeof v !== 'object') return false; const item = v as { type?: unknown; id?: unknown }; return item.type === 'weapon' ? isWeaponId(item.id) : item.type === 'armor' && isArmorKind(item.id); }
export type BuyFailReason = 'not-snd' | 'unknown-item' | 'not-alive' | 'window-closed' | 'insufficient-credits' | 'already-owned';
export const BUY_FAIL_TEXT: Record<BuyFailReason, string> = { 'not-snd': '只有爆破模式才有经济', 'unknown-item': '没有这个商品', 'not-alive': '阵亡时不能购买（等下一回合）', 'window-closed': '购买窗已关闭（只在回合准备阶段购买）', 'insufficient-credits': '余额不足', 'already-owned': '这个槽位已经是这件装备了' };
export function buyFailText(reason: BuyFailReason, item: BuyItem | null, credits: number): string { const base = BUY_FAIL_TEXT[reason]; if (!item) return base; const name = buyName(item); return reason === 'insufficient-credits' ? `${base}：${name} ${buyPrice(item)}，当前余额 ${credits}，还差 ${buyPrice(item) - credits}` : `${name}：${base}`; }
export const buyOkText = (item: BuyItem, price: number, credits: number): string => `已购买 ${buyName(item)}${price > 0 ? ` −${price}` : '（随身免费）'} · 余额 ${credits}`;
