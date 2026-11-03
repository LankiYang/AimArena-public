// 人机战术基础设施：掩体点图、压制状态和效用评分。
// 这里只放纯数据与纯函数，BotBrain / BotSquad 负责把它接到权威对局循环。
import type { V3 } from '../shared/combat.ts';
import { raycast, type BVH } from '../shared/world/bvh.ts';
import type { Nav } from './nav.ts';

export type UtilityAction = 'engage' | 'cover' | 'retreat' | 'reload' | 'push' | 'wait' | 'peek';

/**
 * 高级团队战术（T1 默认点位 / T2 撤退补位 / T3 交叉火力）共用的阈值与状态名。
 * 状态机只有一份定义：BotBrain 每 tick 用 pickTactic 按优先级选出当前状态，再执行对应行为。
 */
export const TACTICS = Object.freeze({
  /** T1：血量低于此值且有可见敌人时广播「请求支援」 */
  requestHp: 50,
  /** T1：响应请求的是最近的几个空闲队友 */
  responders: 2,
  /** T1：请求的有效期（tick） */
  requestTicks: 2 * 32,
  /** T2：血量低于此值时撤退到队友身后 */
  retreatHp: 30,
  /** T2：撤退点取在队友平均位置之后再远离敌人多少米 */
  retreatBehind: 4,
  /** T2：补位目标的保留时间（tick） */
  fillTicks: 10 * 32,
  /** T3：两人以敌人为顶点的夹角超过 60° 才算交叉火力（弧度） */
  crossfireAngle: Math.PI / 3,
});

/** 战术状态机的状态（必选集合：idle / patrol / respond / retreat / cover / crossfire） */
export type TacticalState = 'idle' | 'patrol' | 'respond' | 'retreat' | 'cover' | 'crossfire' | 'engage' | 'mission';

/** 状态机的输入标志；每个标志都由 BotBrain 用真实观察（视野 / 血量 / 黑板）算出。 */
export interface TacticFlags {
  /** T2：残血且能算出「队友身后」的撤退点 */
  retreat: boolean;
  /** 掩体 / 探头 / T2 补位：需要掩体规划或前移到阵亡队友的掩体点 */
  cover: boolean;
  /** 有可见敌人 */
  enemy: boolean;
  /** T3：与队友对同一敌人构成 >60° 的交叉火力 */
  crossfire: boolean;
  /** T1：收到队友「请求支援」且自己是最近的空闲队友之一 */
  support: boolean;
  /** 本 tick 有爆破任务 */
  mission: boolean;
}

/**
 * 战术状态机优先级：撤退 > 掩体/补位 > 交叉火力 > 交战 > 支援响应 > 任务 > 巡逻。
 * 纯函数，便于离线回归直接验证优先级。
 */
export function pickTactic(f: TacticFlags): TacticalState {
  if (f.retreat) return 'retreat';
  if (f.cover) return 'cover';
  if (f.enemy && f.crossfire) return 'crossfire';
  if (f.enemy) return 'engage';
  if (f.support) return 'respond';
  if (f.mission) return 'mission';
  return 'patrol';
}

/** T1 区域默认点位表：区域名 + 区域中心 + 该区域的 3–5 个默认巡逻点 */
export interface TacticsZone {
  name: string;
  center: V3;
  points: readonly V3[];
}

/** 区域点位相对区域中心的偏移（米，+x 东 / +z 南）：中心 + 四角，共 5 个点。 */
const ZONE_OFFSETS: readonly (readonly [number, number])[] = [[0, 0], [-4, -4], [4, 4], [-4, 4], [4, -4]];
const clone = (p: V3): V3 => ({ x: p.x, y: p.y, z: p.z });

/**
 * T1：按地图包点把地图切成若干区域（ascent = A / B / Mid），每区用导航吸附出 3–5 个默认巡逻点。
 * 只在回合开局 / 复活波次建立一次，不做局中重抽；没有导航点时退回区域中心。
 */
