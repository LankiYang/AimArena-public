// round-hud.ts — 爆破模式的回合显示：顶部回合条（比分 / 阶段倒计时 / 包的状态）、居中横幅（回合开始、安放、拆除、引爆、回合结果、整场结束）、安放 / 拆除读条。
//
// 规矩：阶段、比分、倒计时、读条进度都来自服务端 SndView（随 CombatUpdate 下发）；横幅来自同一条 CombatUpdate 里按序到达的回合事件。
//   这里只负责画，不判胜负、不推断阶段；倒计时用本地 tickFloat 平滑（与战斗 HUD 同口径）。
import type { CombatEvent } from '../../shared/combat.ts';
import type { SndMatchSummary } from '../../shared/lobby.ts';
import { SND, sndTicks, type SndReason, type SndView } from '../../shared/snd.ts';
import { TICK_RATE } from '../../shared/sim/tick.ts';
import { h } from './dom.ts';
import '../styles/round.css';

const TEAM_NAME = ['红队', '蓝队'];
const REASON_TEXT: Record<SndReason, string> = { elim: '全灭对手', time: '时间耗尽', detonate: '炸弹引爆', defuse: '炸弹拆除' };
const BANNER_MS = 2600;
const MATCH_BANNER_MS = 8000;
const PLANT_TICKS = sndTicks(SND.plantSec);
const DEFUSE_TICKS = sndTicks(SND.defuseSec);
const ROUND_KINDS = new Set<string>(['roundStart', 'pickup', 'drop', 'plant', 'defuse', 'detonate', 'roundEnd']);

/** 回合机发出的事件（横幅 / 回合条处理）；其余战斗事件照旧走战斗 HUD 与音效 */
export const isRoundEvent = (e: CombatEvent): boolean => ROUND_KINDS.has(e.kind);

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function phaseText(v: SndView, left: number): string {
  switch (v.phase) {
    case 'buy': return `购买阶段 ${Math.ceil(left)}s`;
    case 'live': return `回合中 ${clock(left)}`;
    case 'planted': return `引爆 ${clock(left)}`;
    case 'end': return `回合结束 ${Math.ceil(left)}s`;
    default: return '比赛结束';
  }
}

function spikeText(v: SndView, myId: number): string {
  switch (v.spike) {
    case 'carried': return v.carrier === myId ? '你持有炸弹' : '炸弹被携带';
    case 'dropped': return '炸弹掉在地上';
    case 'planted': return v.site ? `${v.site} 点已安放` : '炸弹已安放';
    case 'defused': return '炸弹已拆除';
    default: return '炸弹已引爆';
  }
}

export interface RoundHudOpts {
  myId: number;
  /** 0 红 / 1 蓝；观战或其他情况为其他值 */
  myTeam: number | undefined;
  names: Map<number, string>;
}

export class RoundHud {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly scoreRed: HTMLElement;
  private readonly scoreBlue: HTMLElement;
  private readonly phaseLabel: HTMLElement;
  private readonly subLabel: HTMLElement;
  private readonly channel: HTMLElement;
  private readonly channelLabel: HTMLElement;
  private readonly channelFill: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private view: SndView | null = null;
  private phaseLine = '';
  private bannerTimer = 0;
  private disposed = false;

  constructor(root: HTMLElement, private readonly o: RoundHudOpts) {
    this.scoreRed = h('b', { class: 'round-score red', 'data-testid': 'round-red' }, '0');
    this.scoreBlue = h('b', { class: 'round-score blue', 'data-testid': 'round-blue' }, '0');
    this.phaseLabel = h('span', { class: 'round-phase', 'data-testid': 'round-phase' });
    this.subLabel = h('div', { class: 'round-sub' });
    this.bar = h('div', { class: 'round-bar', hidden: true, 'data-testid': 'round-bar' },
      h('div', { class: 'round-bar-main' }, this.scoreRed, this.phaseLabel, this.scoreBlue),
      this.subLabel);
    this.channelLabel = h('div', { class: 'round-channel-label' });
    this.channelFill = h('i', { class: 'round-channel-fill' });
    this.channel = h('div', { class: 'round-channel', hidden: true, 'data-testid': 'round-channel' },
      this.channelLabel, h('div', { class: 'round-channel-track' }, this.channelFill));
    this.bannerTitle = h('div', { class: 'round-banner-title' });
    this.bannerSub = h('div', { class: 'round-banner-sub' });
    this.banner = h('div', { class: 'round-banner', role: 'status', 'aria-live': 'polite', 'data-testid': 'round-banner' }, this.bannerTitle, this.bannerSub);
    this.el = h('div', { class: 'round-hud-root' }, this.bar, this.channel, this.banner);
    root.append(this.el);
  }

