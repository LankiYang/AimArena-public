// snd.ts — 爆破模式（SEARCH & DESTROY）的公用合同：回合阶段、时长、事件与回合视图。
//   服务端权威：回合机在 server/snd.ts，只它决定阶段 / 胜负 / 安拆；客户端只读 CombatUpdate.round 与战斗事件来显示。
//   规则依据与取舍见 game/DESIGN.md §7（战术射击爆破：购买阶段 → 回合 → 安包 4 秒 → 引爆 45 秒 → 拆包 7 秒，半场换边）。
import { TICK_RATE } from './sim/tick.ts';
import type { Team } from './catalog.ts';
import type { V3 } from './combat.ts';

/** 时长（秒）。服务端按 32 Hz tick 换算；改数值只改这里。 */
export const SND = {
  /** 购买 / 就位阶段：可以走位、换枪，不能开火 */
  buySec: 30,
  /** 回合时限：购买结束后开始计时；安包前到时防守方胜 */
  roundSec: 100,
  /** 安放：包点内连续按住使用键 4 秒；期间定身、不能开枪；松键或离开包点清零 */
  plantSec: 4,
  /** 安包后的引爆倒计时 */
  detonateSec: 45,
  /** 拆除：包点内连续按住 7 秒；期间定身、不能开枪；松键时进度 ≥ 3.5 秒则存档在 3.5 秒，否则清零 */
  defuseSec: 7,
  defuseCheckpointSec: 3.5,
  /** 回合结果停留时间（之后下一回合购买阶段开始） */
  endSec: 7,
  /** 整场结束后的结算停留时间（之后房间回到等待） */
  resultSec: 8,
  /** 捡包：进攻方水平距离（米）与高度差（米） */
  pickupRadius: 1.8,
  pickupHeight: 1.5,
} as const;

/** 秒 → 服务器 tick（向上取整，与 weapons.ts 的 ticksFor 同口径） */
export const sndTicks = (seconds: number): number => Math.ceil(seconds * TICK_RATE);

/** buy 购买 · live 回合进行 · planted 已安包 · end 回合结算 · over 整场结束 */
export type SndPhase = 'buy' | 'live' | 'planted' | 'end' | 'over';
/** elim 全灭 · time 时间到 · detonate 引爆 · defuse 拆除 */
export type SndReason = 'elim' | 'time' | 'detonate' | 'defuse';
/** carried 有人持有 · dropped 掉在地上 · planted 已安放 · defused 已拆 · detonated 已引爆 */
export type SndSpike = 'carried' | 'dropped' | 'planted' | 'defused' | 'detonated';

export interface SndResult {
  winner: Team;
  reason: SndReason;
}

/** 每个 CombatUpdate（16 Hz）附带一份：全队都能看到的回合信息 */
export interface SndView {
  phase: SndPhase;
  /** 第几回合（从 1 开始） */
  round: number;
  /** 先赢下这么多回合者获胜 */
  scoreLimit: number;
  /** 红队(0) / 蓝队(1) 已赢回合数（与队伍无关的阵营比分，换边不清零） */
  wins: [number, number];
  /** 本回合进攻方 */
  attack: Team;
  /** 当前阶段结束的服务器 tick（购买结束 / 回合时限 / 引爆 / 结算结束）；over 与无时限阶段为 0 */
  phaseEnd: number;
  spike: SndSpike;
  /** 当前持有者 id（spike=carried 时有效，否则 -1） */
  carrier: number;
  /** 已安放 / 拆除 / 引爆的包点字母；未安放为 null */
  site: string | null;
  /** 掉落或安放位置（米，脚底） */
  spikeAt: V3 | null;
  /** 安放读条已累计的 tick（全队可见的进度） */
  plantTicks: number;
  /** 拆除读条已累计的 tick（含半拆存档） */
  defuseTicks: number;
  /** 此刻正在读条的类型：plant 安放 / defuse 拆除；没人读条为 null（全队可见，用于显示读条进度） */
  channel: 'plant' | 'defuse' | null;
  /** 本回合结果（end / over 阶段） */
  result: SndResult | null;
  /** 整场获胜方（over）；未决为 null */
  matchWinner: Team | null;
}

/** 回合机发出的事件；除 matchEnd 外都经 CombatUpdate.events 按顺序下发（死者也收）。 */
export type SndEvent =
  | { kind: 'roundStart'; round: number; attack: Team }
  | { kind: 'pickup'; player: number }
  | { kind: 'drop'; player: number; at: V3 }
  | { kind: 'plant'; player: number; site: string }
  | { kind: 'defuse'; player: number; site: string }
  | { kind: 'detonate'; site: string }
  | { kind: 'roundEnd'; winner: Team; reason: SndReason; wins: [number, number] }
  | { kind: 'matchEnd'; winner: Team; wins: [number, number] };
