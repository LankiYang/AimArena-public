// 人机只产生命令；移动、弹药、命中、伤害和复活仍走玩家共用的权威系统。
// 人格决定职责与个体参数；可选战术上下文提供掩体 / 压制 / 集结，旧调用仍可运行。
import type { Difficulty, Team } from '../shared/catalog.ts';
import type { V3, WeaponId } from '../shared/combat.ts';
import { ARMOR, WEAPON_PRICES, type ArmorKind, type BuyItem } from '../shared/economy.ts';
import { BTN, quantPitch, quantYaw, type UserCmd } from '../shared/protocol.ts';
import { eyeHeight, type MoveState } from '../shared/sim/movement.ts';
import { TICK_DT, TICK_RATE } from '../shared/sim/tick.ts';
import { WEAPONS, WEAPON_ADS } from '../shared/sim/weapons.ts';
import { rayHuman } from '../shared/sim/ballistics.ts';
import { raycast, type BVH } from '../shared/world/bvh.ts';
import type { BotContact, BotContext, BotMission } from './bot-team.ts';
import type { BotPersona } from './bot-persona.ts';
import type { Nav } from './nav.ts';
import { nearestRope, type RopeDef } from '../shared/rope.ts';
import { canPeek, directionBit, pickTactic, retreatPoint, scoreCover, TACTICS, utility, zoneIndexFor, type TacticalState, type UtilityAction } from './bot-tactics.ts';
import type { BotCombatState } from './combat.ts';

// 每个 JS isolate 内的累计值；match 同步读取差值，不在热路径构造统计对象。
export const botSightMetrics = process.env.PERF_METER === '1' ? { rays: 0, ms: 0 } : null;

export interface BotActor { id: number; team: Team; alive: boolean; s: MoveState; yaw: number; pitch: number }
type BotNav = Pick<Nav, 'path' | 'randomPoint'> & Partial<Pick<Nav, 'randomAround' | 'snap' | 'pathEx' | 'ropes'>>;
type Mode = 'patrol' | 'search' | 'investigate' | 'support' | 'engage' | 'reposition' | 'cover' | 'recover' | 'mission'
  | 'rush' | 'hold' | 'lurk' | 'flank' | 'fallback' | 'wait' | 'peek'
  // 高级团队战术：T1 响应支援 / T2 撤退与补位 / T3 交叉火力 / 无事可做的待机
  | 'respond' | 'retreat' | 'crossfire' | 'fill' | 'idle'
  // 攀绳：正在爬绳（command 里的最高优先级分支）
  | 'rope';
/** 潜伏站位的阶段：接近侧翼 → 原地潜伏 → 绕入包点 → 守住 */
type Stage = 'idle' | 'approach' | 'lurk' | 'swing' | 'hold';
interface Tuning { reaction: number; error: number; turn: number; range: number; burst: number; pause: number; control: number }
// reaction / range / error 保留原难度；burst 改为实际扣弹数，不再用墙钟 tick 假装点射。
export const BOT_TUNING: Record<Difficulty, Tuning> = {
  easy:   { reaction: 24, error: .032, turn: 2.8, range: 28, burst: 2, pause: 24, control: .15 },
  normal: { reaction: 16, error: .018, turn: 4, range: 38, burst: 3, pause: 18, control: .45 },
  hard:   { reaction: 10, error: .009, turn: 5.2, range: 45, burst: 3, pause: 14, control: .65 },
  expert: { reaction: 6, error: .004, turn: 6, range: 50, burst: 4, pause: 12, control: .8 },
};
/** 到点后不做搜索的目的地（巡逻 / 冲点） */
const ROAM: ReadonlySet<Mode> = new Set<Mode>(['patrol', 'rush']);
/** 站位类目的地：失败或卡住时不记为“已调查过”的接触点。补位点也属站位：到了就停住，不触发搜索。 */
const POST: ReadonlySet<Mode> = new Set<Mode>(['rush', 'hold', 'flank', 'fallback', 'fill']);
const angle = (v: number) => v - Math.round(v / (2 * Math.PI)) * 2 * Math.PI;
const clamp = (v: number, n: number) => Math.max(-n, Math.min(n, v));
const flat = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.z - b.z);
const copy = (p: V3): V3 => ({ x: p.x, y: p.y, z: p.z });
const MOVING = BTN.forward | BTN.back | BTN.left | BTN.right;
const LOCAL_PATH_LIMITS = { maxPathPolys: 256, maxStraightPathPoints: 32 };
/** 绳索捷径的省时门槛（秒）：省不到这么多就不走绳（避免无效上下绳拖慢节奏） */
export const ROPE_MIN_SAVE = 0.5;
/** 判断「人就在绳索旁边」时把吸附半径放宽的倍数（还没贴上去时提前按前进也能直接吸附） */
const ROPE_NEAR_SCALE = 2;
const torso = (p: BotActor): V3 => ({ x: p.s.x, y: p.s.y + 1.15 - .3 * p.s.crouch, z: p.s.z });
/** 朝向某点的偏航角（与 look 同一约定：前向为 (-sin yaw, -cos yaw)） */
const yawTo = (from: V3, to: V3) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
/** 枪口高度到目标的距离（与开火判定同一高度） */
const rangeTo = (bot: BotActor, p: V3) => Math.hypot(p.x - bot.s.x, p.y - bot.s.y - eyeHeight(bot.s), p.z - bot.s.z);
/** 狙击：可开镜、非全自动、射速低 */
const isSniper = (id: WeaponId) => WEAPON_ADS[id] !== undefined && !WEAPONS[id].automatic && WEAPONS[id].rate < 3;
const isShotgun = (id: WeaponId) => WEAPONS[id].pelletsPerShot > 1;
/** 距离适配：狙击要远、霰弹要近、刀只在贴身。“保持”与“切入”用两个阈值，边界上不来回切枪。 */
const keepsFit = (id: WeaponId, d: number) => WEAPONS[id].melee ? d <= 2.2 : isSniper(id) ? d >= 8 : isShotgun(id) ? d <= 15 : true;
const entersFit = (id: WeaponId, d: number) => WEAPONS[id].melee ? d <= 2 : isSniper(id) ? d >= 10 : isShotgun(id) ? d <= 13 : true;

// 调用者可复用完全相同的端点距离；只在当前调用中传递，不能跨 tick 缓存视线。
function clearLine(world: BVH, a: V3, b: V3, distance?: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = distance ?? Math.hypot(dx, dy, dz);
  if (d < .01) return true;
  const started = botSightMetrics ? performance.now() : 0;
  const hit = raycast(world, a.x, a.y, a.z, dx / d, dy / d, dz / d, Math.max(0, d - .02));
  if (botSightMetrics) { botSightMetrics.rays++; botSightMetrics.ms += performance.now() - started; }
  return !hit;
}
function visiblePoint(bot: BotActor, target: BotActor, world: BVH, range: number): V3 | null {
  if (!bot.alive || !target.alive || bot.id === target.id || bot.team === target.team) return null;
  const eye = { x: bot.s.x, y: bot.s.y + eyeHeight(bot.s), z: bot.s.z }, body = torso(target);
  const d = Math.hypot(body.x - eye.x, body.y - eye.y, body.z - eye.z);
  if (d < .001 || d > range) return null;
  // 仍为 120° 视野；只在 2m 内允许周边察觉，听觉/报点不绕过此检查。
  if (d > 2 && Math.abs(angle(Math.atan2(eye.x - body.x, eye.z - body.z) - bot.yaw)) > Math.PI / 3) return null;
  if (clearLine(world, eye, body, d)) return body;
  const head = { x: body.x, y: target.s.y + 1.65 - .4 * target.s.crouch, z: body.z };
  return clearLine(world, eye, head) ? head : null;
}
export function canSee(bot: BotActor, target: BotActor, world: BVH, range: number): boolean {
  return visiblePoint(bot, target, world, range) !== null;
}

export class BotBrain {
  private seq = 0;
  private target: number | null = null;
  private seen: V3 | null = null;
  private seenTick = -Infinity;
  private readyAt = Infinity;
  private scanAt = 0;
  private heard: BotContact | null = null;
  private heardTick = -Infinity;
  private investigatedAt = -Infinity;
  private goal: V3 | null = null;
  private goalTick = -Infinity;
  private goalKind: Mode = 'patrol';
  private path: V3[] | null = null;
  private wp = 0;
  private repathAt = 0;
  private patrolCycle = 0;
  private pathFailures = 0;
  private searchUntil = 0;
  private coverUntil = 0;
  private coverPlanAt = 0;
  private retreatAt = 0;
  private evadeUntil = 0;
  private checkTick = 0;
  private checkPos: V3 | null = null;
  private moveTicks = 0;
  private wantedMove = false;
  private recoverUntil = 0;
  private jumpCooldown = 0;
  private stuck = 0;
  private ropeDirection: number = 0;
  private lastWeapon: WeaponId | null = null;
  private lastMag = 0;
  private shots = 0;
  private burstLimit = 3;
  private pauseUntil = 0;
  private triggerHeld = false;
  private mode: Mode = 'patrol';
  private tuning: Tuning;
  // 人格状态：没有人格时不启用职责站位。
  private persona: BotPersona | null;
  private retreatHp: number;
  private stage: Stage = 'idle';
  private stageTick = -Infinity;
  private flankPoint: V3 | null = null;
  private flankFor: V3 | null = null;
  private postSince = -Infinity;
  private onAlt = false;
  private wantWeapon: WeaponId | null = null;
  private lastUtility: UtilityAction = 'push';
  private peekUntil = 0;
  private peekShots = 0;
  private coverAnchor: V3 | null = null;
  private coverThreat: V3 | null = null;
  private peekPoint: V3 | null = null;
  private coverPhase: 'hidden' | 'expose' | 'return' | null = null;
  private coverHoldAt = 0;
  private acquiredTick = 0;
  private coverGraphCursor = 0;
  private coverFallbackCursor = 0;
  private peekCursor = 0;
  private metrics = { coverPlans: 0, graphCoverPlans: 0, peekCycles: 0, peekRounds: 0, waitTicks: 0, suppressedTicks: 0, ropePlans: 0, ropeRejected: 0 };
  // 高级团队战术的状态与计数：requests = T1 广播次数，responds = T1 响应次数，retreats = T2 撤退次数，
  // fills = T2 补位次数，crossfire = T3 交叉火力进入次数，zonePatrols = T1 默认点位选取次数。
  // 状态机按 pickTactic 的优先级选行为：撤退 > 掩体/补位 > 交叉火力 > 交战 > 支援响应 > 任务 > 巡逻。
  private tacticState: TacticalState = 'patrol';
  private previousTactic: TacticalState = 'patrol';
  private zoneName: string | null = null;
  private tactics = { requests: 0, responds: 0, retreats: 0, fills: 0, crossfire: 0, zonePatrols: 0 };
  private requestAt = 0;
  private retreatTarget: V3 | null = null;
  private crossfire: { role: 'push' | 'hold'; enemy: number; angle: number } | null = null;
  private respondPoint: V3 | null = null;
  private fillFor = -1;
  private fillPoint: V3 | null = null;
  private fillUntil = 0;

