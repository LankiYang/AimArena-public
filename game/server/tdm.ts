// tdm.ts（服务端）— 团队死斗整场机：只做规则，不碰网络 / 世界 / 战斗系统。
//   match 在解冻时调 start()，之后每个 tick（战斗推进之后）调 step(tick, 两队击杀)，拿到本 tick 的事件：
//   开场（matchStart，只发一次）与整场结束（matchEnd，只发一次）。纯逻辑：tools/tdm-rules-check.mjs 直接驱动它。
//
//   流程：pregame 准备 20 秒（不能开火、人机站桩）→ live 连续 570 秒 → over 整场结束。
//   胜负：任一队先到击杀目标即结束（同一 tick 双方都到：杀多者胜，持平为平局）；
//         时间到仍未分胜负：杀多者胜，持平为平局。整场不设加时，复活与阵亡随时间照常进行。
import type { Team } from '../shared/catalog.ts';
import { TDM, TDM_MATCH_TICKS, tdmTicks, type TdmEvent, type TdmPhase, type TdmReason, type TdmView } from '../shared/tdm.ts';

const PREGAME_TICKS = tdmTicks(TDM.pregameSec);

export interface TdmRulesOptions {
  /** 先到这么多击杀者获胜 */
  target: number;
}

/** 杀多者胜；持平为平局（-1） */
const winnerOf = (a: number, b: number): Team | -1 => (a === b ? -1 : a > b ? 0 : 1);

export class TdmRules {
  readonly target: number;
  private phase: TdmPhase | 'idle' = 'idle';
  /** 开场 tick（准备期结束、对局开始） */
  private liveStart = 0;
  private kills: [number, number] = [0, 0];
  private result: { winner: Team | -1; reason: TdmReason } | null = null;
  private queue: TdmEvent[] = [];

  constructor(o: TdmRulesOptions) {
    this.target = o.target;
  }

  /** 解冻时调用：进入准备期（不能开火）。 */
  start(tick: number): TdmEvent[] {
    this.phase = 'pregame';
    this.liveStart = tick + PREGAME_TICKS;
    return this.flush();
  }

  /** 每个 tick（战斗推进之后）调用一次；kills 为两队本局累计击杀（CombatSystem.teamKillsOf）。返回本 tick 的事件。 */
  step(tick: number, kills: readonly [number, number]): TdmEvent[] {
    if (this.phase === 'idle' || this.phase === 'over') return this.flush();
    this.kills = [kills[0], kills[1]];
    if (this.phase === 'pregame') {
      if (tick < this.liveStart) return this.flush();
      this.phase = 'live';
      this.queue.push({ kind: 'matchStart' });
    }
    const [a, b] = this.kills;
    if (a >= this.target || b >= this.target) return this.end(winnerOf(a, b), 'target');
    if (tick - this.liveStart >= TDM_MATCH_TICKS) return this.end(winnerOf(a, b), 'time');
    return this.flush();
  }

  /** 给 match / 测试读取的整场视图（未开始为 null） */
  view(): TdmView | null {
    if (this.phase === 'idle') return null;
    return {
      phase: this.phase,
      target: this.target,
      kills: [this.kills[0], this.kills[1]],
      prepEnd: this.phase === 'pregame' ? this.liveStart : 0,
      matchEnd: this.phase === 'live' ? this.liveStart + TDM_MATCH_TICKS : 0,
      result: this.result ? { ...this.result } : null,
    };
  }

  /** 此刻是否锁枪：未开始 / 准备期 / 整场结束都不能开火；对局进行中才能 */
  lockOf(): boolean {
    return this.phase !== 'live';
  }

  phaseNow(): TdmPhase | 'idle' {
    return this.phase;
  }

  private end(winner: Team | -1, reason: TdmReason): TdmEvent[] {
    this.phase = 'over';
    this.result = { winner, reason };
    this.queue.push({ kind: 'matchEnd', winner, reason, kills: [this.kills[0], this.kills[1]] });
    return this.flush();
  }

  private flush(): TdmEvent[] {
    if (!this.queue.length) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }
}