export function buildZonePlan(patrols: readonly V3[], nav: Pick<Nav, 'snap'>): TacticsZone[] {
  const centers: { name: string; center: V3 }[] = patrols.map((p, i) => ({ name: String.fromCharCode(65 + i), center: clone(p) }));
  // 两个以上包点时补一个「Mid」＝各包点中点，覆盖地图中路。
  if (patrols.length >= 2) {
    let x = 0, y = 0, z = 0;
    for (const p of patrols) { x += p.x; y += p.y; z += p.z; }
    centers.push({ name: 'Mid', center: { x: x / patrols.length, y: y / patrols.length, z: z / patrols.length } });
  }
  return centers.map(({ name, center }) => {
    const points: V3[] = [], seen = new Set<string>();
    for (const [ox, oz] of ZONE_OFFSETS) {
      const raw = { x: center.x + ox, y: center.y, z: center.z + oz };
      const snapped = nav.snap(raw, 6, true);
      const point = snapped ? { x: snapped.x, y: snapped.y, z: snapped.z } : ox === 0 && oz === 0 ? clone(center) : null;
      if (!point) continue;
      const key = `${Math.round(point.x)}:${Math.round(point.y)}:${Math.round(point.z)}`;
      if (seen.has(key)) continue;
      seen.add(key); points.push(point);
    }
    return { name, center: clone(center), points };
  });
}

/**
 * T1：把 Bot 分配到区域。有人格站点就守自己的站点，否则按 Bot ID 固定分配；
 * 同一局内结果稳定，不会局中重抽阵型。
 */
export function zoneIndexFor(id: number, site: number, count: number): number {
  if (count <= 0) return -1;
  return (site >= 0 ? site : Math.abs(id)) % count;
}

/**
 * T2：撤退点 = 队友平均位置沿「敌人 → 队友平均」方向再延长 behind 米（即退到队友身后）。
 * 没有存活队友时返回 null（此时不进入撤退状态，仍按原有掩体 / 交战逻辑打）。
 */
export function retreatPoint(teammates: readonly V3[], threat: V3, behind = TACTICS.retreatBehind): V3 | null {
  if (!teammates.length) return null;
  let x = 0, y = 0, z = 0;
  for (const p of teammates) { x += p.x; y += p.y; z += p.z; }
  x /= teammates.length; y /= teammates.length; z /= teammates.length;
  const dx = x - threat.x, dz = z - threat.z, d = Math.hypot(dx, dz);
  if (d < .01) return { x, y, z };
  return { x: x + dx / d * behind, y, z: z + dz / d * behind };
}

/** T3：以敌人为顶点，两名队友水平方向之间的夹角（弧度）。同一侧进攻接近 0。 */
export function crossfireAngle(a: V3, b: V3, at: V3): number {
  const ax = a.x - at.x, az = a.z - at.z, bx = b.x - at.x, bz = b.z - at.z;
  const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
  if (la < .01 || lb < .01) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
}

/** 掩体点的水平遮挡方向，bit 0 = -Z，之后按顺时针每 45 度一格。 */
export interface CoverPoint {
  point: V3;
  /** 从该点向外射线被地图几何挡住的方向。 */
  blockedMask: number;
  /** 0..1，遮挡方向越多质量越高。 */
  quality: number;
}

/**
 * 安包后的守包点：从包点周围的掩体点里按角度均匀选一个，避免全队挤在包点中心。
 * 进攻方站外圈（4.5–14 m）看回防方向；防守方站内圈（2.5–9 m）掩护拆包。
 * 纯函数：返回 null 表示没有合适掩体，调用方退回包点中心。
 */
