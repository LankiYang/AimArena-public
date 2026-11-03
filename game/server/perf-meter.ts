import { monitorEventLoopDelay } from 'node:perf_hooks';
import { isMainThread, threadId } from 'node:worker_threads';

/** Optional process diagnostics, disabled unless PERF_METER=1. */
export function createPerfMeter() {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const threadCpu = !isMainThread && typeof process.threadCpuUsage === 'function';
  const cpuUsage = threadCpu ? () => process.threadCpuUsage() : () => process.cpuUsage();
  let started = performance.now(), cpu = cpuUsage(), count = 0, total = 0, max = 0;
  const timer = setInterval(() => {
    const now = performance.now(), usage = cpuUsage(), elapsed = now - started;
    const user = usage.user - cpu.user, system = usage.system - cpu.system;
    console.log(`[perf] thread=${threadId} cpu_scope=${threadCpu ? 'thread' : 'process'} interval=${elapsed.toFixed(0)}ms cpu=${((user + system) / (elapsed * 1000) * 100).toFixed(1)}% pump_count=${count} pump_avg=${(count ? total / count : 0).toFixed(2)}ms pump_max=${max.toFixed(2)}ms loop_p99=${(loop.percentile(99) / 1e6).toFixed(2)}ms loop_max=${(loop.max / 1e6).toFixed(2)}ms`);
    cpu = usage; started = now; count = 0; total = 0; max = 0; loop.reset();
  }, 5000);
  timer.unref();
  return (duration: number) => { count++; total += duration; max = Math.max(max, duration); };
}
