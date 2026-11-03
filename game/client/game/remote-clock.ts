// 远端实体共用的播放时钟：缓冲随到达延迟增加，播放不倒退、不越过最新权威快照。
import { TICK_DT } from '../../shared/sim/tick.ts';

const BASE_DELAY = 2 * TICK_DT + 0.015;
const MAX_DELAY = 4 * TICK_DT + 0.02;

export class RemoteClock {
  time = -Infinity;
  delay = BASE_DELAY;
  jitter = 0;
  underrunFrames = 0;
  maxGap = 0;
  private offset = -Infinity;
  private latest = -Infinity;
  private arrival = NaN;
  private frameAt = NaN;

  observe(tick: number, now: number) {
    const sent = tick * TICK_DT;
    if (sent <= this.latest) return;
    const elapsed = Number.isFinite(this.arrival) ? Math.max(0, now - this.arrival) : 0;
    this.offset = Math.max(this.offset - elapsed * 0.002, sent - now);
    if (Number.isFinite(this.arrival)) {
      this.maxGap = Math.max(this.maxGap, elapsed);
      // 与最快到达基线比较，既覆盖成批到达，也覆盖延迟持续上升。峰值缓慢衰减。
      this.jitter = Math.max(now + this.offset - sent, this.jitter * Math.exp(-elapsed / 2));
    }
    this.delay = Math.min(MAX_DELAY, BASE_DELAY + this.jitter);
    this.latest = sent;
    this.arrival = now;
  }

  advance(now: number): number {
    if (!Number.isFinite(this.latest)) return this.time;
    const desired = Math.min(this.latest, now + this.offset - this.delay);
    const dt = now - this.frameAt;
    if (!Number.isFinite(dt) || dt > 0.25 || desired - this.time > 0.25) {
      // 首帧 / 后台恢复 / 加载积压：不补播不可见的旧画面，也不倒退。
      this.time = Math.max(this.time, desired);
    } else if (dt > 0) {
      // 调整播放速度而非直接减延迟，避免缓冲增大时人物倒走、恢复时突然追帧。
      const rate = Math.max(0.85, Math.min(1.1, 1 + (desired - this.time - dt) * 4));
      const next = this.time + dt * rate;
      if (next > this.latest) this.underrunFrames++;
      this.time = Math.min(this.latest, next);
    }
    this.frameAt = now;
    return this.time;
  }
}
