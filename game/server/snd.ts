// snd.ts（服务端）— 爆破回合机：只做规则，不碰网络 / 世界 / 战斗系统。
//   match 在每个 tick 的战斗推进之后调用 step()，交入「每个人是否活着、位置、是否按住使用键」；
//   这里推进阶段、拾取、安放 / 拆除读条、胜负，并返回本 tick 的事件（match 据此复活、锁枪、定身、广播）。
//   死亡 / 离场通过 release() 通知（持包者掉包）。纯逻辑：tools/snd-rules-check.mjs 直接驱动它。
//
//   流程：buy 购买就位 30s → live 回合 100s（超时防守方胜）→ 安包（包内按住 4s，之后 planted 45s 引爆）
//         → 拆包（包内按住 7s，松键时进度 ≥3.5s 存档在 3.5s）→ end 结算 7s → 下一回合。
//   前半场（第 1..N-1 回合）红方进攻，之后蓝方进攻；先赢 N 回合者获胜，整场不设加时。
//
//   经济（阶段9）：回合机只维护「连败场次」（按阵营记，换边不清零），奖金与余额由 match 在 roundEnd 时
//   调 shared/economy.ts 的 roundReward() 结算（钱包是每人的，不在回合机里）。购买窗就是 buy 阶段，
//   购买校验（余额 / 窗口 / 槽位 / 护甲）在 server/match.ts 的 buy()。
import type { Team } from '../shared/catalog.ts';
import type { V3 } from '../shared/combat.ts';
import { SND, sndTicks, type SndEvent, type SndPhase, type SndReason, type SndSpike, type SndView } from '../shared/snd.ts';

/** match 每 tick 交入的一个人 */
export interface SndActor {
  id: number;
  team: Team;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  /** 这一 tick 是否按住使用键（match 按最近一条有效命令给出） */
  use: boolean;
}

export interface SndRulesOptions {
  /** 先赢下这么多回合者获胜 */
  scoreLimit: number;
  /** 包点字母（如 ['A', 'B']） */
  sites: readonly string[];
  /** 脚底坐标落在哪个包点范围内；不在返回 null */
  siteAt(x: number, y: number, z: number): string | null;
  /** 随机源 [0,1)：默认 Math.random；测试注入固定序列 */
  rng?: () => number;
}

const BUY_TICKS = sndTicks(SND.buySec);
const ROUND_TICKS = sndTicks(SND.roundSec);
const PLANT_TICKS = sndTicks(SND.plantSec);
const DETONATE_TICKS = sndTicks(SND.detonateSec);
const DEFUSE_TICKS = sndTicks(SND.defuseSec);
const CHECKPOINT_TICKS = sndTicks(SND.defuseCheckpointSec);
const END_TICKS = sndTicks(SND.endSec);

const other = (t: Team): Team => (t === 0 ? 1 : 0);

export class SndRules {
  private readonly scoreLimit: number;
  private readonly sites: readonly string[];
  private readonly siteAt: (x: number, y: number, z: number) => string | null;
  private readonly rng: () => number;
  private round = 0;
  private wins: [number, number] = [0, 0];
  private phase: SndPhase = 'buy';
  private phaseEnd = 0;
  private spike: SndSpike = 'carried';
  private carrier = -1;
  private site: string | null = null;
  private spikeAt: V3 | null = null;
  private plantTicks = 0;
  private defuseTicks = 0;
  private result: { winner: Team; reason: SndReason } | null = null;
  private matchWinner: Team | null = null;
  /** 连败场次（含刚结束的这一场）：按阵营（红 0 / 蓝 1）记，换边与人员进出都不清零（与回合机一样与队伍无关） */
  private lossStreak: [number, number] = [0, 0];
  /** 回合刚开始：携带者在下一次 step 指定（那时全员已经复活到出生点） */
  private needsCarrier = false;
  private plan = '';
  private rooted = new Set<number>();
  private queue: SndEvent[] = [];

  constructor(o: SndRulesOptions) {
    this.scoreLimit = o.scoreLimit;
    this.sites = o.sites;
    this.siteAt = o.siteAt;
    this.rng = o.rng ?? Math.random;
  }

  /** 第 1 回合开始（解冻时调用）。返回需要立即处理的事件（roundStart：match 据此让全员复活）。 */
  start(tick: number): SndEvent[] {
    this.round = 1;
    this.wins = [0, 0];
    this.lossStreak = [0, 0];
    this.matchWinner = null;
    this.beginRound(tick);
    return this.flush();
  }

