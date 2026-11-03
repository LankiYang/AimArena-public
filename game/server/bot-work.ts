// 只约束可延后的 AI 导航查询；物理、瞄准、射击和网络 tick 不经此预算。
import { TICK_RATE } from '../shared/sim/tick.ts';

export const BOT_WORK_LIMITS = Object.freeze({ roomQueries: 4, roomMs: 2, processQueries: 12, processMs: 5, planSlots: 8 });
/**
 * 高级团队战术（T1/T2/T3）的导航查询成本约定，与 BOT_WORK_LIMITS 配套：
 * - T1 默认点位：与普通巡逻共用同一条路径查询，沿用原额度；
 * - T1 响应支援：0 次查询（直线水平距离判定，BotBrain 直接 move，不查路径）；
 * - T2 撤退：0 次查询（向队友身后的撤退点直线后退）；
 * - T2 补位 / T3 交叉火力：从现有掩体 / 探头额度里挪（同一份 roomQueries / roomMs / planSlots，不新增）。
 * 所以 BOT_WORK_LIMITS 不上调；bot-work-check.mjs 与 bot-tactics-check.mjs 据此校验预算没被放大。
 */
export const TACTIC_NAV_QUERIES = Object.freeze({ patrol: 1, respond: 0, retreat: 0, fill: 1, crossfire: 0 });
type Clock = () => number;

/** 所有实时房间共用同一墙钟窗口，防止每个房间各自用满预算。 */
export class SharedBotWork {
  private start = -Infinity;
  private queries = 0;
  private spent = 0;
  private clock: Clock;
  constructor(clock: Clock = () => performance.now()) { this.clock = clock; }

  take(): boolean {
    const now = this.clock();
    if (now - this.start >= 1000 / TICK_RATE) { this.start = now; this.queries = 0; this.spent = 0; }
    if (this.queries >= BOT_WORK_LIMITS.processQueries || this.spent >= BOT_WORK_LIMITS.processMs) return false;
    this.queries++;
    return true;
  }
  charge(ms: number): void { this.spent += ms; }
}

const shared = new SharedBotWork();

export class BotWorkBudget {
  private tick = -1;
  private queries = 0;
  private spent = 0;
  private totals = { queries: 0, deferred: 0, queryMs: 0, maxQueryMs: 0, maxTickQueries: 0, maxTickMs: 0 };
  private processBudget: SharedBotWork | null;
  private clock: Clock;

  /** 离线加速模拟使用 null：按模拟 tick 预算，不受实际墙钟窗口限制。 */
  constructor(processBudget: SharedBotWork | null = shared, clock: Clock = () => performance.now()) {
    this.processBudget = processBudget; this.clock = clock;
  }

  begin(tick: number): void {
    if (this.tick === tick) return;
    this.tick = tick; this.queries = this.spent = 0;
  }

  /** undefined 表示延期，null 仍表示真正查询失败；延期不能触发卡住 / 不可达处理。 */
  run<T>(query: () => T): T | undefined {
    if (this.queries >= BOT_WORK_LIMITS.roomQueries || this.spent >= BOT_WORK_LIMITS.roomMs ||
        (this.processBudget && !this.processBudget.take())) {
      this.totals.deferred++;
      return undefined;
    }
    this.queries++; this.totals.queries++;
    const start = this.clock();
    try { return query(); }
    finally {
      const elapsed = Math.max(0, this.clock() - start);
      this.spent += elapsed; this.processBudget?.charge(elapsed);
      this.totals.queryMs += elapsed;
      this.totals.maxQueryMs = Math.max(this.totals.maxQueryMs, elapsed);
      this.totals.maxTickQueries = Math.max(this.totals.maxTickQueries, this.queries);
      this.totals.maxTickMs = Math.max(this.totals.maxTickMs, this.spent);
    }
  }

  planSlot(id: number, tick: number): boolean { return Math.abs(id) % BOT_WORK_LIMITS.planSlots === tick % BOT_WORK_LIMITS.planSlots; }
  stats() { return { ...this.totals }; }
}