export function postPlantCoverPoints(
  center: V3,
  covers: readonly CoverPoint[],
  attacker: boolean,
): V3[] {
  const min = attacker ? 4.5 : 2.5;
  const max = attacker ? 14 : 9;
  // 每个 22.5° 扇区只留一个最好的点，避免同一方向不同半径的点把队伍又挤成一条线。
  const sectors = new Map<number, { point: V3; d: number; a: number; quality: number }>();
  for (const c of covers) {
    const d = Math.hypot(c.point.x - center.x, c.point.z - center.z);
    if (Math.abs(c.point.y - center.y) > 2.2 || d < min || d > max) continue;
    const a = Math.atan2(c.point.z - center.z, c.point.x - center.x);
    const key = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 16) % 16;
    const old = sectors.get(key);
    if (!old || c.quality > old.quality || (c.quality === old.quality && d < old.d))
      sectors.set(key, { point: c.point, d, a, quality: c.quality });
  }
  return [...sectors.values()].sort((a, b) => a.a - b.a).map((p) => p.point);
}

export function postPlantCoverPoint(
  center: V3,
  covers: readonly CoverPoint[],
  index: number,
  attacker: boolean,
): V3 | null {
  const points = postPlantCoverPoints(center, covers, attacker);
  if (!points.length) return null;
  return points[((index % points.length) + points.length) % points.length];
}

export interface BotSuppression {
  tick: number;
  /** 压制截止 tick，强度在 tick..until 之间线性衰减。 */
  until: number;
  /** 0..1，越接近弹道越高。 */
  intensity: number;
  source?: V3;
}

export interface SquadTactic {
  directive: 'support' | 'wait' | 'push';
  lane?: V3;
  ready: boolean;
  readyCount: number;
  required: number;
  /** 同一集结点最多等待到此 tick；防止单人等不到落后的队友。 */
  waitUntil?: number;
}

export interface UtilityInput {
  hp: number;
  mag: number;
  reserve: number;
  magazine: number;
  hasEnemy: boolean;
  distance: number | null;
  reloading: boolean;
  lowHealth: boolean;
  suppressed: number;
  coverAvailable: boolean;
  squad?: SquadTactic;
}

export interface UtilityScores {
  action: UtilityAction;
  scores: Record<UtilityAction, number>;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const flat = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.z - b.z);

/** 将威胁方向量化成与 CoverPoint.blockedMask 相同的 8 个方向。 */
export function directionBit(from: V3, threat: V3): number {
  const yaw = Math.atan2(threat.x - from.x, -(threat.z - from.z));
  const index = ((Math.round(yaw / (Math.PI / 4)) % 8) + 8) % 8;
  return 1 << index;
}

/** 计算候选掩体的综合得分：必须挡住威胁，优先近、质量高、不要贴队友。 */
export function scoreCover(from: V3, threat: V3, cover: CoverPoint, pathLength: number,
  teammateDistance = Infinity): number {
  const bit = directionBit(cover.point, threat);
  if (!(cover.blockedMask & bit) || !Number.isFinite(pathLength)) return -Infinity;
  const distanceScore = 1 / (1 + Math.max(0, pathLength));
  const crowdPenalty = teammateDistance < 1.2 ? .35 : 0;
  return cover.quality * 3.2 + distanceScore * 2.4 - crowdPenalty;
}

/**
 * 轻量效用 AI：分数是可解释的线性项，便于按难度 / 人格继续调参。
 * 分数不改变伤害，只决定当前意图；缺少战术上下文时自然退化为交战/推进。
 */