  constructor(difficulty: Difficulty, persona: BotPersona | null = null) {
    this.tuning = BOT_TUNING[difficulty];
    this.persona = persona;
    this.retreatHp = persona ? 25 + 20 * persona.caution : 35;
  }

  /** 人格（只读）；没有人格时为 null */
  personaOf(): BotPersona | null { return this.persona; }

  /** match 在下一次 command 前读取：人格要求换到的武器（null = 维持当前武器） */
  wantedWeapon(): WeaponId | null { return this.wantWeapon; }

  reset(): void {
    this.target = null; this.seen = null; this.seenTick = -Infinity; this.readyAt = Infinity;
    this.heard = null; this.heardTick = this.investigatedAt = -Infinity;
    this.scanAt = 0; this.goal = null; this.path = null; this.wp = 0; this.repathAt = 0;
    this.goalTick = -Infinity; this.goalKind = this.mode = 'patrol';
    this.patrolCycle = this.pathFailures = this.searchUntil = 0;
    this.coverUntil = this.coverPlanAt = this.retreatAt = this.evadeUntil = 0;
    this.checkTick = 0; this.checkPos = null; this.moveTicks = 0; this.wantedMove = false;
    this.recoverUntil = this.jumpCooldown = this.stuck = 0;
    this.ropeDirection = 0;
    this.lastWeapon = null; this.lastMag = this.shots = this.pauseUntil = 0; this.triggerHeld = false;
    this.stage = 'idle'; this.stageTick = -Infinity; this.flankPoint = this.flankFor = null;
    this.postSince = -Infinity; this.onAlt = false; this.wantWeapon = null;
    this.lastUtility = 'push'; this.peekUntil = this.peekShots = this.coverHoldAt = this.acquiredTick = 0;
    this.coverAnchor = this.coverThreat = this.peekPoint = null; this.coverPhase = null;
    this.coverGraphCursor = this.coverFallbackCursor = this.peekCursor = 0;
    this.tacticState = this.previousTactic = 'patrol'; this.zoneName = null;
    this.requestAt = this.fillUntil = 0; this.respondPoint = this.fillPoint = null;
    this.retreatTarget = this.crossfire = null; this.fillFor = -1;
    // 命令序号跨死亡保持单调。
  }

  /** 只读诊断给离线回归使用；不向客户端传敌方情报。 */
  debug() { return { mode: this.mode, target: this.target, goal: this.goal ? copy(this.goal) : null,
    waypoint: this.wp, stuck: this.stuck, seenTick: this.seenTick,
    role: this.persona?.role ?? null, stage: this.stage, weaponIntent: this.wantWeapon,
    utility: this.lastUtility, peekShots: this.peekShots, coverPhase: this.coverPhase, metrics: { ...this.metrics },
    tactic: this.tacticState, tactics: { ...this.tactics }, zone: this.zoneName,
    crossfire: this.crossfire ? { ...this.crossfire } : null,
    retreatTarget: this.retreatTarget ? copy(this.retreatTarget) : null,
    respondPoint: this.respondPoint ? copy(this.respondPoint) : null,
    fillPoint: this.fillPoint ? copy(this.fillPoint) : null }; }

