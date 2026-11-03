// Shared scheduler for room simulation. A pump returns its next absolute deadline.
import { createPerfMeter } from './perf-meter.ts';
type RoomPump = () => number;
const pumps = new Set<RoomPump>();
let pumpTimer: NodeJS.Timeout | null = null;
let pumping = false;
let addedDuringPump = false;
const meter = process.env.PERF_METER === '1' ? createPerfMeter() : null;
function pumpOnce() {
  pumpTimer = null;
  pumping = true;
  addedDuringPump = false;
  const pending = [...pumps];
  let index = 0, deadline = Infinity, duration = 0;
  function next() {
    const pump = pending[index++];
    if (pump && pumps.has(pump)) {
      const started = meter ? performance.now() : 0;
      const due = pump();
      if (meter) duration += performance.now() - started;
      if (due < deadline) deadline = due;
    }
    // Give socket I/O a chance to run between independent room simulations.
    if (index < pending.length) { setImmediate(next); return; }
    pumping = false;
    if (meter) meter(duration);
    if (pumps.size) {
      const delay = addedDuringPump ? 0 : deadline - performance.now();
      if (Number.isFinite(delay)) pumpTimer = setTimeout(pumpOnce, Math.max(0, delay));
    }
  }
  next();
}
export function addPump(pump: RoomPump) {
  if (!pumps.has(pump) && pumping) addedDuringPump = true;
  pumps.add(pump);
  if (!pumping && !pumpTimer) pumpTimer = setTimeout(pumpOnce, 0);
}
export function removePump(pump: RoomPump) {
  pumps.delete(pump);
  if (!pumps.size && pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
}
export type { RoomPump };
