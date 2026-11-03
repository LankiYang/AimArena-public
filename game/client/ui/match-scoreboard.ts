import type { Mode, Team } from '../../shared/catalog.ts';
import type { InfectionState } from './infection-hud.ts';
import type { MatchBoard, MatchScoreRow } from '../../shared/lobby.ts';
import type { Connection } from '../net/socket.ts';
import { agentArt } from './art.ts';
import { h } from './dom.ts';
import { trapTab } from './overlay.ts';
import '../styles/match-intel.css';

interface ScoreboardOpts {
  myId: number;
  myTeam?: number;
  touch: boolean;
  conn: Pick<Connection, 'probeLatency' | 'rtt' | 'status' | 'transport'>;
  /** tdm：这一行同时兼任整场阶段（准备倒计时 / 剩余时间 / 击杀目标），不再另开一条 round-bar */
  mode?: Mode;
  /** 返回 false 表示菜单/装备窗口占用中，不叠第二层。 */
  onOpenDialog: () => boolean;
  onCloseDialog: () => void;
  onVisibilityChange?: () => void;
}
interface RowNodes {
  el: HTMLTableRowElement;
  name: HTMLElement;
  badge: HTMLElement;
  image: HTMLImageElement;
  numbers: HTMLTableCellElement[];
  state: HTMLElement;
}
const text = (el: HTMLElement, value: string | number) => { const s = String(value); if (el.textContent !== s) el.textContent = s; };

/** 本局实时 K/D/A；与 B 站「累计击杀排行榜」完全分开，不调用 SDK。 */
export class MatchScoreboard {
  readonly button: HTMLButtonElement;
  private readonly overlay: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly scoreText: HTMLElement[];
  /** 中间那一栏：主行（TDM 阶段 / SND 比分口径）与副行（TDM 击杀目标 / SND 操作提示） */
  private readonly headMain: HTMLElement;
  private readonly headSub: HTMLElement;
  private readonly headNote: HTMLElement;
  private readonly noteText: HTMLElement;
  private readonly teamTitles: HTMLElement[] = [];
  private readonly teamTotals: HTMLElement[] = [];
  private readonly bodies: HTMLTableSectionElement[] = [];
  private readonly rows = new Map<number, RowNodes>();
  private readonly empty: HTMLElement;
  private readonly latency: HTMLElement;
  private latencyTimer: number | null = null;
  private mode: 'peek' | 'dialog' | null = null;
  private disposed = false;
  private board: MatchBoard | null = null;
  private infection: InfectionState | null = null;