  command(bot: BotActor, actors: readonly BotActor[], tick: number, frozen: boolean,
    world: BVH, nav: BotNav | null, weapon: BotCombatState, patrol: V3, context: BotContext = {}): UserCmd {
    const cmd: UserCmd = { seq: ++this.seq, buttons: 0, yaw: bot.yaw, pitch: bot.pitch, viewTick: 0 };
    if (frozen || !bot.alive) { this.reset(); return cmd; }
    this.wantedMove = false;
    // 攀绳：挂在绳上时只给「上 / 下」（前 = 上、后 = 下），到端点自动脱离；
    // 不管当前在什么模式都先把手上的绳爬完，不会挂在半空中不动。
    if (bot.s.rope >= 0) {
      if (!this.ropeDirection) this.ropeDirection = bot.s.ropeT > .5 ? -1 : 1;
      cmd.buttons |= this.ropeDirection < 0 ? BTN.back : BTN.forward;
      this.mode = 'rope';
      this.wantedMove = true;
      return cmd;
    }
    this.ropeDirection = 0;
    if (this.jumpCooldown > 0) this.jumpCooldown--;
    const cfg = this.tuning, def = WEAPONS[weapon.weapon], persona = this.persona;
    if (context.strategy === 'infected')
      return this.commandInfected(cmd, bot, actors, tick, world, nav, weapon, patrol, context);
    // 炸弹将爆 / 已经在拆：拆包优先于对枪和找掩体，不能因为看见敌人把读条重置掉
    const urgentMission = context.mission;
    if (urgentMission?.use && urgentMission.urgent) {
      this.mode = 'mission';
      this.goal = null;
      this.path = null;
      if (!this.atMission(bot, urgentMission.point)) {
        this.setGoal(urgentMission.point, 'mission', tick, tick);
        if (nav) this.follow(cmd, bot, actors, tick, world, nav, context, true);
        else this.move(cmd, bot, actors, urgentMission.point.x - bot.s.x, urgentMission.point.z - bot.s.z, world, context);
      } else {
        cmd.buttons |= BTN.use;
        this.look(cmd, bot, urgentMission.face ?? urgentMission.point, cfg.turn);
      }
      return this.finish(cmd, bot, tick);
    }
    if (this.lastWeapon !== weapon.weapon) { this.shots = 0; this.pauseUntil = 0; this.triggerHeld = false; }
    else if (weapon.mag < this.lastMag) {
      const spent = this.lastMag - weapon.mag;
      this.shots += spent;
      if (this.coverPhase === 'expose') { this.peekShots += spent; this.metrics.peekRounds += spent; }
      if (this.shots >= this.burstLimit) { this.pauseUntil = tick + cfg.pause; this.shots = 0; }
    }
    this.lastWeapon = weapon.weapon; this.lastMag = weapon.mag;

    const { enemy, point } = this.acquireTarget(bot, actors, tick, world, context);
    // 人格的换枪意图：狙击 / 霰弹 / 刀按距离切换，脱战后回主武器（由 match 走同一套换枪流程）
    this.wantWeapon = persona ? this.chooseWeapon(weapon, enemy && point ? rangeTo(bot, point) : null, tick) : null;

    if (!enemy) this.listen(bot, tick, world, context);
    const reloading = weapon.reloadUntil > tick;
    const quiet = tick - Math.max(this.seenTick, this.heardTick) > TICK_RATE;
    if (!def.melee && weapon.reserve > 0 && !reloading && weapon.equipUntil <= tick &&
        (weapon.mag === 0 || (!enemy && quiet && weapon.mag <= Math.min(8, Math.floor(def.magazine * .28))))) cmd.buttons |= BTN.reload;

    // 先使用自己已观察到的威胁位置规划掩体；找不到真实可达的遮挡就退移，不凭空穿墙。
    const threat = enemy && point ? point : this.seen && tick - this.seenTick < 2 * TICK_RATE
      ? { ...this.seen, y: this.seen.y + 1.3 }
      : context.suppression?.source && context.suppression.until > tick ? context.suppression.source : null;
    // —— 高级团队战术 T1/T2/T3：先把本 tick 的处境算清楚，再交给状态机 ——
    // T3：上报本 tick 的交战目标，供同一敌人的交叉火力配对（没有敌人时清掉自己的认领）。
    context.claimTarget?.(enemy && point ? this.target : null, point ?? undefined);
    // T2：上报当前掩体点；阵亡后由最近的存活队友前移接管。
    context.reportAnchor?.(this.coverAnchor);
    // T1：血量低于 50 且有可见敌人时广播「请求支援」（有节流，不刷屏）。
    if (weapon.hp < TACTICS.requestHp && enemy && point && tick >= this.requestAt) {
      this.requestAt = tick + Math.round(TACTICS.requestTicks / 4);
      context.requestSupport?.(copy(point));
      this.tactics.requests++;
    }
    // T2：残血且能算出队友身后时就撤退；没有队友或没有威胁时不进入撤退（仍按原有掩体 / 交战逻辑打）。
    this.retreatTarget = null;
    if (weapon.hp < TACTICS.retreatHp && threat) {
      const mates: V3[] = [];
      for (const a of actors) if (a.id !== bot.id && a.alive && a.team === bot.team) mates.push(a.s);
      if (mates.length) this.retreatTarget = retreatPoint(mates, threat);
    }
    this.crossfire = context.crossfire && enemy && point
      ? { role: context.crossfire.role, enemy: context.crossfire.enemy, angle: context.crossfire.angle } : null;
    const lowHealthRetreat = !!enemy && weapon.hp <= this.retreatHp && tick >= this.retreatAt;
    const suppression = context.suppression && context.suppression.until > tick ? context.suppression.intensity : 0;
    if (suppression > .05) this.metrics.suppressedTicks++;
    const vulnerable = !def.melee && (reloading || !!(cmd.buttons & BTN.reload) || lowHealthRetreat || tick < this.evadeUntil || suppression >= .45);
    const tactical = utility({
      hp: weapon.hp, mag: def.melee ? 1 : weapon.mag, reserve: weapon.reserve, magazine: def.magazine,
      hasEnemy: !!enemy && !!point, distance: enemy && point ? rangeTo(bot, point) : null,
      reloading, lowHealth: lowHealthRetreat, suppressed: suppression,
      coverAvailable: !!nav && !!threat, squad: context.squad,
    });
    this.lastUtility = tactical.action;
    if (!def.melee && tactical.action === 'reload' && weapon.equipUntil <= tick && !reloading) cmd.buttons |= BTN.reload;
    const seekCover = !def.melee && (vulnerable || tactical.action === 'cover' || tactical.action === 'retreat');
    // 状态机：每 tick 按优先级选一个行为（撤退 > 掩体/补位 > 交叉火力 > 交战 > 支援响应 > 任务 > 巡逻）。
    this.tacticState = pickTactic({
      retreat: !!this.retreatTarget,
      cover: (seekCover && !!threat) || (!enemy && !!context.vacancy),
      enemy: !!enemy && !!point,
      crossfire: !!this.crossfire,
      support: !!context.support && !context.mission?.use,
      mission: !!context.mission,
    });
    if (this.tacticState !== this.previousTactic) {
      if (this.tacticState === 'retreat') this.tactics.retreats++;
      else if (this.tacticState === 'crossfire') this.tactics.crossfire++;
      else if (this.tacticState === 'respond') this.tactics.responds++;
      this.previousTactic = this.tacticState;
    }
    // 撤退优先于继续占掩体：进入撤退时先退出掩体循环，改向队友身后移动。
    if (this.tacticState === 'retreat' && this.coverAnchor) this.leaveCover(tick);
    if (this.tacticState === 'cover' && seekCover && threat && nav && tick >= this.coverPlanAt && !this.coverAnchor &&
        (!context.work || context.work.planSlot(bot.id, tick))) {
      this.coverPlanAt = tick + 24;
      const route = this.findCover(bot, actors, threat, world, nav, context);
      if (route === undefined) this.coverPlanAt = tick + 1;
      if (route) {
        this.goal = copy(route[route.length - 1]); this.path = route; this.wp = 0; this.goalKind = 'cover';
        this.coverAnchor = copy(this.goal); this.coverThreat = copy(threat); this.coverPhase = 'hidden';
        this.coverGraphCursor = this.coverFallbackCursor = this.peekCursor = 0;
        this.coverHoldAt = this.peekUntil = this.peekShots = 0; this.peekPoint = null;
        this.coverUntil = tick + 5 * TICK_RATE;
        this.metrics.coverPlans++;
        this.retreatAt = tick + 4 * TICK_RATE;
      }
    }
    if (lowHealthRetreat && !this.coverAnchor) {
      this.evadeUntil = tick + 12; this.retreatAt = tick + 4 * TICK_RATE;
    }
    if (this.tacticState !== 'retreat' && this.coverAnchor &&
        this.coverStep(cmd, bot, actors, tick, world, nav, context, !!enemy && !!point, reloading, suppression)) {
      return this.finish(cmd, bot, tick);
    }

    if (enemy && point) {
      this.mode = this.coverPhase === 'expose' ? 'peek' : this.tacticState === 'retreat' ? 'retreat'
        : this.tacticState === 'crossfire' ? 'crossfire' : 'engage';
      // 人格：被两人以上压制、队友在 30 m 内，且残血或被三人以上围住时，边打边向队友靠拢（刀与冲点手不适用）
      const regroup = persona && nav && !def.melee && this.coverPhase !== 'expose' ? this.regroupPoint(bot, actors, world, cfg.range, weapon) : null;
      if (!def.melee && !regroup) { this.goal = null; this.path = null; this.repathAt = tick; }
      const { dx, dz, distance, wantYaw, wantPitch, friend } =
        this.aimAt(cmd, bot, actors, point, tick, weapon, suppression);
      const side = persona ? persona.strafe : Math.abs(bot.id) % 2 ? 1 : -1;
      const sniper = !!persona && isSniper(weapon.weapon);
      // 移动层按状态机优先级：T2 撤退 → 近战追击 → 人格回撑 → T3 交叉火力 → 原有点射间隙换位。
      if (this.tacticState === 'retreat' && this.retreatTarget) {
        // T2：向队友身后的撤退点后退；已经退到那条线之后（比撤退点更远离敌人）就原地架枪，
        // 不再往敌人方向走，也不会长距离逃跑不还击。
        this.mode = 'retreat';
        const back = this.retreatTarget, threatPoint = threat!;
        const line = Math.hypot(back.x - threatPoint.x, back.z - threatPoint.z);
        const mine = Math.hypot(bot.s.x - threatPoint.x, bot.s.z - threatPoint.z);
        if (line > mine - .5) this.move(cmd, bot, actors, back.x - bot.s.x, back.z - bot.s.z, world, context);
        else { this.goal = null; this.path = null; }
      }
      else if (def.melee && distance > 1.7) {
        if (nav) { this.setGoal(enemy.s, 'engage', tick, tick); this.follow(cmd, bot, actors, tick, world, nav, context, true); }
        else this.move(cmd, bot, actors, dx, dz, world, context);
      }
      else if (regroup && nav) {
        this.mode = 'fallback';
        this.setGoal(regroup, 'fallback', tick, tick);
        this.follow(cmd, bot, actors, tick, world, nav, context, true);
      }
      else if (this.tacticState === 'crossfire' && this.crossfire) {
        // T3：前压手只在点射间隙前压，架枪手原地不动维持自己的角度；两人始终打同一个敌人。
        this.mode = 'crossfire';
        if (this.crossfire.role === 'push' && tick < this.pauseUntil - 7 && tick >= this.readyAt)
          this.move(cmd, bot, actors, dx, dz, world, context);
        else { this.goal = null; this.path = null; }
      }
      else if (this.coverPhase !== 'expose' && (vulnerable || friend || (tick < this.pauseUntil - 7 && tick >= this.readyAt))) {
        this.mode = 'reposition';
        // 点射间隙才横移；最后 7 tick 留给刹车和精度恢复。换弹时稍向后退。
        const back = vulnerable || distance < 6 ? .6 : 0;
        this.move(cmd, bot, actors, Math.cos(cmd.yaw) * side + Math.sin(cmd.yaw) * back,
          -Math.sin(cmd.yaw) * side + Math.cos(cmd.yaw) * back, world, context);
      }
      const aligned = Math.abs(angle(wantYaw - cmd.yaw)) < .04 && Math.abs(wantPitch - cmd.pitch) < .04;
      const settled = def.melee || (bot.s.grounded && Math.hypot(bot.s.vx, bot.s.vz) < .75 && !(cmd.buttons & MOVING));
      const available = !reloading && weapon.equipUntil <= tick && (def.melee || weapon.mag > 0);
      const semiReady = def.automatic || (!this.triggerHeld && tick >= weapon.nextFireTick);
      // 人格：可开镜的武器在远距离按住瞄准键（缩放与精度由权威武器系统结算）；狙击远距离必须开镜后才开火
      if (persona && WEAPON_ADS[weapon.weapon] && !vulnerable && (distance > 12 || (sniper && distance > 5))) cmd.buttons |= BTN.aim;
      const scopeReady = !sniper || distance <= 5 || weapon.aim;
      if (tick >= this.readyAt && tick >= this.pauseUntil && aligned && settled && available && semiReady && scopeReady &&
          !friend && (def.melee ? distance < 1.9 : true)) {
        cmd.buttons |= BTN.fire;
        this.burstLimit = this.coverPhase === 'expose' ? 2 : distance > 20 ? Math.min(2, cfg.burst) : distance < 7 ? cfg.burst + 1 : cfg.burst;
      }
      return this.finish(cmd, bot, tick);
    }

    cmd.pitch = quantPitch(bot.pitch + clamp(-bot.pitch, 3 * TICK_DT));
    // T1 响应支援：无可见敌人且收到队友「请求支援」时，直线走向请求者。
    // T1 不查导航：距离直接用水平直线判定，不占用掩体 / 探头的查询额度。
    const support = context.support;
    if (this.tacticState === 'respond' && support && !context.mission?.use) {
      this.mode = 'respond'; this.goal = null; this.path = null;
      this.respondPoint = copy(support.point);
      this.look(cmd, bot, { ...support.point, y: support.point.y + 1.2 }, cfg.turn);
      if (flat(bot.s, support.point) > 1.6 || Math.abs(bot.s.y - support.point.y) > 1.2)
        this.move(cmd, bot, actors, support.point.x - bot.s.x, support.point.z - bot.s.z, world, context);
      return this.finish(cmd, bot, tick);
    }
    this.respondPoint = null;
    // T2 补位：接下一个新空缺；到位后原地守住，空缺过期就恢复常规行为。
    if (context.vacancy && this.fillFor !== context.vacancy.forId) {
      this.fillFor = context.vacancy.forId; this.fillPoint = copy(context.vacancy.point);
      this.fillUntil = 0; this.tactics.fills++;
    }
    if (this.fillFor >= 0 && this.fillPoint) {
      if (flat(bot.s, this.fillPoint) <= 1.6 && Math.abs(bot.s.y - this.fillPoint.y) <= 1.2) {
        if (!this.fillUntil) this.fillUntil = tick + 3 * TICK_RATE;
      }
      if (this.fillUntil && tick >= this.fillUntil) { this.fillFor = -1; this.fillPoint = null; this.fillUntil = 0; }
      else if (!context.vacancy && !this.fillUntil) this.fillUntil = tick + TICK_RATE;
    }
    if (this.fillUntil && this.fillFor >= 0) {
      this.mode = 'fill'; this.tacticState = 'cover'; this.goal = null; this.path = null;
      if (this.seen) this.look(cmd, bot, { ...this.seen, y: this.seen.y + 1.3 }, cfg.turn);
      return this.finish(cmd, bot, tick);
    }
    // 有队友已到集结线时，先在原地等一拍；第二人到位后 squad directive 变为 push。
    if (tactical.action === 'wait' && context.squad?.lane && !context.mission?.use && context.mission?.kind !== 'pickup') {
      this.mode = 'wait'; this.goal = null; this.path = null;
      this.metrics.waitTicks++;
      this.look(cmd, bot, { ...context.squad.lane, y: context.squad.lane.y + 1.3 }, cfg.turn);
      return this.finish(cmd, bot, tick);
    }
    // 爆破任务：已到包点 / 包旁即站定，按住使用键读条（安放 / 拆除）；交战分支在上面已优先
    const mission = context.mission;
    if (mission?.use && this.atMission(bot, mission.point)) {
      this.mode = 'mission'; this.goal = null; this.path = null;
      cmd.buttons |= BTN.use;
      this.look(cmd, bot, mission.face ?? mission.point, cfg.turn);
      return this.finish(cmd, bot, tick);
    }
    // 人格：守点手守的点（主点 / 备选点轮换；爆破守包时守包点）；超出守点范围的报点不去救
    const post = persona?.role === 'anchor' ? this.anchorPost(tick, context, mission) : null;
    // 潜伏手在侧翼埋伏（空闲 / 接近 / 潜伏）时先按站位走：队友报点与远处枚声不把人拉走，只通过 lurkStep 的 alarm 绕入
    if (persona?.role === 'lurker' && this.stage !== 'swing' && this.stage !== 'hold' && tick >= this.searchUntil
      && this.roleStep(cmd, bot, tick, nav, context, patrol, mission, post)) {
      if (nav && this.goal) this.follow(cmd, bot, actors, tick, world, nav, context, false);
      return this.finish(cmd, bot, tick);
    }
    const contacts: { contact: BotContact; kind: Mode }[] = [];
    if (this.seen && tick - this.seenTick < 3 * TICK_RATE) contacts.push({ contact: { point: this.seen, tick: this.seenTick }, kind: 'search' });
    if (this.heard && tick - this.heard.tick < 2 * TICK_RATE) contacts.push({ contact: this.heard, kind: 'investigate' });
    if (context.contact && context.contact.tick < tick && tick - context.contact.tick <= 3 * TICK_RATE)
      contacts.push({ contact: context.contact, kind: 'support' });
    contacts.sort((a, b) => b.contact.tick - a.contact.tick);
    const interest = contacts.find(c => c.contact.tick > this.investigatedAt && (!post || flat(c.contact.point, post) <= 14));
    let roled = false;
    if (interest) {
      const g = copy(interest.contact.point);
      if (interest.kind === 'support') {
        // 接应从不同侧翼靠近报点，避免全队挤在同一条射线上。
        const d = Math.max(1, flat(bot.s, g)), side = (persona ? persona.strafe : Math.abs(bot.id) % 2 ? 1 : -1) * 2;
        g.x += (bot.s.z - interest.contact.point.z) / d * side;
        g.z -= (bot.s.x - interest.contact.point.x) / d * side;
      }
      this.setGoal(g, interest.kind, interest.contact.tick, tick);
      this.look(cmd, bot, { ...interest.contact.point, y: interest.contact.point.y + 1.3 }, cfg.turn);
    } else if (tick < this.searchUntil) {
      this.mode = 'search';
      if (persona && persona.jiggle >= .5) {
        // 人格：探头横移，视角看向最后见到敌人的位置，左右每 16 tick 交替
        if (this.seen) this.look(cmd, bot, { ...this.seen, y: this.seen.y + 1.3 }, cfg.turn);
        const s = ((tick >> 4) & 1 ? 1 : -1) * persona.strafe;
        this.move(cmd, bot, actors, Math.cos(cmd.yaw) * s, -Math.sin(cmd.yaw) * s, world, context);
      } else cmd.yaw = quantYaw(bot.yaw + (persona ? persona.strafe : Math.abs(bot.id) % 2 ? 1 : -1) * 2.5 * TICK_DT);
      return this.finish(cmd, bot, tick);
    } else if (this.roleStep(cmd, bot, tick, nav, context, patrol, mission, post)) {
      roled = true;
    } else if (mission) {
      // 爆破任务：走到任务点即站定（不去巡逻）；到位后按任务给的朝向看敌方来路 / 包点
      if (this.atMission(bot, mission.point)) {
        this.goal = null; this.path = null; this.mode = 'mission';
        this.look(cmd, bot, mission.face ?? mission.point, cfg.turn);
      } else this.setGoal(mission.point, 'mission', tick, tick);
    } else if (this.fillFor >= 0 && this.fillPoint) {
      // T2 补位：走到阵亡队友的最后掩体点；路径查询走与掩体 / 探头同一份预算（不新增额度）。
      this.mode = 'fill'; this.tacticState = 'cover';
      this.setGoal(this.fillPoint, 'fill', tick, tick);
    } else if (!this.goal || !ROAM.has(this.goalKind)) {
      const next = this.nextPatrol(bot, patrol, context, nav);
      if (next) { this.setGoal(next, persona?.role === 'entry' ? 'rush' : 'patrol', tick, tick); this.patrolCycle++; }
    }
    if (!roled) this.mode = this.goalKind;
    // 无敌人、无接触、无任务也没有可选巡逻点时才是待机。
    if (!roled && !this.goal && this.tacticState === 'patrol') { this.mode = 'idle'; this.tacticState = 'idle'; }
    if (nav && this.goal) this.follow(cmd, bot, actors, tick, world, nav, context, !!interest);
    return this.finish(cmd, bot, tick);
  }

