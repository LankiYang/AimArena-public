// Network ticks contain four fixed movement steps.
import { DT } from './movement.ts';
export const TICK_RATE = 32;
export const SUBSTEPS = 4;
export const TICK_DT = DT * SUBSTEPS; // 1/32 s