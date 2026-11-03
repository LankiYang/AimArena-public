import type { BVH } from '../world/bvh.ts';
import { HALF_HEIGHT, RADIUS, SEG_HALF, STEP, moveCapsule } from '../world/capsule.ts';
import { nearestRope, ropeLength, ropePoint, ROPE_BOTTOM_ZONE, ROPE_CLIMB_SPEED, ROPE_IDLE_RELEASE, ROPE_REATTACH_DELAY, type RopeDef } from '../rope.ts';

export const TICK_RATE = 128;
export const DT = 1 / TICK_RATE;
export const ST_WALK = 0, ST_RUN = 1, ST_AIR = 2, ST_CROUCH = 3, ST_SPECIAL = 4;
export const CROUCH_TRANSITION = 0.275;
export const EYE_STAND = 1.75, EYE_CROUCH = 1.35;
export const STILL_SPEED = 0.015;
export type Curve = [number, number, string, number, number][];
export const TAG_MODULES = {
  heavy: { duration: 0.75, drag: 0.85, curve: [[0, 0.3, 'Linear', 0, 0], [1, 1, 'Linear', 0, 0]] as Curve },
  shotgunFar: { duration: 0.5, drag: 0.5, curve: [[0, 0.7, 'Linear', 0, 0], [1, 1, 'Linear', 0, 0]] as Curve },
  wallPen: { duration: 0.35, drag: 0.3, curve: [[0, 0.75, 'Linear', 0, 0], [1, 1, 'Linear', 0, 0]] as Curve },
};
export type TagId = keyof typeof TAG_MODULES;
const TAG_IDS = Object.keys(TAG_MODULES) as TagId[];

export function evalCurve(c: Curve, t: number, def = 0): number {
  if (!c.length) return def;
  if (t <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1], b = c[i];
    if (t > b[0]) continue;
    const span = b[0] - a[0], u = span > 0 ? (t - a[0]) / span : 1;
    if (a[2].toLowerCase() === 'constant') return a[1];
    if (a[2].toLowerCase() === 'cubic') {
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * a[1] + (u3 - 2 * u2 + u) * span * a[4] + (-2 * u3 + 3 * u2) * b[1] + (u3 - u2) * span * b[3];
    }
    return a[1] + (b[1] - a[1]) * u;
  }
  return c[c.length - 1][1];
}
export interface MoveState {
  x: number; y: number; z: number; vx: number; vz: number; vy: number;
  grounded: boolean; crouch: number; stationaryTicks: number;
  jumpY0: number; jumpY1: number; lsT: number; lsI: number;
  tag: number; tagG: number; tagP: boolean; landT: number; landV: number;
  rope: number; ropeT: number; ropeCool: number; ropeIdle: number;
}
export interface MoveInput { forward: number; strafe: number; jump: boolean; crouch: boolean; walk: boolean; yaw: number }
export interface MoveCtx {
  now: number; gunM: number; zoomRatio: number; frozen?: boolean; ropes?: readonly RopeDef[];
  dirX?: number; dirZ?: number; hasMove?: boolean; right?: number; fwd?: number;
}
export function newMoveState(x: number, y: number, z: number): MoveState {
  return { x, y, z, vx: 0, vz: 0, vy: 0, grounded: true, crouch: 0, stationaryTicks: 0, jumpY0: NaN, jumpY1: NaN, lsT: -1, lsI: 0, tag: -1, tagG: 0, tagP: false, landT: -1, landV: 0, rope: -1, ropeT: 0, ropeCool: 0, ropeIdle: 0 };
}
export const copyMoveState = (s: MoveState): MoveState => ({ ...s });
export const eyeHeight = (s: MoveState) => EYE_STAND + (EYE_CROUCH - EYE_STAND) * s.crouch;
export const speed2 = (s: MoveState) => Math.hypot(s.vx, s.vz);
export function applyTag(s: MoveState, id: TagId) {
  const index = TAG_IDS.indexOf(id), next = TAG_MODULES[id];
  if (index < 0 || !next) return;
  const current = TAG_IDS[s.tag] && TAG_MODULES[TAG_IDS[s.tag]];
  if (current && evalCurve(current.curve, s.tagG / current.duration, 1) <= evalCurve(next.curve, 0, 1)) return;
  s.tag = index; s.tagG = 0; s.tagP = !s.grounded;
}