  /** 两种策略共用感知与目标记忆，不使用墙后目标的实时位置。 */
  private acquireTarget(bot: BotActor, actors: readonly BotActor[], tick: number, world: BVH, context: BotContext) {
    const cfg = this.tuning, persona = this.persona;
    let enemy = actors.find(p => p.id === this.target), point = enemy ? visiblePoint(bot, enemy, world, cfg.range) : null;
    if (enemy && !enemy.alive) { this.target = null; enemy = undefined; this.readyAt = Infinity; }
    if (!point) enemy = undefined;
    if (tick >= this.scanAt) {
      this.scanAt = tick + (this.scanAt === 0 && context.work ? 1 + Math.abs(bot.id) % 4 : 4);
      let best = enemy, bestPoint = point, score = enemy ? flat(bot.s, enemy.s) * .65 : Infinity;
      for (const candidate of actors) {
        if (candidate.id === this.target || candidate.id === bot.id || !candidate.alive || candidate.team === bot.team) continue;
        const d = flat(bot.s, candidate.s);
        if (d >= score) continue;
        const p = visiblePoint(bot, candidate, world, cfg.range);
        if (p) { best = candidate; bestPoint = p; score = d; }
      }
      enemy = best; point = bestPoint;
    }
    if (enemy && point) {
      if (this.target !== enemy.id || tick - this.seenTick > 24) {
        this.readyAt = tick + (persona ? Math.round(cfg.reaction * persona.reaction) : cfg.reaction);
        this.acquiredTick = tick;
        this.shots = 0; this.pauseUntil = 0;
      }
      this.target = enemy.id; this.seen = copy(enemy.s); this.seenTick = tick;
      context.report?.(this.seen);
    } else if (tick - this.seenTick > 3 * TICK_RATE) this.target = null;
    return { enemy, point };
  }