  /** 每份 CombatUpdate 调一次：比分、回合号、攻守、包的状态 */
  setView(v: SndView): void {
    if (this.disposed) return;
    this.view = v;
    this.bar.hidden = false;
    this.scoreRed.textContent = String(v.wins[0]);
    this.scoreBlue.textContent = String(v.wins[1]);
    this.subLabel.textContent = `第 ${v.round} 回合 · ${TEAM_NAME[v.attack]}进攻 · ${spikeText(v, this.o.myId)}`;
  }

  /** 每帧调一次（tickFloat 与战斗 HUD 同口径）：倒计时与读条 */
  update(tickFloat: number): void {
    const v = this.view;
    if (this.disposed || !v) return;
    const left = v.phaseEnd > 0 ? Math.max(0, (v.phaseEnd - tickFloat) / TICK_RATE) : 0;
    const line = phaseText(v, left);
    if (line !== this.phaseLine) {
      this.phaseLine = line;
      this.phaseLabel.textContent = line;
    }
    const frac = v.channel === 'plant' ? v.plantTicks / PLANT_TICKS : v.channel === 'defuse' ? v.defuseTicks / DEFUSE_TICKS : -1;
    this.channel.hidden = frac < 0;
    if (frac >= 0) {
      this.channelLabel.textContent = v.channel === 'plant' ? '安放炸弹' : '拆除炸弹';
      this.channelFill.style.width = `${Math.min(1, frac) * 100}%`;
    }
  }

  /** 回合事件（按服务端顺序；只处理回合类事件） */
  event(e: CombatEvent): void {
    if (this.disposed || !isRoundEvent(e)) return;
    const attack = this.view ? this.view.attack : null;
    switch (e.kind) {
      case 'roundStart': {
        const mine = this.mine();
        const sub = mine === null ? `${TEAM_NAME[e.attack]}进攻 · ${TEAM_NAME[1 - e.attack]}防守`
          : mine === e.attack ? '你方进攻：安放炸弹' : '你方防守：阻止安放与拆除';
        this.show(`第 ${e.round} 回合`, sub, '');
        break;
      }
      case 'plant':
        this.show('炸弹已安放', `${this.name(e.player)} 在 ${e.site} 点安放`, this.tone(attack));
        break;
      case 'defuse':
        this.show('炸弹已拆除', `${this.name(e.player)} 在 ${e.site} 点拆除`, this.tone(attack === null ? null : 1 - attack));
        break;
      case 'detonate':
        this.show('炸弹爆炸', `${e.site} 点`, this.tone(attack));
        break;
      case 'pickup':
        if (e.player === this.o.myId) this.show('你拾起了炸弹', '', '', 1400);
        break;
      case 'drop':
        if (e.player === this.o.myId) this.show('你掉落了炸弹', '', '', 1400);
        break;
      case 'roundEnd': {
        const mine = this.mine();
        const title = mine === null ? `${TEAM_NAME[e.winner]}赢得本回合` : e.winner === mine ? '本回合胜利' : '本回合失利';
        this.show(title, `${REASON_TEXT[e.reason]} · 红 ${e.wins[0]} : ${e.wins[1]} 蓝`, this.tone(e.winner));
        break;
      }
      default:
        break;
    }
  }

  /** 整场结束（S2C matchEnd；summary 只有爆破模式才有） */
  matchEnded(winner: number, summary: SndMatchSummary | null): void {
    if (this.disposed || !summary) return;
    const mine = this.mine();
    const title = mine === null ? `${TEAM_NAME[winner] ?? ''}赢得比赛` : winner === mine ? '比赛胜利' : '比赛失利';
    this.show(title, `红 ${summary.wins[0]} : ${summary.wins[1]} 蓝 · 共 ${summary.rounds} 回合`, this.tone(winner), MATCH_BANNER_MS);
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

  private name(id: number): string {
    return this.o.names.get(id) ?? '玩家';
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