  /** 本回合进攻方：第 1..N-1 回合红方进攻，第 N 回合起蓝方进攻（不再换回） */
  attackTeam(): Team {
    return this.round < this.scoreLimit ? 0 : 1;
  }

  /** 本回合进攻方的目标包点（服务端内部用：进攻方往这里走；对外的 view 只在安放后才公开包点） */
  plannedSite(): string {
    return this.plan;
  }

  phaseNow(): SndPhase {
    return this.phase;
  }

  /** 这一 tick 此人是否定身（正在安放 / 拆除读条） */
  rootedOf(id: number): boolean {
    return this.rooted.has(id);
  }

  /** 这一 tick 此人是否不能开枪：购买 / 结算 / 整场结束，或正在读条 */
  lockOf(id: number): boolean {
    return this.phase === 'buy' || this.phase === 'end' || this.phase === 'over' || this.rooted.has(id);
  }

  /**
   * 连败场次（含刚结束的这一场）：输方 +1、赢方清零。
   * 经济系统用它算输方奖金（shared/economy.ts 的 lossBonus / roundReward）。
   */
  lossStreakOf(team: Team): number {
    return this.lossStreak[team];
  }

  /** 购买窗是否开着（buy 阶段）：match 的购买校验用它 */
  buyWindowOpen(): boolean {
    return this.phase === 'buy';
  }

  /** 死亡 / 离场：持包者掉包，包落在死亡位置 */
  release(id: number, at: V3): void {
    this.rooted.delete(id);
    if (this.spike !== 'carried' || this.carrier !== id) return;
    this.carrier = -1;
    this.spike = 'dropped';
    this.spikeAt = { x: at.x, y: at.y, z: at.z };
    this.plantTicks = 0;
    this.queue.push({ kind: 'drop', player: id, at: { x: at.x, y: at.y, z: at.z } });
  }

  /** 每个 tick（战斗推进之后）调用一次。返回本 tick 发生的事件。 */
  step(tick: number, actors: readonly SndActor[]): SndEvent[] {
    if (this.phase === 'over') return this.flush();
    if (this.phase === 'end') {
      if (tick >= this.phaseEnd) this.nextRound(tick);
      return this.flush();
    }
    if (this.phase === 'buy' && tick >= this.phaseEnd) {
      this.phase = 'live';
      this.phaseEnd = tick + ROUND_TICKS;
    }
    const atk = this.attackTeam();
    const alive = actors.filter((a) => a.alive);
    const attackers = alive.filter((a) => a.team === atk).sort((a, b) => a.id - b.id);
    const defenders = alive.filter((a) => a.team !== atk).sort((a, b) => a.id - b.id);
    if (this.needsCarrier && attackers.length) {
      this.carrier = attackers[this.pick(attackers.length)].id;
      this.needsCarrier = false;
    }
    if (this.phase === 'live') this.stepLive(tick, atk, attackers, defenders, actors);
    else if (this.phase === 'planted') this.stepPlanted(tick, atk, defenders);
    return this.flush();
  }

  /** 给 match / 测试读取的回合视图（全队可见的信息） */
  view(): SndView {
    return {
      phase: this.phase,
      round: this.round,
      scoreLimit: this.scoreLimit,
      wins: [this.wins[0], this.wins[1]],
      attack: this.attackTeam(),
      phaseEnd: this.phase === 'over' ? 0 : this.phaseEnd,
      spike: this.spike,
      carrier: this.spike === 'carried' ? this.carrier : -1,
      site: this.site,
      spikeAt: this.spikeAt ? { ...this.spikeAt } : null,
      plantTicks: this.phase === 'live' ? this.plantTicks : 0,
      defuseTicks: this.phase === 'planted' ? this.defuseTicks : 0,
      channel: this.rooted.size === 0 ? null : this.phase === 'planted' ? 'defuse' : this.phase === 'live' ? 'plant' : null,
      result: this.result ? { ...this.result } : null,
      matchWinner: this.matchWinner,
    };
  }

  // —— 内部 ——