export function utility(input: UtilityInput): UtilityScores {
  const ammoLow = input.mag <= Math.max(1, Math.floor(input.magazine * .28));
  const suppressed = clamp01(input.suppressed);
  const wounded = clamp01((55 - input.hp) / 55);
  const distance = input.distance === null ? .35 : clamp01((input.distance - 5) / 35);
  const scores: Record<UtilityAction, number> = {
    engage: input.hasEnemy && input.mag > 0 && !input.reloading ? 2.2 + distance * .8 - wounded * .7 - suppressed * .8 : -Infinity,
    cover: input.coverAvailable ? .2 + suppressed * 2.2 + wounded * 1.8 + (input.reloading ? 2 : 0) : -1,
    retreat: input.coverAvailable ? wounded * 1.4 + suppressed * 1.2 - (input.hasEnemy ? 0 : .6) : -1,
    reload: input.reserve > 0 && (input.reloading || ammoLow) ? (input.mag === 0 ? 3.8 : input.hasEnemy ? 1.4 : 2.2) : -Infinity,
    push: input.hasEnemy ? .2 : .8,
    wait: !input.hasEnemy && input.squad?.directive === 'wait' ? 2.1 : -Infinity,
    peek: -Infinity, // 只由验证过的掩体探头窗口执行，不能仅凭敌人可见就侧移。
  };
  // 压制 / 换弹 / 残血时掩体优先；无敌人且未到齐时等待优先。
  if (input.coverAvailable && (input.reloading || suppressed >= .55 || input.lowHealth)) scores.cover += 1.5;
  if (input.lowHealth && !input.coverAvailable && input.hasEnemy) scores.retreat = 2.6;
  let action: UtilityAction = 'push', best = -Infinity;
  for (const [name, score] of Object.entries(scores) as [UtilityAction, number][]) {
    if (score > best) { best = score; action = name; }
  }
  return { action, scores };
}

/** 从攻击者位置到目标位置的点到线段距离（用于判断子弹是否掠过）。 */
export function pointSegmentDistance(point: V3, start: V3, end: V3): number {
  const p = closestSegmentPoint(point, start, end);
  return Math.hypot(point.x - p.x, point.y - p.y, point.z - p.z);
}

export function closestSegmentPoint(point: V3, start: V3, end: V3): V3 {
  const vx = end.x - start.x, vy = end.y - start.y, vz = end.z - start.z;
  const wx = point.x - start.x, wy = point.y - start.y, wz = point.z - start.z;
  const vv = vx * vx + vy * vy + vz * vz;
  const t = vv > 1e-6 ? Math.max(0, Math.min(1, (wx * vx + wy * vy + wz * vz) / vv)) : 0;
  return { x: start.x + vx * t, y: start.y + vy * t, z: start.z + vz * t };
}

/** 只有在目标已经露头且没有换弹时才允许一次短 peek。 */
export function canPeek(hasEnemy: boolean, reloading: boolean, suppressed: number, shots: number): boolean {
  return hasEnemy && !reloading && suppressed < .65 && shots < 2;
}

const DIRS = Array.from({ length: 8 }, (_, i) => {
  const a = i * Math.PI / 4;
  return { x: Math.sin(a), z: -Math.cos(a) };
});
const pop8 = (n: number) => {
  let count = 0;
  for (let i = 0; i < 8; i++) count += (n >> i) & 1;
  return count;
};

/**
 * 从出生点 / 包点附近的固定采样生成轻量掩体点图。
 * 结果由 coverGraphFor 按地图导航网格共享；没有有效几何时返回空数组。
 */
export function buildCoverGraph(world: BVH, nav: Pick<Nav, 'snap'>, seeds: readonly V3[], maxPoints = 384): CoverPoint[] {
  const points: CoverPoint[] = [];
  for (const _ of coverSamples(world, nav, seeds, points, maxPoints)) { /* 离线同步入口 */ }
  return points;
}

