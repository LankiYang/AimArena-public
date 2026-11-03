// tdm-hud.ts — 团队死斗的整场显示：顶部唯一比分行的阶段文案（准备倒计时 / 整场剩余 / 击杀目标）、开场与整场结果横幅。
//
// 规矩：准备倒计时、剩余时间与击杀目标都来自服务端 TdmView（随 CombatUpdate.tdm 下发），开场横幅来自同一条战斗更新里按序到达的 matchStart 事件。
//   比分不再由这里画：顶部只有一个比分行（MatchScoreboard 的 .live-score，数据来自 matchBoard），这里只往它的中间栏写阶段 / 目标，不另开 round-bar。
//   倒计时用本地 tickFloat 平滑（与战斗 HUD 同口径）。横幅样式复用 round.css（TDM / SND 不会同时出现）。
import type { CombatEvent } from '../../shared/combat.ts';
import type { TdmMatchSummary } from '../../shared/lobby.ts';
import { TICK_RATE } from '../../shared/sim/tick.ts';
import type { TdmView } from '../../shared/tdm.ts';
import { h } from './dom.ts';
import '../styles/round.css';

const TEAM_NAME = ['红队', '蓝队'];
const BANNER_MS = 2600;
const MATCH_BANNER_MS = 8000;

/** 团队死斗的开场事件（横幅）；其余战斗事件照旧走战斗 HUD 与音效 */
export const isTdmEvent = (e: CombatEvent): boolean => e.kind === 'matchStart';

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** 顶部比分行中间那两行文案的写入方：由 MatchScoreboard 实现，比分与点击 / Tab 行为仍归它 */
export interface TdmHeader {
  setHeadline(main: string, sub: string): void;
}

export interface TdmHudOpts {
  /** 0 红 / 1 蓝；观战或其他情况为其他值 */
  myTeam: number | undefined;
  /** 顶部唯一比分行（阶段与目标写进去，不再单独画一条比分条） */
  header: TdmHeader;
}

export class TdmHud {
  readonly el: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private view: TdmView | null = null;
  private phaseLine = '';
  private subLine = '';
  private bannerTimer = 0;
  private disposed = false;

  constructor(root: HTMLElement, private readonly o: TdmHudOpts) {
    this.bannerTitle = h('div', { class: 'round-banner-title' });
    this.bannerSub = h('div', { class: 'round-banner-sub' });
    this.banner = h('div', { class: 'round-banner', role: 'status', 'aria-live': 'polite', 'data-testid': 'tdm-banner' }, this.bannerTitle, this.bannerSub);
    this.el = h('div', { class: 'round-hud-root' }, this.banner);
    root.append(this.el);
    // 第一份 CombatUpdate 到达前：比分行只显示「比分 + 准备」，不写假数字（分数由 matchBoard 填）
    this.o.header.setHeadline('准备', '');
  }

  /** 每份 CombatUpdate 调一次：整场视图（比分不在这里画，见 update） */
  setView(v: TdmView): void {
    if (this.disposed) return;
    this.view = v;
  }

  /** 每帧调一次（tickFloat 与战斗 HUD 同口径）：准备倒计时 / 整场剩余 / 击杀目标 */
  update(tickFloat: number): void {
    const v = this.view;
    if (this.disposed || !v) return;
    const left = (end: number): number => Math.max(0, (end - tickFloat) / TICK_RATE);
    let line: string, sub: string;
    if (v.phase === 'pregame') {
      line = `准备 ${Math.ceil(left(v.prepEnd))} 秒`;
      sub = `先到 ${v.target} 杀获胜`;
    } else if (v.phase === 'live') {
      line = `剩余 ${clock(left(v.matchEnd))}`;
      sub = `先到 ${v.target} 杀获胜`;
    } else {
      line = '比赛结束';
      sub = `击杀目标 ${v.target}`;
    }
    // 文案只在变化时写 DOM（每秒一次），不在每帧改文本
    if (line === this.phaseLine && sub === this.subLine) return;
    this.phaseLine = line;
    this.subLine = sub;
    this.o.header.setHeadline(line, sub);
  }

  /** 开场事件（服务端只发一次）：战斗开始 */
  event(e: CombatEvent): void {
    if (this.disposed || e.kind !== 'matchStart') return;
    this.show('战斗开始', `先到 ${this.view ? this.view.target : 0} 杀获胜`, '');
  }

  /** 整场结束（S2C matchEnd；摘要只有团队死斗才有） */
  matchEnded(winner: number, summary: TdmMatchSummary | null): void {
    if (this.disposed || !summary) return;
    const score = `红 ${summary.kills[0]} : ${summary.kills[1]} 蓝`;
    if (winner === -1) {
      this.show('平局', `${score} · 击杀持平`, '', MATCH_BANNER_MS);
      return;
    }
    const mine = this.mine();
    const title = mine === null ? `${TEAM_NAME[winner] ?? ''}赢得比赛` : winner === mine ? '比赛胜利' : '比赛失利';
    const why = summary.reason === 'target' ? `先到 ${summary.target} 杀` : '时间到 · 击杀多者胜';
    this.show(title, `${score} · ${why}`, this.tone(winner), MATCH_BANNER_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.bannerTimer);
    this.el.remove();
  }

  /** 本人所在阵营（0 红 / 1 蓝）；观战为 null */
  private mine(): 0 | 1 | null {
    const t = this.o.myTeam;
    return t === 0 || t === 1 ? t : null;
  }

  /** 对「team 这一方」来说是好是坏：胜 / 负 / 中性 */
  private tone(team: number | null): string {
    const mine = this.mine();
    if (mine === null || team === null) return '';
    return team === mine ? 'win' : 'lose';
  }

  private show(title: string, sub: string, tone: string, ms = BANNER_MS): void {
    if (this.disposed) return;
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = sub;
    this.bannerSub.hidden = sub === '';
    this.banner.className = `round-banner on${tone ? ` ${tone}` : ''}`;
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('on'), ms);
  }
}