  constructor(root: HTMLElement, private readonly o: ScoreboardOpts) {
    this.scoreText = [h('b', { 'data-testid': 'live-red-score' }, '—'), h('b', { 'data-testid': 'live-blue-score' }, '—')];
    this.headMain = h('span', { 'data-testid': 'live-phase' }, o.mode === 'infection' ? '阵营人数' : '团队击杀');
    this.headSub = h('small', { 'data-testid': 'live-sub' }, o.touch ? '点按战绩' : 'Tab 战绩');
    this.button = h('button', { type: 'button', class: 'live-score', 'data-testid': 'match-score-open',
      title: o.touch ? '点按查看本局战绩' : '按住 Tab 查看战绩',
      'aria-label': '查看本局双方比分和每位玩家的击杀、死亡、助攻', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      onmousedown: (e: MouseEvent) => e.stopPropagation(), onclick: () => this.open('dialog') },
      h('span', { class: ['score-side', 'red', o.myTeam === 0 && 'my-team'] }, h('small', null, o.mode === 'infection' ? '人类' : '红队'), this.scoreText[0]),
      h('span', { class: 'score-context' }, this.headMain, this.headSub),
      h('span', { class: ['score-side', 'blue', o.myTeam === 1 && 'my-team'] }, this.scoreText[1], h('small', null, o.mode === 'infection' ? '感染者' : '蓝队')));
    if (o.mode === 'tdm' || o.mode === 'infection') this.button.classList.add('is-tdm');
    const teams = h('div', { class: 'match-score-teams' });
    for (const team of [0, 1] as Team[]) {
      const name = o.mode === 'infection' ? (team === 0 ? '人类' : '感染者') : (team === 0 ? '红队' : '蓝队');
      const relation = o.myTeam === 0 || o.myTeam === 1 ? (o.myTeam === team ? ' · 友方' : ' · 敌方') : '';
      const title = h('strong', null, name + relation), total = h('span', null, '等待同步');
      const tbody = h('tbody');
      this.teamTitles.push(title); this.teamTotals.push(total); this.bodies.push(tbody);
      teams.append(h('section', { class: `match-score-team ${team === 0 ? 'red' : 'blue'}`, 'data-team': team },
        h('div', { class: 'match-score-team-head' }, title, total),
        h('table', { 'aria-label': name + '本局战绩' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, '玩家'), ...['K 击杀', 'D 死亡', 'A 助攻'].map(s => h('th', { scope: 'col' }, s)))), tbody)));
    }
    this.empty = h('p', { class: 'match-score-empty', role: 'status' }, '等待服务器战绩…');
    this.latency = h('span', { class: 'match-score-latency', 'data-testid': 'match-score-latency', title: '应用层往返时间（WebSocket / WebTransport）' }, '延迟 —');
    this.closeButton = h('button', { type: 'button', class: 'btn ghost', 'data-testid': 'match-score-close', onclick: () => this.close() }, '返回游戏');
    this.panel = h('section', { class: 'match-score-panel', role: 'dialog', 'aria-labelledby': 'match-score-title', 'data-testid': 'match-scoreboard' },
      h('header', { class: 'match-score-head' }, h('h2', { id: 'match-score-title' }, '本局战绩'), h('span', null, o.mode === 'infection' ? '实时 · 阵营人数' : '实时 · 团队击杀'), this.latency),
      h('div', { class: 'match-score-body', 'data-testid': 'match-score-scroll', tabindex: 0 }, this.empty, teams,
        h('p', { class: 'match-score-note' }, o.mode === 'infection' ? '顶部显示人类与感染者人数；下表显示本局击杀、死亡和助攻。' : 'K / D / A = 击杀 / 死亡 / 助攻。助攻：目标死亡前 10 秒内造成至少 50 点实际伤害。双方比分为本局累计击杀，不是爆破回合胜场。')),
      h('footer', { class: 'match-score-foot' }, h('small', null, o.touch ? '对局仍在进行' : '按住 Tab 查看，松开收起'), this.closeButton));
    this.overlay = h('div', { class: 'match-score-wrap', hidden: true,
      onmousedown: (e: MouseEvent) => { e.stopPropagation(); if (e.target === this.overlay && this.mode === 'dialog') this.close(); } }, this.panel);
    this.headNote = this.panel.querySelector<HTMLElement>('.match-score-head span') as HTMLElement;
    this.noteText = this.panel.querySelector<HTMLElement>('.match-score-note') as HTMLElement;
    root.append(this.button, this.overlay);
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
  }

  get isOpen() { return this.mode !== null; }
  get isModal() { return this.mode === 'dialog'; }
  get snapshot() { return this.board; }
  /** 只读最新权威数据，测试不需要注入战绩。 */
  setMyTeam(team: number | undefined): void {
    this.o.myTeam = team;
    this.button.querySelectorAll<HTMLElement>('.score-side').forEach((side, index) => {
      side.classList.toggle('my-team', team === index);
    });
    for (const [index, title] of this.teamTitles.entries()) {
      const name = this.o.mode === 'infection' ? (index === 0 ? '人类' : '感染者') : (index === 0 ? '红队' : '蓝队');
      title.textContent = name + (team === index ? ' · 友方' : team === 0 || team === 1 ? ' · 敌方' : '');
    }
  }

  /**
   * TDM：把整场的阶段文案（准备倒计时 / 剩余时间 / 比赛结束）与击杀目标写进顶部这一行。
   * 分数仍只由 update() 从 matchBoard 写；这里不引入第二个比分来源。
   */
  setHeadline(main: string, sub: string): void {
    if (this.disposed) return;
    text(this.headMain, main);
    text(this.headSub, sub);
  }
  setInfectionState(state: InfectionState): void {
    if (this.disposed || this.o.mode !== 'infection') return;
    this.infection = state;
    text(this.scoreText[0], state.humans.length);
    text(this.scoreText[1], state.infected.length);
    this.button.setAttribute('aria-label', `人类 ${state.humans.length}，感染者 ${state.infected.length}。查看本局每位玩家的 K/D/A`);
    if (this.board) this.update(this.board);
  }

  update(board: MatchBoard) {
    if (this.disposed || (this.board && (board.matchId !== this.board.matchId || board.tick < this.board.tick))) return;
    this.board = board;
    const rounds = this.o.mode === 'infection' ? undefined : board.rounds;
    if (rounds) {
      // 爆破模式：大字是回合胜场，说明文字随之改成回合口径
      text(this.headMain, '回合胜场');
      text(this.headNote, '实时 · 回合胜场');
      text(this.noteText, 'K / D / A = 击杀 / 死亡 / 助攻。助攻：目标死亡前 10 秒内造成至少 50 点实际伤害。双方大字为回合胜场，下方为每队本局击杀与存活。');
    }
    for (const team of [0, 1] as Team[]) {
      if (this.o.mode !== 'infection') text(this.scoreText[team], rounds ? rounds[team] : board.teamKills[team]);
      const ids = this.infection && (team === 0 ? this.infection.humans : this.infection.infected);
      const players = board.players.filter(p => ids ? ids.includes(p.id) : p.team === team).sort((a, b) => b.kills - a.kills || b.assists - a.assists || a.deaths - b.deaths || a.id - b.id);
      text(this.teamTotals[team], `${board.teamKills[team]} 击杀 · ${players.filter(p => p.alive).length}/${players.length} 存活`);
      for (const p of players) {
        let row = this.rows.get(p.id);
        if (!row) { row = this.createRow(p); this.rows.set(p.id, row); }
        text(row.name, p.name); row.name.title = p.name;
        text(row.badge, p.id === this.o.myId ? '你' : p.bot ? 'BOT' : '');
        if (row.image.dataset.agent !== p.agent) { row.image.src = agentArt(p.agent); row.image.dataset.agent = p.agent; }
        [p.kills, p.deaths, p.assists].forEach((n, i) => text(row!.numbers[i], n));
        row.el.classList.toggle('is-self', p.id === this.o.myId);
        row.el.classList.toggle('is-dead', !p.alive);
        row.el.dataset.alive = String(p.alive); row.el.dataset.team = String(team);
        row.state.title = p.alive ? '存活' : '等待复活';
        row.el.setAttribute('aria-label', `${p.name}，击杀 ${p.kills}，死亡 ${p.deaths}，助攻 ${p.assists}，${p.alive ? '存活' : '等待复活'}`);
      }
      // 仅在名次/成员变化时移动既有节点，不整表重建，保留原生滚动位置。
      players.forEach((p, i) => { const row = this.rows.get(p.id)!.el; if (this.bodies[team].children[i] !== row) this.bodies[team].insertBefore(row, this.bodies[team].children[i] ?? null); });
    }
    const ids = new Set(board.players.map(p => p.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.el.remove(); this.rows.delete(id); }
    this.empty.hidden = true;
    if (this.o.mode !== 'infection') {
      const shown = rounds ?? board.teamKills;
      this.button.setAttribute('aria-label', `红队 ${shown[0]}，蓝队 ${shown[1]}（${rounds ? '回合胜场' : '团队击杀'}）。查看本局每位玩家的 K/D/A`);
    }
    this.button.dataset.tick = String(board.tick);
  }

  private createRow(p: MatchScoreRow): RowNodes {
    const image = h('img', { alt: '', loading: 'lazy', draggable: false });
    const name = h('span', { class: 'match-score-name' }), badge = h('small', { class: 'match-score-badge' });
    const state = h('i', { class: 'match-score-state', 'aria-hidden': 'true' });
    const numbers = [0, 0, 0].map(() => h('td', { class: 'match-score-number' }));
    const el = h('tr', { 'data-testid': 'match-score-player', 'data-id': p.id },
      h('td', null, h('div', { class: 'match-score-identity' }, image, state, name, badge)), ...numbers);
    return { el, image, name, badge, state, numbers };
  }

  open(mode: 'peek' | 'dialog' = 'dialog'): boolean {
    if (this.disposed || this.mode) return false;
    if (mode === 'dialog' && !this.o.onOpenDialog()) return false;
    this.mode = mode;
    this.overlay.classList.toggle('is-peek', mode === 'peek');
    this.panel.setAttribute('aria-modal', String(mode === 'dialog'));
    this.overlay.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.updateLatency();
    this.latencyTimer = window.setInterval(() => this.updateLatency(), 1000);
    if (mode === 'dialog') this.closeButton.focus({ preventScroll: true });
    this.o.onVisibilityChange?.();
    return true;
  }

  close(restoreFocus = true) {
    if (!this.mode) return;
    const wasModal = this.isModal;
    if (this.latencyTimer !== null) { clearInterval(this.latencyTimer); this.latencyTimer = null; }
    this.mode = null; this.overlay.hidden = true; this.button.setAttribute('aria-expanded', 'false');
    if (wasModal) {
      this.o.onCloseDialog();
      if (restoreFocus && !this.disposed && this.button.isConnected) this.button.focus({ preventScroll: true });
    }
    if (!this.disposed) this.o.onVisibilityChange?.();
  }
  peek(down: boolean) { if (down) this.open('peek'); else if (this.mode === 'peek') this.close(false); }
  private updateLatency() {
    const conn = this.o.conn;
    conn.probeLatency();
    text(this.latency, `延迟 ${conn.status === 'open' && conn.rtt !== null ? `${conn.rtt} ms` : '—'} · ${conn.transport === 'webtransport' ? 'WT' : 'WS'}`);
  }
  private onBlur = () => { if (this.mode === 'peek') this.close(false); };
  private onKeyUp = (e: KeyboardEvent) => { if (this.isModal) e.stopPropagation(); };
  private onKey = (e: KeyboardEvent) => {
    if (!this.isModal) return;
    // 触摸设备 Input.locked 恒 true；弹窗内的 WASD/B/数字键不能穿透成游戏命令。
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (!e.repeat) this.close(); }
    else if (e.key === 'Tab') trapTab(e, this.panel);
  };
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.close(false);
    document.removeEventListener('keydown', this.onKey, true); document.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    this.overlay.remove(); this.button.remove(); this.rows.clear(); this.board = null;
  }
}
