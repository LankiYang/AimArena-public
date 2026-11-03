// tick.ts — 网络 / 服务器 tick：32 Hz；每个 tick 内部跑 SUBSTEPS 个 1/128 s 的物理子步（movement.ts 的 DT）
import { DT } from './movement.ts';
export const TICK_RATE = 32;
export const SUBSTEPS = 4;
export const TICK_DT = DT * SUBSTEPS; // 1/32 s