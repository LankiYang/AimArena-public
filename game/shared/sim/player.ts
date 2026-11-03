import type { BVH } from '../world/bvh.ts';
import type { RopeDef } from '../rope.ts';
import type { WeaponId } from '../combat.ts';
import { cmdToMove, type UserCmd } from '../protocol.ts';
import { DT, stepMove, type MoveCtx, type MoveState } from './movement.ts';
import { SUBSTEPS } from './tick.ts';
import { weaponMovement } from './weapons.ts';

/** Advance one command on the same deterministic timeline used by prediction. */
export function stepPlayer(s: MoveState, cmd: UserCmd, frozen: boolean, bvh: BVH, weapon: WeaponId, zoom: number | boolean, ropes: readonly RopeDef[] = [], speedMultiplier = 1) {
  const input = cmdToMove(cmd);
  const weaponScale = weaponMovement(weapon, zoom);
  const magnitude = Math.hypot(input.strafe, input.forward);
  const right = !frozen && magnitude ? input.strafe / magnitude : 0;
  const forward = !frozen && magnitude ? input.forward / magnitude : 0;
  const ctx: MoveCtx = {
    now: 0, gunM: weaponScale.gunM * Math.max(0, speedMultiplier), zoomRatio: weaponScale.zoomRatio,
    frozen, ropes, right, fwd: forward, hasMove: !frozen && magnitude > 0,
    dirX: Math.cos(input.yaw) * right - Math.sin(input.yaw) * forward,
    dirZ: -Math.sin(input.yaw) * right - Math.cos(input.yaw) * forward,
  };
  let hitWall = false;
  for (let i = 0; i < SUBSTEPS; i++) {
    ctx.now = (cmd.seq * SUBSTEPS + i) * DT;
    if (stepMove(s, input, ctx, bvh)) hitWall = true;
  }
  return { hitWall };
}
