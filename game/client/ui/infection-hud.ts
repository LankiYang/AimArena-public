import { h } from './dom.ts';
import { TICK_RATE } from '../../shared/sim/tick.ts';
import '../styles/infection.css';

export type InfectionPhase = 'prepare' | 'active' | 'ended';
export interface InfectionState {
  phase: InfectionPhase;
  humans: number[];
  infected: number[];
  remainingTicks: number;
  winner: 0 | 1 | null;
}

/** Runtime guard for the server-authoritative infectionState JSON frame. */
export function isInfectionState(value: unknown): value is InfectionState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.humans) || !Array.isArray(v.infected)) return false;
  if (!v.humans.every((id) => Number.isSafeInteger(id)) || !v.infected.every((id) => Number.isSafeInteger(id))) return false;
  if (!Number.isFinite(v.remainingTicks) || Number(v.remainingTicks) < 0) return false;
  if (v.winner !== null && v.winner !== 0 && v.winner !== 1) return false;
  return true;
}

const clock = (ticks: number): string => {
  const seconds = Math.max(0, ticks / TICK_RATE);
  if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return `${Math.ceil(seconds)}s`;
};

/** Compact, touch-safe status bar for the infection mode. All state comes from infectionState. */
export class InfectionHud {
  readonly el: HTMLElement;
  private readonly phase: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly humans = new Set<number>();
  private readonly infected = new Set<number>();
  private readonly counts: HTMLElement;
  private readonly status: HTMLElement;
  private state: InfectionState | null = null;
  private stateTick = 0;
  private disposed = false;

  constructor(root: HTMLElement, private readonly myId: number) {
    this.phase = h('strong', { class: 'infection-phase', 'data-testid': 'infection-phase' }, '等待同步');
    this.timer = h('b', { class: 'infection-time', 'data-testid': 'infection-time' }, '—');
    this.counts = h('span', { class: 'infection-counts', 'data-testid': 'infection-counts' }, '人类 — · 感染者 —');
    this.status = h('span', { class: 'infection-status', 'data-testid': 'infection-status' }, '等待感染状态');
    this.el = h('section', { class: 'infection-hud', role: 'status', 'aria-live': 'polite', 'data-testid': 'infection-hud' },
      h('div', { class: 'infection-main' }, this.phase, this.timer),
      this.counts,
      this.status,
    );
    root.append(this.el);
  }

  setState(state: InfectionState, tick: number): void {
    if (this.disposed) return;
    this.humans.clear();
    this.infected.clear();
    for (const id of state.humans) this.humans.add(id);
    for (const id of state.infected) this.infected.add(id);
    this.state = state;
    this.stateTick = Number.isFinite(tick) ? tick : 0;
    const human = this.humans.has(this.myId);
    const infected = this.infected.has(this.myId);
    this.el.classList.toggle('is-human', human);
    this.el.classList.toggle('is-infected', infected);
    this.el.classList.toggle('is-ended', state.phase === 'ended');
    this.counts.textContent = `人类 ${state.humans.length} · 感染者 ${state.infected.length}`;
    if (state.phase === 'prepare') this.phase.textContent = '准备阶段';
    else if (state.phase === 'active') this.phase.textContent = '生化对局';
    else this.phase.textContent = '对局结束';
    if (state.phase === 'ended') {
      this.timer.textContent = '结束';
      const ownTeam = human ? 0 : infected ? 1 : undefined;
      this.status.textContent = state.winner === null ? '平局' : ownTeam === undefined ? (state.winner === 0 ? '人类获胜' : '感染者获胜') : state.winner === ownTeam ? '你方获胜' : '你方失败';
    } else {
      this.timer.textContent = clock(state.remainingTicks);
      this.status.textContent = human ? '你是人类 · 使用枪械求生' : infected ? '你是感染者 · 仅可近战' : '观战中';
    }
  }

  update(tick: number): void {
    const state = this.state;
    if (this.disposed || !state || state.phase === 'ended') return;
    const left = Math.max(0, state.remainingTicks - Math.max(0, tick - this.stateTick));
    this.timer.textContent = clock(left);
  }

  get currentTeam(): 0 | 1 | undefined { return this.teamOf(this.myId); }

  teamOf(id: number): 0 | 1 | undefined {
    if (!this.state) return undefined;
    if (this.infected.has(id)) return 1;
    if (this.humans.has(id)) return 0;
    return undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.el.remove();
  }
}