function* coverSamples(world: BVH, nav: Pick<Nav, 'snap'>, seeds: readonly V3[], points: CoverPoint[], maxPoints = 384): Generator<void> {
  const seen = new Set<string>();
  const radii = [1.5, 3.5, 6.5, 9.5];
  // 按方向与半径交错采样全部地标，不能让前几个出生点耗光预算。
  for (const radius of radii) {
    for (const dir of DIRS) {
      for (const seed of seeds) {
        if (points.length >= maxPoints) return;
        yield; // 每个样本是可让出事件循环的最小单位。
        const raw = { x: seed.x + dir.x * radius, y: seed.y, z: seed.z + dir.z * radius };
        const snapped = nav.snap(raw, 2.5, true);
        if (!snapped) continue;
        const key = `${Math.round(snapped.x * 2)}:${Math.round(snapped.y * 2)}:${Math.round(snapped.z * 2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let blockedMask = 0;
        for (let i = 0; i < DIRS.length; i++) {
          const d = DIRS[i];
          if ([1.2, 1.75].every(h => !!raycast(world, snapped.x, snapped.y + h, snapped.z, d.x, 0, d.z, 5))) blockedMask |= 1 << i;
        }
        if (blockedMask) points.push({ point: { x: snapped.x, y: snapped.y, z: snapped.z }, blockedMask, quality: pop8(blockedMask) / 8 });
      }
    }
  }
}

interface CoverCache { signature: string; points?: readonly CoverPoint[]; pending?: Promise<readonly CoverPoint[]> }
// 导航网格按地图常驻；世界几何必须作为弱键，不能被导航缓存反向持有。
const graphs = new WeakMap<object, WeakMap<BVH, CoverCache>>();
function graphCache(nav: object): WeakMap<BVH, CoverCache> {
  let cache = graphs.get(nav);
  if (!cache) graphs.set(nav, cache = new WeakMap());
  return cache;
}
/** 同一导航 / 几何 / 地标共享点图；导航重新加载或地标变化自动失效。 */
export function coverGraphFor(world: BVH, nav: Pick<Nav, 'snap' | 'path'>, seeds: readonly V3[]): readonly CoverPoint[] {
  const signature = JSON.stringify(seeds.map(p => [p.x, p.y, p.z]));
  const cache = graphCache(nav);
  const old = cache.get(world);
  if (old?.signature === signature && old.points) return old.points;
  const points: CoverPoint[] = [];
  for (const _ of coverJobs(world, nav, seeds, points)) { /* 离线同步入口 */ }
  cache.set(world, { signature, points });
  return points;
}

function* coverJobs(world: BVH, nav: Pick<Nav, 'snap' | 'path'>, seeds: readonly V3[], points: CoverPoint[]): Generator<void> {
  // 地标间的路径拐点补齐交战通道，最多 64 个采样中心。
  const centers = [...seeds];
  const unique = new Set(centers.map(p => `${Math.round(p.x / 3)}:${Math.round(p.y)}:${Math.round(p.z / 3)}`));
  for (let i = 0; i < seeds.length && centers.length < 64; i++) {
    const other = seeds[(i + Math.ceil(seeds.length / 2)) % seeds.length];
    yield;
    for (const p of nav.path(seeds[i], other, true) ?? []) {
      const key = `${Math.round(p.x / 3)}:${Math.round(p.y)}:${Math.round(p.z / 3)}`;
      if (unique.has(key)) continue;
      unique.add(key); centers.push(p);
      if (centers.length >= 64) break;
    }
  }
  yield* coverSamples(world, nav, centers, points);
}

/** 实时服务器入口：每批最多 16 个样本 / 约 1ms，批间让出事件循环；同图并发请求共享一个 Promise。 */
export function prepareCoverGraph(world: BVH, nav: Pick<Nav, 'snap' | 'path'>, seeds: readonly V3[]): Promise<readonly CoverPoint[]> {
  const signature = JSON.stringify(seeds.map(p => [p.x, p.y, p.z]));
  const cache = graphCache(nav);
  const old = cache.get(world);
  if (old?.signature === signature) {
    if (old.points) return Promise.resolve(old.points);
    if (old.pending) return old.pending;
  }
  const entry: CoverCache = { signature };
  cache.set(world, entry);
  entry.pending = (async () => {
    const points: CoverPoint[] = [];
    let start = performance.now(), count = 0;
    for (const _ of coverJobs(world, nav, seeds, points)) {
      if (++count >= 16 || performance.now() - start >= 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
        start = performance.now(); count = 0;
      }
    }
    entry.points = points; entry.pending = undefined;
    return points;
  })();
  entry.pending.catch(() => { if (cache.get(world) === entry) cache.delete(world); });
  return entry.pending;
}

export { flat as flatDistance };
