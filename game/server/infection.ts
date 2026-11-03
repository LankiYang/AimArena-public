// infection.ts — 服务端权威经典生化规则机。
// 不接触网络、世界或战斗；match 负责把角色变化应用到 CombatSystem / Player。
import {
  INFECTION_ACTIVE_TICKS, INFECTION_PREPARE_TICKS,
  type InfectionPhase, type InfectionState, type Team,
} from '../shared/infection.ts';

export interface InfectionRulesOptions {
  /** 手动验收可指定母体；生产环境省略时使用稳定的随机选取。 */
  motherId?: number;
  random?: () => number;
}

export class InfectionRules {
  private phase: InfectionPhase = 'prepare';
  private prepareEnd = 0;
  private activeEnd = 0;
  private winner: Team | null = null;
  private humansSet = new Set<number>();
  private infectedSet = new Set<number>();
  private readonly motherId?: number;
  private readonly random: () => number;

  constructor(opts: InfectionRulesOptions = {}) {
    this.motherId = opts.motherId;
    this.random = opts.random ?? Math.random;
  }

  /** 初始化名单并进入 20 秒准备期；至少两名参与者由大厅 / match 校验。 */
  start(tick: number, ids: readonly number[]): InfectionState {
    this.phase = 'prepare';
    this.prepareEnd = tick + INFECTION_PREPARE_TICKS;
    this.activeEnd = this.prepareEnd + INFECTION_ACTIVE_TICKS;
    this.winner = null;
    this.humansSet = new Set(ids);
    this.infectedSet.clear();
    return this.view(tick);
  }

  /** 每 tick 推进阶段与时间胜负；返回可直接发送的快照。 */
  step(tick: number): InfectionState {
    this.advance(tick);
    return this.view(tick);
  }

  /** 只推进规则，不构造网络快照。 */
  advance(tick: number): void {
    if (this.phase === 'prepare' && tick >= this.prepareEnd) {
      const ids = [...this.humansSet];
      if (ids.length) {
        const selected = this.motherId !== undefined && this.humansSet.has(this.motherId)
          ? this.motherId
          : ids[Math.min(ids.length - 1, Math.max(0, Math.floor(this.random() * ids.length)))];
        this.humansSet.delete(selected);
        this.infectedSet.add(selected);
      }
      this.phase = 'active';
    }
    if (this.phase === 'active') {
      if (!this.humansSet.size) this.finish(1);
      else if (tick >= this.activeEnd) this.finish(0);
    }
  }

  /** 人类被感染者近战命中后调用；非活动期、重复感染和已结束都忽略。 */
  infect(id: number): boolean {
    if (this.phase !== 'active' || !this.humansSet.delete(id)) return false;
    this.infectedSet.add(id);
    if (!this.humansSet.size) this.finish(1);
    return true;
  }

  /** 对局中途加入按人类加入；结束后不再接纳新角色。 */
  addPlayer(id: number): boolean {
    if (this.phase === 'ended' || this.humansSet.has(id) || this.infectedSet.has(id)) return false;
    this.humansSet.add(id);
    return true;
  }

  /** 断线 / 离场从双方名单移除；不把离场误判成感染。 */
  removePlayer(id: number): boolean {
    return this.humansSet.delete(id) || this.infectedSet.delete(id);
  }

  phaseNow(): InfectionPhase { return this.phase; }
  winnerNow(): Team | null { return this.winner; }
  isHuman(id: number): boolean { return this.humansSet.has(id); }
  isInfected(id: number): boolean { return this.infectedSet.has(id); }

  view(tick: number): InfectionState {
    const remainingTicks = this.phase === 'prepare'
      ? Math.max(0, this.prepareEnd - tick)
      : this.phase === 'active' ? Math.max(0, this.activeEnd - tick) : 0;
    return {
      t: 'infectionState',
      phase: this.phase,
      humans: [...this.humansSet],
      infected: [...this.infectedSet],
      remainingTicks,
      winner: this.winner,
    };
  }

  private finish(winner: Team) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.winner = winner;
  }
}
