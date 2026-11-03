// 人机人格：每局开局由种子确定性生成（纯数据，不碰权威规则）。
// 决定打法倾向：职责（冲点 / 守点 / 潜伏 / 接应 / 机动）、主副武器、站点与个体的反应、瞄准和搜索习惯。
// 团队阵型（冲点 / 默认 / 慢打 / 分兵）决定职责牌组，所以同一张图每局的站位与节奏都不一样。
import type { Team } from '../shared/catalog.ts';
import type { WeaponId } from '../shared/combat.ts';

export type BotRole = 'entry' | 'anchor' | 'lurker' | 'support' | 'flex';
export type TeamStance = 'rush' | 'default' | 'slow' | 'split';

export interface BotPersona {
  role: BotRole;
  stance: TeamStance;
  /** 主站点下标（与 mapData.snd.sites 的顺序一致；没有站点时为 -1） */
  site: number;
  /** 备选站点：守点长时间没有接触就轮换过去（没有备选时为 -1） */
  alt: number;
  /** 主武器；近身或被狙时的副武器 */
  weapon: WeaponId;
  sidearm: WeaponId;
  /** 0..1：越谨慎越早退守（低血量退移阈值 25..45，接应阈值 45..75） */
  caution: number;
  /** 0..1：守点 / 潜伏的耐心（越大停留越久，轮换与压进越晚） */
  patience: number;
  /** 反应时间系数（乘在难度的反应时间上） */
  reaction: number;
  /** 瞄准抖动系数（乘在难度的散布误差上） */
  wobble: number;
  /** 瞄准抖动相位：每人不同，不再只由 id 决定 */
  wobblePhase: number;
  /** 横移偏好方向（交战横移、接应绕行的左右） */
  strafe: 1 | -1;
  /** 0..1：搜索时偏好探头横移（>= 0.5），否则原地转圈扫视 */
  jiggle: number;
}

/** 名单席位：team = -1 为观战席，不参与分配 */
export interface PersonaSeat { id: number; team: Team | -1 }

export interface PersonaPlan { personas: Map<number, BotPersona>; stances: [TeamStance, TeamStance] }

/** 团队阵型对应的职责牌组（每队按座位顺序洗牌后分配） */
export const ROLE_DECKS: Readonly<Record<TeamStance, readonly BotRole[]>> = {
  rush: ['entry', 'entry', 'support', 'lurker', 'flex'],
  default: ['entry', 'anchor', 'lurker', 'support', 'flex'],
  slow: ['anchor', 'anchor', 'lurker', 'support', 'flex'],
  split: ['anchor', 'lurker', 'lurker', 'entry', 'support'],
};
const STANCES: readonly (readonly [TeamStance, number])[] = [['rush', 0.2], ['default', 0.4], ['slow', 0.25], ['split', 0.15]];
/** 慢打阵型守点更耐心，冲点阵型更急 */
const PATIENCE_SCALE: Readonly<Record<TeamStance, number>> = { rush: 0.7, default: 1, slow: 1.25, split: 1 };
type Table<T> = readonly (readonly [T, number])[];
const PRIMARY: Readonly<Record<BotRole, Table<WeaponId>>> = {
  entry: [['spectre', 3], ['stinger', 2], ['frenzy', 2], ['sheriff', 2], ['vandal', 2], ['phantom', 2], ['judge', 1]],
  anchor: [['vandal', 3], ['phantom', 3], ['guardian', 2], ['bulldog', 2], ['marshal', 1], ['ares', 1]],
  lurker: [['operator', 2], ['outlaw', 2], ['marshal', 2], ['sheriff', 1], ['vandal', 2], ['guardian', 1]],
  support: [['bulldog', 3], ['phantom', 2], ['vandal', 2], ['spectre', 2], ['stinger', 1], ['bucky', 1]],
  flex: [['vandal', 2], ['phantom', 2], ['spectre', 1], ['stinger', 1], ['guardian', 1], ['bulldog', 1], ['ares', 1],
    ['judge', 1], ['bucky', 1], ['frenzy', 1], ['sheriff', 1], ['marshal', 1], ['outlaw', 1], ['operator', 1]],
};
const SIDEARM: Readonly<Record<BotRole, Table<WeaponId>>> = {
  entry: [['frenzy', 2], ['sheriff', 2], ['classic', 1]],
  anchor: [['ghost', 3], ['sheriff', 2], ['classic', 1]],
  lurker: [['ghost', 3], ['sheriff', 2]],
  support: [['classic', 2], ['ghost', 2], ['shorty', 1]],
  flex: [['ghost', 2], ['classic', 1], ['sheriff', 1], ['frenzy', 1], ['shorty', 1]],
};

/** FNV-1a：字符串（如对局 UUID）转 32 位种子 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32：小而快的确定性伪随机数，范围 [0, 1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, table: Table<T>): T {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let r = rng() * total;
  for (const [value, weight] of table) { r -= weight; if (r < 0) return value; }
  return table[table.length - 1][0];
}

function shuffle<T>(rng: () => number, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 同一种子 + 同一名单 = 同一组人格（可复现）。每队独立抽阵型，再按座位分配职责、站点、武器与个体参数；
 * 站点在队内轮流分配（不会全挤一个点），备选点永远不等于主点，副武器永远不等于主武器。
 */
export function assignPersonas(seed: number, roster: readonly PersonaSeat[], siteCount: number): PersonaPlan {
  const rng = mulberry32(seed);
  const personas = new Map<number, BotPersona>();
  const stances: TeamStance[] = [];
  for (const team of [0, 1] as const) {
    const seats = roster.filter((seat) => seat.team === team);
    const stance = pick(rng, STANCES);
    stances.push(stance);
    const deck = shuffle(rng, ROLE_DECKS[stance]);
    const offset = siteCount > 0 ? Math.floor(rng() * siteCount) : 0;
    seats.forEach((seat, i) => {
      const role = deck[i % deck.length];
      const site = siteCount > 0 ? (i + offset) % siteCount : -1;
      const alt = siteCount > 1 ? (site + 1 + Math.floor(rng() * (siteCount - 1))) % siteCount : -1;
      const weapon = pick(rng, PRIMARY[role]);
      let sidearm = pick(rng, SIDEARM[role]);
      if (sidearm === weapon) sidearm = weapon === 'ghost' ? 'classic' : 'ghost';
      personas.set(seat.id, {
        role, stance, site, alt, weapon, sidearm,
        caution: rng(),
        patience: Math.min(1, rng() * PATIENCE_SCALE[stance]),
        reaction: 0.8 + rng() * 0.45,
        wobble: 0.75 + rng() * 0.55,
        wobblePhase: rng() * Math.PI * 2,
        strafe: rng() < 0.5 ? 1 : -1,
        jiggle: rng(),
      });
    });
  }
  return { personas, stances: [stances[0], stances[1]] };
}
