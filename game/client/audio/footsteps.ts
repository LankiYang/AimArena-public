// 仅追踪水平实际位移；是否允许发声（包括静步、蹲伏、离地等）由调用方判定。
// 常速跑约 5–7 m/s：每 2 m 一步，最低间隔 0.28 s，避免过密。
const STRIDE_METERS = 2;
const MIN_STEP_INTERVAL = 0.28;
// 与移动模拟的静止阈值留有余量，抑制速度与插值噪声。
const MIN_SPEED = 0.15;
// 后台恢复或快照断流时不补步；瞬移判定给插值留 0.25 m 容差。
const MAX_FRAME_GAP = 0.25;
const MAX_TRAVEL_SPEED = 12;
const TRAVEL_TOLERANCE = 0.25;

interface FootstepState {
  x: number;
  z: number;
  at: number;
  distance: number;
  lastStep: number;
  active: boolean;
}

export class FootstepTracker {
  private readonly states = new Map<number, FootstepState>();

  /** now 为秒；每次最多返回一次脚步，调用方应在实体移除或身份替换时调用 remove。 */
  update(id: number, x: number, z: number, speed: number, audible: boolean, now: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(speed) || !Number.isFinite(now)) {
      this.states.delete(id);
      return false;
    }
    const active = audible && speed >= MIN_SPEED;
    let state = this.states.get(id);
    if (!state) {
      this.states.set(id, { x, z, at: now, distance: 0, lastStep: -Infinity, active });
      return false;
    }

    const dt = now - state.at;
    const distance = Math.hypot(x - state.x, z - state.z);
    state.x = x;
    state.z = z;
    state.at = now;
    if (dt < 0) state.lastStep = -Infinity;
    if (!active || !state.active || dt <= 0 || dt > MAX_FRAME_GAP || distance > MAX_TRAVEL_SPEED * dt + TRAVEL_TOLERANCE) {
      state.distance = 0;
      state.active = active;
      return false;
    }

    // 最多保留一步距离；限速期间不积攒待补播的脚步。
    state.distance = Math.min(STRIDE_METERS, state.distance + distance);
    if (state.distance < STRIDE_METERS || now - state.lastStep < MIN_STEP_INTERVAL) return false;
    state.distance = 0;
    state.lastStep = now;
    return true;
  }

  remove(id: number): void {
    this.states.delete(id);
  }

  clear(): void {
    this.states.clear();
  }
}