  /** 瞄准误差、转向速度及队友挡线规则与战术策略共用。 */
  private aimAt(cmd: UserCmd, bot: BotActor, actors: readonly BotActor[], point: V3, tick: number,
    weapon: BotCombatState, suppression: number) {
    const cfg = this.tuning, persona = this.persona;
    const dx = point.x - bot.s.x, dz = point.z - bot.s.z, dy = point.y - bot.s.y - eyeHeight(bot.s);
    const distance = Math.hypot(dx, dy, dz), phase = tick / TICK_RATE;
    const recoilYaw = weapon.shotYaw, recoilPitch = weapon.shotPitch;
    const tracking = 1 + .7 * Math.exp(-(tick - this.acquiredTick) / (TICK_RATE * .55));
    const err = cfg.error * (persona ? persona.wobble : 1) * tracking * (1 + suppression * .9);
    const jitterA = persona ? persona.wobblePhase : bot.id * 1.7, jitterB = persona ? persona.wobblePhase * .6 : bot.id;
    const wantYaw = Math.atan2(-dx, -dz) + Math.sin(phase * 2.1 + jitterA) * err - clamp(recoilYaw, .12) * cfg.control;
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz)) + Math.cos(phase * 1.7 + jitterB) * err * .65 - clamp(recoilPitch, .15) * cfg.control;
    cmd.yaw = quantYaw(bot.yaw + clamp(angle(wantYaw - bot.yaw), cfg.turn * TICK_DT));
    cmd.pitch = quantPitch(bot.pitch + clamp(wantPitch - bot.pitch, cfg.turn * TICK_DT));
    const shotYaw = cmd.yaw + recoilYaw, shotPitch = cmd.pitch + recoilPitch, cp = Math.cos(shotPitch);
    const sx = -Math.sin(shotYaw) * cp, sy = Math.sin(shotPitch), sz = -Math.cos(shotYaw) * cp;
    const friend = actors.find(p => p.id !== bot.id && p.team === bot.team && p.alive &&
      rayHuman(bot.s.x, bot.s.y + eyeHeight(bot.s), bot.s.z, sx, sy, sz, distance, p.s));
    return { dx, dz, distance, wantYaw, wantPitch, friend };
  }

  /** 感染者策略：目击时追击，否则调查已知线索或跨区域巡游。 */
  private commandInfected(cmd: UserCmd, bot: BotActor, actors: readonly BotActor[], tick: number,
    world: BVH, nav: BotNav | null, weapon: BotCombatState, patrol: V3, context: BotContext): UserCmd {
    this.wantWeapon = null;
    const { enemy, point } = this.acquireTarget(bot, actors, tick, world, context);
    if (enemy && point) {
      this.mode = 'engage';
      const suppression = context.suppression && context.suppression.until > tick ? context.suppression.intensity : 0;
      const { dx, dz, distance, wantYaw, wantPitch, friend } =
        this.aimAt(cmd, bot, actors, point, tick, weapon, suppression);
      if (distance > 1.7) {
        if (nav) { this.setGoal(enemy.s, 'engage', tick, tick); this.follow(cmd, bot, actors, tick, world, nav, context, true); }
        else this.move(cmd, bot, actors, dx, dz, world, context);
      }
      const aligned = Math.abs(angle(wantYaw - cmd.yaw)) < .04 && Math.abs(wantPitch - cmd.pitch) < .04;
      if (WEAPONS[weapon.weapon].melee && weapon.equipUntil <= tick && tick >= this.readyAt &&
          tick >= weapon.nextFireTick && !this.triggerHeld && aligned && !friend && distance < 1.9)
        cmd.buttons |= BTN.fire;
      return this.finish(cmd, bot, tick);
    }
    this.listen(bot, tick, world, context);
    let interest: BotContact | null = this.seen && tick - this.seenTick < 3 * TICK_RATE
      ? { point: this.seen, tick: this.seenTick } : null;
    if (this.heard && tick - this.heard.tick < 2 * TICK_RATE && this.heard.tick > (interest?.tick ?? -Infinity))
      interest = this.heard;
    if (context.contact && context.contact.tick < tick && tick - context.contact.tick <= 3 * TICK_RATE &&
        context.contact.tick > (interest?.tick ?? -Infinity)) interest = context.contact;
    if (interest && interest.tick > this.investigatedAt) {
      this.setGoal(interest.point, 'search', interest.tick, tick);
    } else if (!this.goal || !ROAM.has(this.goalKind)) {
      const next = this.nextInfectedPatrol(bot, patrol, context, nav);
      if (next) { this.setGoal(next, 'patrol', tick, tick); this.patrolCycle++; }
    }
    this.mode = this.goalKind;
    if (this.goal) {
      if (nav) this.follow(cmd, bot, actors, tick, world, nav, context, false);
      else if (flat(bot.s, this.goal) < .48 && Math.abs(bot.s.y - this.goal.y) < .8) {
        if (!ROAM.has(this.goalKind)) this.investigatedAt = Math.max(this.investigatedAt, this.goalTick);
        this.goal = null;
      } else {
        this.look(cmd, bot, { ...this.goal, y: this.goal.y + 1.2 }, this.tuning.turn);
        this.move(cmd, bot, actors, this.goal.x - bot.s.x, this.goal.z - bot.s.z, world, context);
      }
    }
    return this.finish(cmd, bot, tick);
  }

  private nextInfectedPatrol(bot: BotActor, patrol: V3, context: BotContext, nav: BotNav | null): V3 | null | undefined {
    const zones = context.zones;
    if (zones?.length) {
      const base = zoneIndexFor(bot.id, this.persona?.site ?? -1, zones.length);
      for (let i = 0; i < zones.length; i++) {
        const zone = zones[(base + this.patrolCycle + i) % zones.length];
        if (!zone.points.length) continue;
        this.zoneName = zone.name;
        const cycle = Math.floor(this.patrolCycle / zones.length);
        return copy(zone.points[(cycle + Math.abs(bot.id)) % zone.points.length]);
      }
    }
    if (context.patrols?.length) return copy(context.patrols[(Math.abs(bot.id) + this.patrolCycle) % context.patrols.length]);
    return nav?.randomAround?.(patrol, 12, true) ?? nav?.randomPoint(true) ?? copy(patrol);
  }

  private listen(bot: BotActor, tick: number, world: BVH, context: BotContext): void {
    for (const sound of context.sounds ?? []) {
      if (sound.team === bot.team || sound.shooter === bot.id || sound.tick <= this.heardTick || sound.tick > tick || tick - sound.tick > 2 * TICK_RATE) continue;
      const d = flat(bot.s, sound.point);
      if (d > sound.radius) continue;
      const eye = { x: bot.s.x, y: bot.s.y + eyeHeight(bot.s), z: bot.s.z };
      if (d > sound.radius * .38 && !clearLine(world, eye, { ...sound.point, y: sound.point.y + 1.5 })) continue;
      this.heard = { point: copy(sound.point), tick: sound.tick }; this.heardTick = sound.tick;
    }
  }

  /** 爆破任务点：水平 1.6 m、高度差 1.2 m 以内算到位（服务器捉包 / 包点判定留有余量） */
  private atMission(bot: BotActor, point: V3): boolean {
    return flat(bot.s, point) <= 1.6 && Math.abs(bot.s.y - point.y) <= 1.2;
  }

  private look(cmd: UserCmd, bot: BotActor, point: V3, turn: number): void {
    const dx = point.x - bot.s.x, dz = point.z - bot.s.z;
    cmd.yaw = quantYaw(bot.yaw + clamp(angle(Math.atan2(-dx, -dz) - bot.yaw), turn * TICK_DT));
    cmd.pitch = quantPitch(bot.pitch + clamp(Math.atan2(point.y - bot.s.y - eyeHeight(bot.s), Math.hypot(dx, dz)) - bot.pitch, turn * TICK_DT));
  }

  /** 只转向、不改俯仰；站位时面向敌方方向用 */
  private turnYaw(cmd: UserCmd, bot: BotActor, yaw: number, turn: number): void {
    cmd.yaw = quantYaw(bot.yaw + clamp(angle(yaw - bot.yaw), turn * TICK_DT));
  }

  private enter(stage: Stage, tick: number): void { this.stage = stage; this.stageTick = tick; }

  private setGoal(point: V3, kind: Mode, sourceTick: number, tick: number): void {
    if (!this.goal || kind !== this.goalKind || flat(point, this.goal) > 2.5 || Math.abs(point.y - this.goal.y) > .8) {
      this.goal = copy(point); this.path = null; this.wp = 0; this.repathAt = Math.min(this.repathAt, tick);
    }
    this.goalKind = kind; this.goalTick = sourceTick;
  }

  private follow(cmd: UserCmd, bot: BotActor, actors: readonly BotActor[], tick: number, world: BVH,
    nav: BotNav, context: BotContext, keepLooking: boolean): void {
    if (!this.goal) return;
    // T2 补位路径按 Bot 错峰：复用掩体 / 探头的计划槽，不新增导航额度；等槽期间直线靠近，不站桩。
    if (!this.path && this.goalKind === 'fill' && tick >= this.repathAt && context.work && !context.work.planSlot(bot.id, tick)) {
      this.move(cmd, bot, actors, this.goal.x - bot.s.x, this.goal.z - bot.s.z, world, context);
      return;
    }
    if (tick < this.recoverUntil) {
      this.mode = 'recover'; const side = (Math.abs(bot.id) + this.stuck) % 2 ? 1 : -1;
      this.move(cmd, bot, actors, Math.cos(cmd.yaw) * side + Math.sin(cmd.yaw) * .5,
        -Math.sin(cmd.yaw) * side + Math.cos(cmd.yaw) * .5, world, context); return;
    }
    if (!this.path && tick >= this.repathAt) {
      const route = this.queryPath(nav, bot.s, this.goal, context, this.goalKind === 'cover');
      if (route === undefined) { this.repathAt = tick + 1; return; }
      this.path = route; this.wp = 0; this.repathAt = tick + 16;
      if (!this.path?.length) {
        if (++this.pathFailures >= 2) {
          if (!POST.has(this.goalKind)) this.investigatedAt = Math.max(this.investigatedAt, this.goalTick);
          this.goal = null; this.pathFailures = 0;
        }
        return;
      }
      this.pathFailures = 0;
    }
    if (!this.path) return;
    while (this.wp < this.path.length && flat(bot.s, this.path[this.wp]) < .48 && Math.abs(bot.s.y - this.path[this.wp].y) < .8) this.wp++;
    if (this.wp >= this.path.length) {
      this.path = null;
      if (this.goalKind === 'cover') return;
      if (this.goalKind === 'mission') { this.goal = null; return; }
      // 到点后搜索的只有 search / investigate / support；巡逻、冲点和站位到位即止
      if (!ROAM.has(this.goalKind) && !POST.has(this.goalKind)) { this.investigatedAt = Math.max(this.investigatedAt, this.goalTick); this.searchUntil = tick + 20; }
      this.goal = null; return;
    }
    const p = this.path[this.wp], dx = p.x - bot.s.x, dz = p.z - bot.s.z, dy = p.y - bot.s.y;
    if (dy < -1.2 && nav.ropes?.some(r => r.points && !r.bottomAirborne &&
        Math.abs(bot.s.y-r.top[1]) < .5 && Math.hypot(bot.s.x-r.top[0], bot.s.z-r.top[2]) < r.radius)) {
      this.wantedMove = true;
      cmd.buttons |= BTN.back;
      return;
    }
    // 攀绳：已经挂在绳上 → 只给上下输入（前 = 上、后 = 下），到端点会自动脱离
    if (bot.s.rope >= 0) {
      this.wantedMove = true;
      cmd.buttons |= dy >= 0 ? BTN.forward : BTN.back;
      return;
    }
    // 绳索捷径：下一个拐点在竖直方向上很远，而人就在绳索旁边 → 转身走向绳端点，并按前进自动吸附
    if (this.ropeNear(nav, bot) && dy > 1.2 && flat(bot.s, p) < 1.6) {
      cmd.yaw = quantYaw(bot.yaw + clamp(angle(Math.atan2(-dx, -dz) - bot.yaw), 7 * TICK_DT));
      this.move(cmd, bot, actors, dx, dz, world, context);
      cmd.buttons |= BTN.forward;
      return;
    }
    if (!keepLooking) cmd.yaw = quantYaw(bot.yaw + clamp(angle(Math.atan2(-dx, -dz) - bot.yaw), 7 * TICK_DT));
    this.move(cmd, bot, actors, dx, dz, world, context);
  }

  /** 人机是否贴着某条绳（用于「下一个拐点很高 → 准备攀绳」的判断；没有绳索数据就是 false） */
  private ropeNear(nav: BotNav, bot: BotActor): boolean {
    const ropes: readonly RopeDef[] | undefined = nav.ropes;
    if (!ropes?.length) return false;
    return nearestRope(ropes, bot.s.x, bot.s.y, bot.s.z, ROPE_NEAR_SCALE) !== null;
  }

  /** 胶囊前方探测只负责局部转向；实际碰撞始终由 stepPlayer 裁定。 */
  private clearStep(bot: BotActor, dx: number, dz: number, world: BVH, context: BotContext): boolean {
    const pawn = context.pawn ?? world;
    for (const side of [-.24, .24]) {
      if (raycast(pawn, bot.s.x - dz * side, bot.s.y + .95, bot.s.z + dx * side, dx, 0, dz, .7)) return false;
    }
    if (raycast(pawn, bot.s.x, bot.s.y + 1.5, bot.s.z, dx, 0, dz, .7)) return false;
    // 有正式 pawn 世界才检查落脚面，防止离线空世界夹具被当成深渊。
    if (context.pawn?.count && !raycast(pawn, bot.s.x + dx * .65, bot.s.y + 1.2, bot.s.z + dz * .65, 0, -1, 0, 2.6, .55)) return false;
    return true;
  }

  private move(cmd: UserCmd, bot: BotActor, actors: readonly BotActor[], dx: number, dz: number, world: BVH, context: BotContext): void {
    this.wantedMove = true;
    let length = Math.hypot(dx, dz);
    if (length < .001) return;
    dx /= length; dz /= length;
    for (const friend of actors) {
      if (friend.id === bot.id || !friend.alive || friend.team !== bot.team || Math.abs(friend.s.y - bot.s.y) > 1.2) continue;
      const fx = bot.s.x - friend.s.x, fz = bot.s.z - friend.s.z, d = Math.hypot(fx, fz);
      if (d >= 1.2) continue;
      if (d > .05) { dx += fx / d * (1.2 - d) * 1.8; dz += fz / d * (1.2 - d) * 1.8; }
      else dx += bot.id < friend.id ? 1.5 : -1.5;
    }
    length = Math.hypot(dx, dz); dx /= Math.max(.001, length); dz /= Math.max(.001, length);
    const f = { x: -Math.sin(cmd.yaw), z: -Math.cos(cmd.yaw) }, r = { x: Math.cos(cmd.yaw), z: -Math.sin(cmd.yaw) };
    const choices = [[1,0,BTN.forward],[1,1,BTN.forward|BTN.right],[0,1,BTN.right],[-1,1,BTN.back|BTN.right],
      [-1,0,BTN.back],[-1,-1,BTN.back|BTN.left],[0,-1,BTN.left],[1,-1,BTN.forward|BTN.left]].map(([a,b,buttons]) => {
      const n = Math.hypot(a,b), x = (f.x*a+r.x*b)/n, z = (f.z*a+r.z*b)/n;
      return { x, z, buttons, score: x*dx+z*dz };
    }).sort((a,b) => b.score-a.score);
    for (const c of choices) {
      if (c.score < -.1 || !this.clearStep(bot,c.x,c.z,world,context)) continue;
      cmd.buttons |= c.buttons; return;
    }
    // 只在真的有低障碍、上方净空时跳；没有周期性兔子跳。
    const pawn = context.pawn ?? world;
    if (!this.jumpCooldown && bot.s.grounded && raycast(pawn,bot.s.x,bot.s.y+.35,bot.s.z,dx,0,dz,.75) &&
        !raycast(pawn,bot.s.x,bot.s.y+1.5,bot.s.z,dx,0,dz,.9)) {
      this.jumpCooldown = TICK_RATE; cmd.buttons |= BTN.jump | choices[0].buttons;
    }
  }

  private leaveCover(tick: number): void {
    this.coverAnchor = this.coverThreat = this.peekPoint = null; this.coverPhase = null;
    this.coverUntil = this.coverHoldAt = this.peekUntil = 0;
    this.goal = this.path = null; this.wp = 0; this.repathAt = tick;
    this.coverPlanAt = tick + TICK_RATE;
    this.coverGraphCursor = this.coverFallbackCursor = this.peekCursor = 0;
  }

  /** 到达掩体 → 隐蔽恢复 → 可验证的侧探窗口 → 实际两发 / 超时后缩回。 */
  private coverStep(cmd: UserCmd, bot: BotActor, actors: readonly BotActor[], tick: number, world: BVH,
    nav: BotNav | null, context: BotContext, hasEnemy: boolean, reloading: boolean, suppression: number): boolean {
    const anchor = this.coverAnchor, threat = this.coverThreat;
    if (!anchor || !threat || !nav || tick >= this.coverUntil) { this.leaveCover(tick); return false; }
    this.look(cmd, bot, threat, this.tuning.turn);
    const at = (p: V3) => flat(bot.s, p) < .5 && Math.abs(bot.s.y - p.y) < .8;
    if (this.coverPhase === 'expose' && (!canPeek(true, reloading, suppression, this.peekShots) || tick >= this.peekUntil)) {
      this.coverPhase = 'return'; this.coverHoldAt = 0;
      this.setGoal(anchor, 'cover', tick, tick);
    }
    if (this.coverPhase === 'expose' && this.peekPoint) {
      this.mode = 'peek'; this.lastUtility = 'peek';
      if (at(this.peekPoint)) {
        this.goal = this.path = null;
        return !hasEnemy; // 在窗口停稳后才把开火交给原战斗层，仍需视野 / 反应 / 队友挡枪检查。
      }
      this.setGoal(this.peekPoint, 'cover', tick, tick);
      this.follow(cmd, bot, actors, tick, world, nav, context, true);
      return true;
    }
    this.mode = 'cover'; this.lastUtility = 'cover';
    if (!at(anchor)) {
      this.setGoal(anchor, 'cover', tick, tick);
      this.follow(cmd, bot, actors, tick, world, nav, context, true);
      return true;
    }
    this.goal = this.path = null;
    if (!this.coverHoldAt) this.coverHoldAt = tick + 12;
    if (tick < this.coverHoldAt || reloading || (cmd.buttons & BTN.reload)) return true;
    if (this.coverPhase === 'return') { this.leaveCover(tick); return true; }
    // 压制强时保持隐蔽；只对自己最近亲眼见过的位置探头，声音 / 来弹方向不能授权射击。
    if (suppression >= .45) return true;
    if (!this.seen || tick - this.seenTick > 3 * TICK_RATE) { this.leaveCover(tick); return true; }
    if (context.work && !context.work.planSlot(bot.id, tick)) return true;
    const peek = this.findPeek(bot, actors, anchor, threat, world, nav, context);
    if (peek === undefined) return true; // 本帧预算用完，继续隐蔽；不能误当成没有窗口。
    if (!peek) { this.leaveCover(tick); return true; }
    this.peekPoint = peek; this.coverPhase = 'expose'; this.peekUntil = tick + 48; this.peekShots = 0;
    this.metrics.peekCycles++;
    this.setGoal(peek, 'cover', tick, tick);
    return true;
  }

  private queryPath(nav: BotNav, from: V3, to: V3, context: BotContext, local = false): V3[] | null | undefined {
    const limits = local ? LOCAL_PATH_LIMITS : undefined;
    const query = (): V3[] | null => {
      // 没有 pathEx（离线夹具）就用原来的纯步行寻路
      if (!nav.pathEx) return nav.path(from, to, true, limits);
      const r = nav.pathEx(from, to, { allowRope: true, limits });
      if (!r) return null;
      if (!r.hasRope) return r.path;
      // 省时门控：攀绳比纯步行快 ROPE_MIN_SAVE 秒以上才走，否则重算 / 复用纯步行路径
      if (r.walkTime - r.time < ROPE_MIN_SAVE) {
        this.metrics.ropeRejected++;
        return r.walkPath ?? nav.path(from, to, true, limits);
      }
      this.metrics.ropePlans++;
      return r.path;
    };
    return context.work ? context.work.run(query) : query();
  }

  private findPeek(bot: BotActor, actors: readonly BotActor[], anchor: V3, threat: V3, world: BVH, nav: BotNav, context: BotContext): V3 | null | undefined {
    const length = Math.max(.1, flat(anchor, threat)), dx = (threat.x - anchor.x) / length, dz = (threat.z - anchor.z) / length;
    const side = this.persona?.strafe ?? (Math.abs(bot.id) % 2 ? 1 : -1);
    for (let i = this.peekCursor; i < 6; i++) {
      const distance = [.8, 1.4, 2][i >> 1], sign = i % 2 ? -side : side;
      const raw = { x: anchor.x - dz * distance * sign, y: anchor.y, z: anchor.z + dx * distance * sign };
      const query = (): V3 | null => {
        const p = nav.snap ? nav.snap(raw, 2, true) : raw;
        if (!p || flat(p, raw) > .4 || Math.abs(p.y - anchor.y) > .6) return null;
        if (actors.some(a => a.id !== bot.id && a.alive && a.team === bot.team && flat(a.s, p) < 1)) return null;
        if (!clearLine(world, { ...p, y: p.y + eyeHeight(bot.s) }, threat)) return null;
        const route = nav.path(anchor, p, true, LOCAL_PATH_LIMITS), end = route?.at(-1);
        if (!route || !end || flat(end, p) > .4) return null;
        const travel = route.reduce((sum, q, i) => i ? sum + Math.hypot(q.x - route[i - 1].x, q.y - route[i - 1].y, q.z - route[i - 1].z) : 0, 0);
        return travel <= 3 ? copy(end) : null;
      };
      const point = context.work ? context.work.run(query) : query();
      if (point === undefined) { this.peekCursor = i; return undefined; }
      if (point) { this.peekCursor = 0; return point; }
    }
    this.peekCursor = 0;
    return null;
  }

  private findCover(bot: BotActor, actors: readonly BotActor[], threat: V3, world: BVH, nav: BotNav, context: BotContext = {}): V3[] | null | undefined {
    // 用距离 / 方向做廉价预筛；每次最多 6 次导航查询，避免多人同时受压时产生寻路尖峰。
    let best: { path: V3[]; score: number } | null = null;
    const candidates: { cover: NonNullable<BotContext['covers']>[number]; d2: number }[] = [];
    for (const cover of context.covers ?? []) {
      const d2 = (bot.s.x - cover.point.x) ** 2 + (bot.s.z - cover.point.z) ** 2;
      if (d2 > 144 || Math.abs(bot.s.y - cover.point.y) >= .8 || !(cover.blockedMask & directionBit(cover.point, threat))) continue;
      if (candidates.length === 6 && d2 >= candidates[5].d2) continue;
      let i = 0; while (i < candidates.length && candidates[i].d2 <= d2) i++;
      candidates.splice(i, 0, { cover, d2 }); if (candidates.length > 6) candidates.pop();
    }
    for (let i = this.coverGraphCursor; i < candidates.length; i++) {
      const { cover } = candidates[i];
      if (actors.some(a => a.id !== bot.id && a.alive && a.team === bot.team && flat(a.s, cover.point) < 1)) continue;
      if (clearLine(world, { ...cover.point, y: cover.point.y + eyeHeight(bot.s) }, threat)) continue;
      const route = this.queryPath(nav, bot.s, cover.point, context, true);
      if (route === undefined) {
        if (best) { this.metrics.graphCoverPlans++; this.coverGraphCursor = this.coverFallbackCursor = 0; return best.path; }
        this.coverGraphCursor = i;
        return undefined;
      }
      const end = route?.[route.length - 1];
      if (!route || !end || flat(end, cover.point) > 1.2 || Math.abs(end.y - bot.s.y) > .8) continue;
      const eye = { x: end.x, y: end.y + eyeHeight(bot.s), z: end.z };
      if (clearLine(world, eye, threat) || clearLine(world, { ...end, y: end.y + 1.1 }, threat)) continue;
      const pathLength = route.reduce((sum, p, i) => i ? sum + Math.hypot(p.x - route[i - 1].x, p.y - route[i - 1].y, p.z - route[i - 1].z) : 0, 0);
      if (pathLength > 14) continue;
      let teammateDistance = Infinity;
      for (const a of actors) if (a.id !== bot.id && a.team === bot.team && a.alive) teammateDistance = Math.min(teammateDistance, flat(a.s, cover.point));
      const score = scoreCover(bot.s, threat, cover, pathLength, teammateDistance);
      if (score > (best?.score ?? -Infinity)) best = { path: route, score };
    }
    if (best) { this.metrics.graphCoverPlans++; this.coverGraphCursor = this.coverFallbackCursor = 0; return best.path; }
    this.coverGraphCursor = candidates.length;
    const d = Math.max(.1, flat(bot.s, threat)), tx = (threat.x-bot.s.x)/d, tz = (threat.z-bot.s.z)/d;
    const fallback = [[0,4],[0,-4],[3,3],[3,-3],[5,2],[5,-2]];
    for (let i = this.coverFallbackCursor; i < fallback.length; i++) {
      const [back,side] = fallback[i];
      const p = {x:bot.s.x-tx*back-tz*side,y:bot.s.y,z:bot.s.z-tz*back+tx*side};
      if (actors.some(a=>a.id!==bot.id&&a.alive&&a.team===bot.team&&flat(a.s,p)<1)) continue;
      if (clearLine(world,{...p,y:p.y+eyeHeight(bot.s)},threat)) continue;
      const path = this.queryPath(nav, bot.s, p, context, true);
      if (path === undefined) { this.coverFallbackCursor = i; return undefined; }
      const end = path?.[path.length-1];
      if (!path || !end || flat(end,p)>1.2 || Math.abs(end.y-bot.s.y)>.8 || clearLine(world,{...end,y:end.y+eyeHeight(bot.s)},threat)) continue;
      let length=0; for(let i=1;i<path.length;i++)length+=Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y,path[i].z-path[i-1].z);
      if(length<=9) { this.coverGraphCursor = this.coverFallbackCursor = 0; return path; }
    }
    this.coverGraphCursor = this.coverFallbackCursor = 0;
    return null;
  }

  private finish(cmd: UserCmd, bot: BotActor, tick: number): UserCmd {
    this.triggerHeld = !!(cmd.buttons & BTN.fire);
    if (!this.checkPos) { this.checkPos = copy(bot.s); this.checkTick = tick; }
    if (this.wantedMove) this.moveTicks++;
    if (tick - this.checkTick >= 24) {
      const moved = flat(bot.s, this.checkPos);
      if (this.moveTicks >= 12 && moved < .3) {
        this.stuck++; this.recoverUntil = tick + 12; this.path = null; this.repathAt = tick + 4;
        if (this.stuck >= 3 && this.goalKind !== 'cover') {
          if (!POST.has(this.goalKind)) this.investigatedAt = Math.max(this.investigatedAt, this.goalTick);
          this.goal = null;
        }
      } else if (moved > .6) this.stuck = 0;
      this.checkTick = tick; this.checkPos = copy(bot.s); this.moveTicks = 0;
    }
    return cmd;
  }

  /** 人格的换枪意图：换弹 / 换枪途中不改；看见敌人按距离选主武器或副武器；脱战 3 s 后回主武器。 */
  private chooseWeapon(weapon: BotCombatState, distance: number | null, tick: number): WeaponId | null {
    const p = this.persona!, cur = weapon.weapon;
    if (weapon.reloadUntil > tick || weapon.equipUntil > tick) return null;
    if (distance === null) return tick - this.seenTick > 3 * TICK_RATE && cur !== p.weapon ? p.weapon : null;
    if (cur === p.weapon) return keepsFit(cur, distance) || !entersFit(p.sidearm, distance) ? null : p.sidearm;
    if (entersFit(p.weapon, distance)) return p.weapon;
    return !keepsFit(cur, distance) && entersFit(p.sidearm, distance) ? p.sidearm : null;
  }

  /** 人格：被两人以上压制、队友在 30 m 内时，返回靠拢的队友位置（人数占优的对面不靠拢；冲点手不回撑） */
  private regroupPoint(bot: BotActor, actors: readonly BotActor[], world: BVH, range: number, weapon: BotCombatState): V3 | null {
    const p = this.persona;
    if (!p || p.role === 'entry') return null;
    // 先做不花钱的队友统计：没有 30 m 内队友时不必去看敌人（省掉最多 10 次射线）。
    let near = 0, best: BotActor | null = null, bestD = Infinity;
    for (const a of actors) {
      if (a.id === bot.id || a.team !== bot.team || !a.alive) continue;
      const d = flat(bot.s, a.s);
      if (d <= 15) near++;
      if (d < bestD) { bestD = d; best = a; }
    }
    if (!best || bestD > 30) return null;
    // 可见敌人数只用于区分「<2」「<=队友数+1」「<3」三个阈值，超过上界就可以停。
    const cap = Math.max(near + 1, 2);
    let foes = 0;
    for (const e of actors) {
      if (!visiblePoint(bot, e, world, range + 10)) continue;
      if (++foes > cap) break;
    }
    if (foes <= near + 1) return null;
    // 残血或被三人以上围住才撤向队友；否则只是靠拢（仍边打边走）
    if (weapon.hp > 45 + 30 * p.caution && foes < 3) return null;
    return copy(best.s);
  }

  /** 守点手当前守的点：主点 / 备选点轮换；爆破已安包时守包点；进攻推进等其它任务返回 null（走原有任务逻辑） */
  private anchorPost(tick: number, context: BotContext, mission: BotMission | undefined): V3 | null {
    const p = this.persona, ps = context.patrols;
    if (!p || p.site < 0 || !ps?.length) return null;
    if (mission && mission.kind !== 'guard') return null;
    if (mission && mission.phase === 'planted') return mission.point;
    return ps[this.anchorIndex(tick, context)] ?? null;
  }

  /** 守点轮换：没有接触超过 8–22 s（耐心越高越久）就换到另一侧（主点 ↔ 备选点） */
  private anchorIndex(tick: number, context: BotContext): number {
    const p = this.persona!;
    if (this.postSince === -Infinity) this.postSince = tick;
    const last = Math.max(this.seenTick, this.heardTick, context.contact?.tick ?? -Infinity);
    if (p.alt >= 0 && tick - Math.max(last, this.postSince) > (8 + 14 * p.patience) * TICK_RATE) {
      this.onAlt = !this.onAlt; this.postSince = tick;
    }
    return this.onAlt && p.alt >= 0 ? p.alt : p.site;
  }

  /** 守点不压在点上正中：按个体相位在中心 1.6 m 内取一个可走点（取不到就站中心） */
  private spotAround(center: V3, nav: BotNav | null): V3 {
    const phase = this.persona?.wobblePhase ?? 0;
    const raw = { x: center.x + Math.cos(phase) * 1.6, y: center.y, z: center.z + Math.sin(phase) * 1.6 };
    const s = nav && nav.snap ? nav.snap(raw, 3, true) : null;
    return s && flat(s, raw) <= 1.6 ? { x: s.x, y: s.y, z: s.z } : copy(center);
  }

  /**
   * 职责站位（只有人格人机）：返回 true 表示本 tick 已接管移动与视角；false 交回原有的任务 / 巡逻逻辑。
   * 守点手：轮换守主点 / 备选点；爆破守包时守包点。潜伏手：侧翼 → 潜伏 → 绕入 → 守住。冒点 / 接应 / 机动手走巡逻。
   */
  private roleStep(cmd: UserCmd, bot: BotActor, tick: number, nav: BotNav | null, context: BotContext,
    patrol: V3, mission: BotMission | undefined, post: V3 | null): boolean {
    const p = this.persona, ps = context.patrols;
    if (!p || !ps?.length) return false;
    if (p.role === 'anchor') {
      if (!post) return false;
      this.holdAt(cmd, bot, tick, nav, this.spotAround(post, nav), mission?.face ?? patrol);
      return true;
    }
    if (p.role !== 'lurker') return false;
    // 潜伏点：守点 / 进攻推进时在计划点侧翼；爆破守包时在包点侧翼；其它任务交回原逻辑
    let site: V3 | undefined = ps[p.site];
    if (mission) {
      if (mission.kind === 'push' || (mission.kind === 'guard' && mission.phase === 'planted')) site = mission.point;
      else if (mission.kind !== 'guard') { this.stage = 'idle'; return false; }
    }
    if (!site) { this.stage = 'idle'; return false; }
    this.lurkStep(cmd, bot, tick, nav, context, site, patrol);
    return true;
  }

  /**
   * 潜伏：先到侧翼点 → 原地潜伏（面向包点）→ 出现动静或等够了就绕入包点 → 守住。
   * 站位开始之后出现的枪声 / 亲眼 / 队友报点都算“动静”，会立即绕入。
   */
  private lurkStep(cmd: UserCmd, bot: BotActor, tick: number, nav: BotNav | null, context: BotContext,
    site: V3, patrol: V3): void {
    const p = this.persona!, cfg = this.tuning;
    if (this.stage === 'idle') this.enter('approach', tick);
    const alarm = Math.max(this.seenTick, this.heardTick, context.contact?.tick ?? -Infinity) > this.stageTick;
    if (this.stage === 'approach') {
      if (!this.flankPoint || !this.flankFor || flat(this.flankFor, site) > 1.5) {
        this.flankFor = copy(site);
        this.flankPoint = this.pickFlank(site, patrol, nav);
      }
      if (flat(bot.s, this.flankPoint) <= 1.8) this.enter('lurk', tick);
      else if (alarm || tick - this.stageTick > 20 * TICK_RATE) this.enter('swing', tick);
      else { this.mode = 'flank'; this.setGoal(this.flankPoint, 'flank', tick, tick); return; }
    }
    if (this.stage === 'lurk') {
      if (alarm || tick - this.stageTick > (4 + 6 * p.patience) * TICK_RATE) this.enter('swing', tick);
      else {
        this.mode = 'lurk'; this.goal = null; this.path = null;
        this.turnYaw(cmd, bot, yawTo(bot.s, site), cfg.turn);
        return;
      }
    }
    if (this.stage === 'swing') {
      if (flat(bot.s, site) <= 3.2 || tick - this.stageTick > 20 * TICK_RATE) this.enter('hold', tick);
      else { this.mode = 'rush'; this.setGoal(site, 'rush', tick, tick); return; }
    }
    this.holdAt(cmd, bot, tick, nav, this.spotAround(site, nav), patrol);
  }

  /** 侧翼点：沿“敌方出生 → 包点”的垂线，取个体横移侧 9 m 处；取不到可走点就逐级内收（6 m、4 m），都不行就回到包点 */
  private pickFlank(site: V3, enemy: V3, nav: BotNav | null): V3 {
    let vx = site.x - enemy.x, vz = site.z - enemy.z;
    const len = Math.hypot(vx, vz);
    if (len < 1) { vx = 1; vz = 0; } else { vx /= len; vz /= len; }
    const side = this.persona?.strafe ?? 1;
    for (const r of [9, 6, 4]) {
      const raw = { x: site.x - vz * side * r, y: site.y, z: site.z + vx * side * r };
      if (!nav || !nav.snap) return raw;
      const s = nav.snap(raw, 3, true);
      if (s && flat(s, raw) <= 2.5) return { x: s.x, y: s.y, z: s.z };
    }
    return copy(site);
  }

  /** 守住一点：未到点先走过去；到点后原地按人格相位慢扫（节奏各不相同）。 */
  private holdAt(cmd: UserCmd, bot: BotActor, tick: number, nav: BotNav | null, post: V3, face: V3): void {
    this.mode = 'hold';
    if (nav && flat(bot.s, post) > 2.4) { this.setGoal(post, 'hold', tick, tick); return; }
    this.goal = null; this.path = null;
    const sweep = Math.sin(tick / 40 + (this.persona?.wobblePhase ?? 0)) * .55;
    this.turnYaw(cmd, bot, yawTo(bot.s, face) + sweep, this.tuning.turn);
  }

  /** 巡逻下一点：无人格沿用原轮换；有人格时支援从本方点位起手，其余按各自点位轮转。
   *  T1：有区域默认点位表时优先按区域轮转（每区 3–5 个点，按 Bot 错开起点，不做局中重抽）。 */
  private nextPatrol(bot: BotActor, patrol: V3, context: BotContext, nav: BotNav | null): V3 | null | undefined {
    const p = this.persona, ps = context.patrols, zones = context.zones;
    if (zones?.length) {
      const zone = zones[zoneIndexFor(bot.id, p?.site ?? -1, zones.length)];
      if (zone?.points.length) {
        this.zoneName = zone.name;
        this.tactics.zonePatrols++;
        return copy(zone.points[(this.patrolCycle + Math.abs(bot.id)) % zone.points.length]);
      }
    }
    if (!p) {
      return this.patrolCycle === 0 ? patrol : ps?.length ? ps[(Math.abs(bot.id) + this.patrolCycle) % ps.length]
        : nav?.randomAround?.(patrol, 12, true) ?? nav?.randomPoint(true);
    }
    if (this.patrolCycle === 0 && p.role !== 'support') return patrol;
    if (ps?.length) return ps[((p.site >= 0 ? p.site : Math.abs(bot.id)) + this.patrolCycle) % ps.length];
    return nav?.randomAround?.(patrol, 12, true) ?? nav?.randomPoint(true);
  }
}

