// tdm.ts — 团队死斗（TEAM DEATHMATCH）的公用合同：准备期 / 连续对局时长、整场视图与事件。
//   服务端权威：整场机在 server/tdm.ts，只它决定开打与胜负；客户端只读 CombatUpdate.tdm 与开场 / 结束事件来显示。
//   规则依据与取舍见 game/DESIGN.md §13（连续团队死斗：20 秒准备 → 9 分 30 秒 → 先到 100 杀，或时间到时杀多者胜，持平为平局）。
import { TICK_RATE } from './sim/tick.ts';
import type { Team } from './catalog.ts';

/** 时长（秒）。服务端按 32 Hz tick 换算（向上取整，与 weapons.ts 的 ticksFor 同口径）；改数值只改这里。 */
export const TDM = {
  /** 准备期：出生区内可选枪（官方 20 秒）。本项目没有选枪界面：这段时间不能开火，人机站桩 */
  pregameSec: 20,
  /** 对局时长：开场到整场结束共 570 秒（9 分 30 秒），中途不再分段；时间到时杀多者胜 */
  matchSec: 570,
  /** 阵亡后在己方出生区复活的等待（官方 1.5 秒） */
  respawnSec: 1.5,
  /** 复活后的出生保护（官方 15 秒无敌）。开火即取消（项目既有 SPEC 规则；出生区体积未建模，见 DESIGN §13） */
  protectSec: 15,
  /** 整场结算停留时间（之后房间回到等待） */
  resultSec: 8,
} as const;

/** 秒 → 服务器 tick（向上取整，与 weapons.ts 的 ticksFor 同口径） */
export const tdmTicks = (seconds: number): number => Math.ceil(seconds * TICK_RATE);

/** 对局时长（tick） */
export const TDM_MATCH_TICKS = tdmTicks(TDM.matchSec);

/** pregame 准备期 · live 对局进行 · over 整场结束 */
export type TdmPhase = 'pregame' | 'live' | 'over';
/** target 先到击杀目标 · time 时间到（杀多者胜） */
export type TdmReason = 'target' | 'time';

/** 整场结果：winner 为 -1 表示平局 */
export interface TdmResult {
  winner: Team | -1;
  reason: TdmReason;
}

/** 每个 CombatUpdate（16 Hz）附带一份：全队都能看到的整场信息 */
export interface TdmView {
  phase: TdmPhase;
  /** 击杀目标（先到者获胜） */
  target: number;
  /** 红 / 蓝本局累计击杀 */
  kills: [number, number];
  /** 准备期结束（开打）的服务器 tick；只在 pregame 期间有效，其余为 0 */
  prepEnd: number;
  /** 整场计时结束的服务器 tick；只在 live 期间有效，其余为 0 */
  matchEnd: number;
  /** 整场结果（over） */
  result: TdmResult | null;
}

/** 整场机发出的事件；matchStart 经 CombatUpdate.events 下发一次，matchEnd 由 match 转成 S2C matchEnd */
export type TdmEvent =
  | { kind: 'matchStart' }
  | { kind: 'matchEnd'; winner: Team | -1; reason: TdmReason; kills: [number, number] };