export function stepMove(s: MoveState, inp: MoveInput, ctx: MoveCtx, bvh: BVH): boolean {
  const ropes = ctx.ropes ?? [];
  s.ropeCool = Math.max(0, s.ropeCool - DT);
  if (s.rope >= ropes.length) s.rope = -1;
  if (s.rope < 0 && s.ropeCool === 0 && !ctx.frozen) {
    const near = nearestRope(ropes, s.x, s.y, s.z);
    if (near && ((!s.grounded) || (inp.forward > 0 && Math.abs(s.y - near.rope.bottom[1]) <= ROPE_BOTTOM_ZONE))) {
      s.rope = near.index; s.ropeT = near.t; s.ropeIdle = 0;
    }
  }
  if (s.rope >= 0) {
    const r = ropes[s.rope], length = ropeLength(r);
    const direction = ctx.frozen ? 0 : Math.max(-1, Math.min(1, inp.forward));
    s.ropeT = Math.max(0, Math.min(1, s.ropeT + (length ? direction * ROPE_CLIMB_SPEED * DT / length : 0)));
    const point = ropePoint(r, s.ropeT);
    s.x = point[0]; s.y = point[1]; s.z = point[2]; s.vx = s.vy = s.vz = 0; s.grounded = false;
    s.ropeIdle = s.ropeT <= 0 && !direction ? s.ropeIdle + DT : 0;
    if ((direction > 0 && s.ropeT >= 1) || (direction < 0 && s.ropeT <= 0) || s.ropeIdle >= ROPE_IDLE_RELEASE || !length) {
      s.rope = -1; s.ropeCool = ROPE_REATTACH_DELAY;
      s.grounded = s.ropeT >= 1 || !r.bottomAirborne;
    }
    return false;
  }

  const targetCrouch = inp.crouch && !ctx.frozen ? 1 : 0;
  s.crouch += Math.max(-DT / CROUCH_TRANSITION, Math.min(DT / CROUCH_TRANSITION, targetCrouch - s.crouch));
  let right = inp.strafe, forward = inp.forward;
  const magnitude = Math.hypot(right, forward);
  if (magnitude > 0) { right /= magnitude; forward /= magnitude; }
  let dx = ctx.dirX ?? (Math.cos(inp.yaw) * right - Math.sin(inp.yaw) * forward);
  let dz = ctx.dirZ ?? (-Math.sin(inp.yaw) * right - Math.cos(inp.yaw) * forward);
  const hasMove = !ctx.frozen && (ctx.hasMove ?? magnitude > 0);
  if (!hasMove) { dx = 0; dz = 0; }
  const wasGrounded = s.grounded;
  let speedLimit = 6.75 * Math.max(0, ctx.gunM) * Math.max(0, ctx.zoomRatio);
  if (inp.walk) speedLimit *= 0.52;
  speedLimit *= 1 - 0.55 * s.crouch;
  if (s.tag >= 0) {
    const tag = TAG_MODULES[TAG_IDS[s.tag]];
    if (tag) {
      speedLimit *= evalCurve(tag.curve, Math.min(1, s.tagG / tag.duration), 1);
      s.tagG += DT;
      if (s.tagG >= tag.duration) { s.tag = -1; s.tagG = 0; s.tagP = false; }
    } else s.tag = -1;
  }
  if (wasGrounded) {
    const speed = Math.hypot(s.vx, s.vz);
    if (speed > 0) {
      const reduced = Math.max(0, speed - Math.max(speed, 2) * 6 * DT);
      s.vx *= reduced / speed; s.vz *= reduced / speed;
    }
  }
  if (hasMove) {
    const projection = s.vx * dx + s.vz * dz;
    const amount = Math.max(0, Math.min((wasGrounded ? 45 : 8) * DT, speedLimit - projection));
    s.vx += dx * amount; s.vz += dz * amount;
  }
  if (wasGrounded && inp.jump && !ctx.frozen) {
    s.vy = 6.4; s.grounded = false; s.jumpY0 = s.y; s.jumpY1 = s.y;
  } else if (wasGrounded) s.vy = Math.min(0, s.vy);
  const previousVy = s.vy;
  s.vy -= 18 * DT;
  const dy = (previousVy + s.vy) * 0.5 * DT;
  const result = moveCapsule(bvh, s.x, s.y + HALF_HEIGHT, s.z, s.vx * DT, dy, s.vz * DT, RADIUS, SEG_HALF, STEP, wasGrounded && previousVy <= 0);
  const expectedY = s.y + dy;
  s.x = result.x; s.y = result.y - HALF_HEIGHT; s.z = result.z;
  if (result.hitWall) {
    const into = s.vx * result.wallNx + s.vz * result.wallNz;
    if (into < 0) { s.vx -= into * result.wallNx; s.vz -= into * result.wallNz; }
  }
  if (dy > 0 && s.y < expectedY - 1e-5) s.vy = 0;
  s.grounded = result.grounded && s.vy <= 0;
  if (s.grounded) {
    if (!wasGrounded) { s.landT = ctx.now; s.landV = Math.max(0, -s.vy); s.lsT = ctx.now; s.lsI = s.landV; }
    s.vy = 0;
  } else if (Number.isFinite(s.jumpY1)) s.jumpY1 = Math.max(s.jumpY1, s.y);
  s.stationaryTicks = Math.hypot(s.vx, s.vz) < STILL_SPEED ? s.stationaryTicks + 1 : 0;
  return result.hitWall;
}
