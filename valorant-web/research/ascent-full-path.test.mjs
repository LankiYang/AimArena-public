import test from 'node:test';
import assert from 'node:assert/strict';
import { AscentWalker } from '../src/ascent-collision.mjs';
import ascent from '../shared/ascent-world.cjs';

const lattice = .5, dt = 1/60, speed = 5.2;
const points = {
  attack:[50.25,-1.85,60.25], defend:[-47.25,-.8,41.25],
  'A Main':[2.75,.2,7.75], 'A Site':[-16.25,1.2,-.75],
  'B Main':[-8.25,-2.75,80.75], 'B Site':[-26.25,-4.8,87.25],
  'Mid Courtyard':[4.25,-1.85,48.75], Market:[-23.75,-.8,50.25],
  'A Heaven':[-32.25,4.2,-.25],
};

// Every edge is actually walked by the shared prediction/authority controller;
// the lattice only supplies candidate destinations.
function explore(world, start, destinations) {
  const walker = new AscentWalker(world,start), queue = [{foot:start,steps:0}];
  const visited = new Set(), reached = new Map();
  const directions = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  const key = (x,y,z) => [Math.floor(x/lattice),Math.round(y*100),Math.floor(z/lattice)].join(',');
  for (let i=0;i<queue.length && reached.size<destinations.length;i++) {
    const {foot:[x,y,z],steps} = queue[i];
    for (const name of destinations) {
      const [gx,gy,gz] = points[name];
      if (!reached.has(name) && Math.abs(gy-y)<.38 && Math.hypot(gx-x,gz-z)<.7) reached.set(name,steps);
    }
    for (const [dx,dz] of directions) {
      const tx=x+dx*lattice,tz=z+dz*lattice;
      if (tx<-56 || tx>59 || tz<-18 || tz>99) continue;
      if (![y,y+.5,y-.5].some(h=>!visited.has(key(tx,h,tz)))) continue;
      walker.reset([x,y-.00999,z]); walker.grounded=true;
      let foot=walker.getFoot();
      for (let frame=0;frame<10;frame++) {
        const vx=tx-foot.x,vz=tz-foot.z, dist=Math.hypot(vx,vz);
        if (dist<.008 && walker.grounded) break;
        const divisor=Math.max(dist,speed*dt);
        foot=walker.update({x:vx/divisor,z:vz/divisor},dt,{speed});
      }
      if (Math.hypot(tx-foot.x,tz-foot.z)>.08) continue;
      for(let f=0;f<18 && !walker.grounded;f++) foot=walker.update({x:0,z:0},dt,{speed});
      if (!walker.grounded || foot.y<y-.76 || Math.hypot(tx-foot.x,tz-foot.z)>.08) continue;
      const k=key(tx,foot.y,tz);
      if (visited.has(k)) continue;
      visited.add(k); queue.push({foot:[tx,foot.y,tz],steps:steps+1});
    }
  }
  return Object.fromEntries(reached);
}

test('Ascent full: shared walker connects the spawns, both main lanes, both sites, Mid, Market and Heaven', async()=>{
  const a=await ascent.loadAscentWorld('ascent-full');
  assert.equal(a.map.levels.length,10);
  assert.equal(a.map.triangleCount,2335335);
  const failed=[];
  for (const [from,to] of [
    ['attack',['A Main','B Main','Mid Courtyard']],
    ['A Main',['A Site']],
    ['B Main',['B Site']],
    ['Mid Courtyard',['Market']],
    ['Market',['B Site','defend']],
    ['defend',['A Heaven','A Site']],
  ]) {
    const results=explore(a.world,points[from],to);
    console.log(from, results);
    for(const name of to) if(!Object.hasOwn(results,name)) failed.push(from+' → '+name);
  }
  assert.deepEqual(failed,[]);
});