// ---------------------------------------------------------------------------------------------
// 爆破经济：人机的购买计划（本项目自定规则，数值全部取自 shared/economy.ts）
//
//   经济分层（按余额）：保底 eco → 半起半买 → full buy。同一档内随机挑枪（人格主武器买得起就优先它），
//   护甲按「买得起的最好的那档」挑；先算好预算再交给 match 的 tryBuy 逐件成交（余额不足的会被拒）。
//   人机与真人走完全同一套购买校验与扣款，不享受任何特例。
// ---------------------------------------------------------------------------------------------

/** 主武器候选（步枪 / 机枪）：full buy 用 */
const BOT_RIFLES: readonly WeaponId[] = ['bulldog', 'guardian', 'phantom', 'vandal', 'ares', 'odin'];
/** 冲锋枪：半起的主选 */
const BOT_SMGS: readonly WeaponId[] = ['stinger', 'spectre'];
/** 霰弹枪：半起与保底都可以用 */
const BOT_SHOTGUNS: readonly WeaponId[] = ['bucky', 'judge'];
/** full buy 门槛：够买一把步枪（2700 起）+ 轻甲 */
const BOT_FULL_BUY = 2600;
/** 半起门槛：够买轻甲 + 一把便宜的冲锋 / 霰弹 */
const BOT_HALF_BUY = 1400;

