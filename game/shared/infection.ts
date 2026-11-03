// infection.ts — 经典生化模式共享规则数值与同步状态。
// 服务端权威推进阶段、感染与胜负；客户端只读 InfectionStateMessage 做显示和预测。
const TICK_RATE = 32;
export type Team = 0 | 1;

/** 可调默认值；所有时长以 32Hz 服务器 tick 换算。 */
export const INFECTION = {
  prepareSec: 20,
  activeSec: 180,
  respawnSec: 1.5,
  /** 感染者生命值与速度倍率。人类沿用现有生命值、武器和速度。 */
  infectedHp: 150,
  infectedSpeedMultiplier: 1.2,
} as const;

export const infectionTicks = (seconds: number): number => Math.ceil(seconds * TICK_RATE);
export const INFECTION_PREPARE_TICKS = infectionTicks(INFECTION.prepareSec);
export const INFECTION_ACTIVE_TICKS = infectionTicks(INFECTION.activeSec);
export const INFECTION_RESPAWN_TICKS = infectionTicks(INFECTION.respawnSec);

export type InfectionPhase = 'prepare' | 'active' | 'ended';

/** 服务器每次状态推送的 JSON 合同；阵营 0=人类，1=感染者。 */
export interface InfectionState {
  t: 'infectionState';
  phase: InfectionPhase;
  humans: number[];
  infected: number[];
  remainingTicks: number;
  winner: Team | null;
}

/** 客户端移动预测可直接使用的感染者移动倍率。 */
export const infectionSpeedMultiplier = (team: Team): number => team === 1 ? INFECTION.infectedSpeedMultiplier : 1;
