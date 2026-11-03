// 共享出生落点选择：对局与实图回归用同一份，避免测试复制旧的悬空出生算法。
import type { V3 } from '../shared/combat.ts';
import type { P3 } from '../shared/mapdata.ts';
import { raycast } from '../shared/world/bvh.ts';
import { overlaps, HALF_HEIGHT, RADIUS, SEG_HALF } from '../shared/world/capsule.ts';
import type { Nav } from './nav.ts';
import { spawnYaw, frontClearance, CLEAR_MIN, type ServerWorld } from './world.ts';

export function pickSpawn(world: ServerWorld, list: readonly P3[], enemy: readonly P3[], index: number,
  occupied: readonly V3[] = [], nav: Nav | null = null): P3 & { yaw: number } {
  const base = list[index % list.length], ring = Math.floor(index / list.length);
  const cx = enemy.reduce((n,p)=>n+p.x,0)/enemy.length, cz = enemy.reduce((n,p)=>n+p.z,0)/enemy.length;
  const face = (x: number, z: number) => base.yaw ?? Math.atan2(x-cx,z-cz);
  const free = (p: V3) => !occupied.some(q=>Math.hypot(p.x-q.x,p.z-q.z)<.85&&Math.abs(p.y-q.y)<1.2);
  function ground(x: number,z: number): (P3 & {yaw:number}) | null {
    const hit = raycast(world.pawn,x,base.y+.65,z,0,-1,0,1.3,.55);
    if (!hit) return null;
    const y = base.y+.65-hit.t;
    if (Math.abs(y-base.y)>.55 || overlaps(world.pawn,x,y+HALF_HEIGHT+.05,z,RADIUS,SEG_HALF)) return null;
    // 不能只检查胶囊是否穿墙：悬在平台外面同样“不穿墙”，却会在第一帧掉进下层。
    for (const [dx,dz] of [[.25,0],[-.25,0],[0,.25],[0,-.25]]) {
      if (!raycast(world.pawn,x+dx,y+.3,z+dz,0,-1,0,.85,.55)) return null;
    }
    const p = {x,y:y+.015,z};
    if (nav) {
      const s = nav.snap(p,1,true);
      if (!s || Math.hypot(s.x-x,s.z-z)>.8 || Math.abs(s.y-y)>.65) return null;
    }
    return {...p,yaw:spawnYaw(world,x,p.y,z,face(x,z))};
  }
  let fallback = ground(base.x,base.z);
  if (ring===0 && fallback && free(fallback)) return fallback;
  // 前八个额外队员在 1.2m 的紧凑圈内分布，不再把第 5 人推出 4.8m、掉下出生平台。
  const radius = Math.ceil(Math.max(1,ring)/8)*1.2;
  for (const r of [radius,radius+1.2,radius+2.4]) for (let k=0;k<8;k++) {
    const a=ring*1.3+k*Math.PI/4, p=ground(base.x+Math.cos(a)*r,base.z+Math.sin(a)*r);
    if (!p || !free(p)) continue;
    fallback ??= p;
    if (frontClearance(world.pawn,p.x,p.y,p.z,p.yaw)>=CLEAR_MIN) return p;
  }
  // 极小出生区宁可回到校准过的基础点，也不使用“没有地面但不穿墙”的偏移点。
  return fallback ?? {...base,yaw:spawnYaw(world,base.x,base.y,base.z,face(base.x,base.z))};
}