/** 昂贵的在前：随机只在「最贵的两把买得起」里挑，避免 full buy 拿到最便宜的枪 */
function botGunChoice(list: readonly WeaponId[], budget: number, prefer: WeaponId | null, rng: () => number): WeaponId | null {
  const ok = list.filter(w => WEAPON_PRICES[w] <= budget).sort((a, b) => WEAPON_PRICES[b] - WEAPON_PRICES[a]);
  if (ok.length === 0) return null;
  if (prefer && ok.includes(prefer)) return prefer;
  const top = ok.slice(0, Math.min(2, ok.length));
  return top[Math.min(top.length - 1, Math.floor(rng() * top.length))];
}

/** 人机的购买计划：顺序即成交顺序（先护甲还是先枪由各档自己决定） */
export function botBuyPlan(credits: number, persona: BotPersona | null, rng: () => number = Math.random): BuyItem[] {
  const plan: BuyItem[] = [];
  const armorIn = (kinds: readonly ArmorKind[], budget: number): number => {
    for (const kind of kinds) {
      const price = ARMOR[kind].price;
      if (price > budget) continue;
      plan.push({ type: 'armor', id: kind });
      return budget - price;
    }
    return budget;
  };
  const prefer = persona?.weapon ?? null;
  if (credits >= BOT_FULL_BUY) {
    // full buy：先挑主武器，剩下的钱买最好的护甲（重甲 / 再生甲买不起就轻甲）
    const gun = botGunChoice([...BOT_RIFLES, ...BOT_SMGS, ...BOT_SHOTGUNS], credits - ARMOR.light.price, prefer, rng);
    const rest = gun ? credits - WEAPON_PRICES[gun] : credits;
    armorIn(['regen', 'heavy', 'light'], rest);
    if (gun) plan.unshift({ type: 'weapon', id: gun });
    return plan;
  }
  if (credits >= BOT_HALF_BUY) {
    // 半起：先买轻甲（400），剩下的买便宜的冲锋 / 霰弹；钱不够就只买枪
    let budget = credits;
    if (budget - ARMOR.light.price >= WEAPON_PRICES.bucky) budget = armorIn(['light'], budget);
    const gun = botGunChoice([...BOT_SMGS, ...BOT_SHOTGUNS], budget, prefer, rng)
      ?? (persona?.sidearm && WEAPON_PRICES[persona.sidearm] <= budget ? persona.sidearm : null);
    if (gun) plan.push({ type: 'weapon', id: gun });
    return plan;
  }
  // 保底 eco：只把轻甲买上（400），其余存钱等下一回合
  armorIn(['light'], credits);
  return plan;
}