  private stepLive(tick: number, atk: Team, attackers: SndActor[], defenders: SndActor[], actors: readonly SndActor[]): void {
    // 1) 拾取：进攻方走到掉落的包上即捡起（先到先得，按 id 排序）
    if (this.spike === 'dropped' && this.spikeAt) {
      const at = this.spikeAt;
      const taker = attackers.find((a) =>
        Math.hypot(a.x - at.x, a.z - at.z) <= SND.pickupRadius && Math.abs(a.y - at.y) <= SND.pickupHeight);
      if (taker) {
        this.carrier = taker.id;
        this.spike = 'carried';
        this.spikeAt = null;
        this.queue.push({ kind: 'pickup', player: taker.id });
      }
    }
    // 2) 安放读条：持包者在包点内按住使用键。松键 / 出包点 / 死亡 → 进度清零。
    const c = this.spike === 'carried' ? actors.find((a) => a.id === this.carrier) : undefined;
    const site = c && c.alive && c.team === atk && c.use ? this.siteAt(c.x, c.y, c.z) : null;
    const planting = !!c && site !== null;
    this.plantTicks = planting ? this.plantTicks + 1 : 0;
    this.rooted.clear();
    if (planting && c && site !== null) {
      if (this.plantTicks >= PLANT_TICKS) {
        this.spike = 'planted';
        this.site = site;
        this.spikeAt = { x: c.x, y: c.y, z: c.z };
        this.queue.push({ kind: 'plant', player: c.id, site });
        this.carrier = -1;
        this.plantTicks = 0;
        this.defuseTicks = 0;
        this.phase = 'planted';
        this.phaseEnd = tick + DETONATE_TICKS;
        return;
      }
      this.rooted.add(c.id);
    }
    // 3) 淘汰 / 超时（安包前）：进攻方全灭防守方胜；防守方全灭进攻方胜；时间到防守方胜
    if (attackers.length === 0) return this.endRound(tick, other(atk), 'elim');
    if (defenders.length === 0) return this.endRound(tick, atk, 'elim');
    if (tick >= this.phaseEnd) this.endRound(tick, other(atk), 'time');
  }

  private stepPlanted(tick: number, atk: Team, defenders: SndActor[]): void {
    // 安包后进攻方死光不结束回合，防守方仍可拆包；防守方死光则无人能拆包，进攻方立即获胜。
    if (defenders.length === 0) {
      this.endRound(tick, atk, 'elim');
      return;
    }
    const site = this.site;
    const defusers = defenders.filter((d) => d.use && site !== null && this.siteAt(d.x, d.y, d.z) === site);
    if (defusers.length) this.defuseTicks++;
    else this.defuseTicks = this.defuseTicks < CHECKPOINT_TICKS ? 0 : CHECKPOINT_TICKS;
    this.rooted.clear();
    for (const d of defusers) this.rooted.add(d.id);
    if (defusers.length && this.defuseTicks >= DEFUSE_TICKS && site !== null) {
      this.spike = 'defused';
      this.queue.push({ kind: 'defuse', player: defusers[0].id, site });
      this.endRound(tick, other(atk), 'defuse');
      return;
    }
    if (tick >= this.phaseEnd) {
      this.spike = 'detonated';
      this.queue.push({ kind: 'detonate', site: site ?? '' });
      this.endRound(tick, atk, 'detonate');
    }
  }

  private endRound(tick: number, winner: Team, reason: SndReason): void {
    this.wins[winner]++;
    // 连败记录：赢方清零，输方 +1（奖金由 match 按这个次数结算）
    this.lossStreak[winner] = 0;
    this.lossStreak[other(winner)]++;
    this.phase = 'end';
    this.phaseEnd = tick + END_TICKS;
    this.result = { winner, reason };
    this.rooted.clear();
    this.plantTicks = 0;
    this.defuseTicks = 0;
    if (this.wins[winner] >= this.scoreLimit) this.matchWinner = winner;
    this.queue.push({ kind: 'roundEnd', winner, reason, wins: [this.wins[0], this.wins[1]] });
  }

  private nextRound(tick: number): void {
    if (this.matchWinner !== null) {
      this.phase = 'over';
      this.phaseEnd = 0;
      this.queue.push({ kind: 'matchEnd', winner: this.matchWinner, wins: [this.wins[0], this.wins[1]] });
      return;
    }
    this.round++;
    this.beginRound(tick);
  }

  private beginRound(tick: number): void {
    this.phase = 'buy';
    this.phaseEnd = tick + BUY_TICKS;
    this.spike = 'carried';
    this.carrier = -1;
    this.site = null;
    this.spikeAt = null;
    this.plantTicks = 0;
    this.defuseTicks = 0;
    this.result = null;
    this.rooted.clear();
    this.needsCarrier = true;
    this.plan = this.sites[this.pick(this.sites.length)];
    this.queue.push({ kind: 'roundStart', round: this.round, attack: this.attackTeam() });
  }

  private pick(n: number): number {
    return Math.min(n - 1, Math.floor(this.rng() * n));
  }

  private flush(): SndEvent[] {
    if (!this.queue.length) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
