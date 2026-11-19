import { AscentWalker } from '../src/ascent-collision.mjs';
import { isInPlantZone } from '../src/plant-zone.mjs';
import maps from '../shared/ascent-world.cjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { walkEdge } from '../shared/nav-edge.mjs';

class Queue {
  data=[];
  push(item) {
    const a=this.data;
    let i=a.length; a.push(item);
    while(i>0){const parent=(i-1)>>1;if(a[parent].priority<=item.priority)break;a[i]=a[parent];i=parent;}
    a[i]=item;
  }
  pop() {
    const a=this.data, first=a[0], last=a.pop();
    if(a.length){
      let i=0;
      while(2*i+1<a.length){
        const l=2*i+1,r=l+1,child=r<a.length&&a[r].priority<a[l].priority?r:l;
        if(a[child].priority>=last.priority)break;
        a[i]=a[child];i=child;
      }
      a[i]=last;
    }
    return first;
  }
}

const directions=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
export function findRoute(world, start, target, stride, allowJump=false, trace=false) {
  const queue=new Queue(), visited=new Set(), walker=new AscentWalker(world);
  const startNode={i:0,j:0,y:start.y,length:0,priority:0};
  queue.push(startNode);
  let closest, closestDistance=Infinity;
  const key=(i,j,y)=>i+':'+j+':'+Math.round(y*10);
  const {min,max}=world.geometry.boundingBox;
  const moves=allowJump?[...directions,...directions.map(([i,j])=>[i*3,j*3])]:directions;
  while(queue.data.length){
    const node=queue.pop(),{i,j,y,length}=node, x=start.x+i*stride, z=start.z+j*stride;
    const k=key(i,j,y);
    if(visited.has(k))continue;
    visited.add(k);
    const distance=Math.hypot(x-target.x,z-target.z,y-target.y);
    if(distance<closestDistance){closestDistance=distance;closest={x,y,z};}
    if(isInPlantZone({x,y,z},target)){
      const result={meters:Math.round(length*10)/10,stride,visited:visited.size};
      if(trace){
        result.route=[];
        for(let p=node;p;p=p.parent)result.route.push({x:start.x+p.i*stride,y:p.y,z:start.z+p.j*stride,jump:!!p.jump});
        result.route.reverse();
      }
      return result;
    }
    for(const [di,dj] of moves){
      const ni=i+di,nj=j+dj,nx=x+di*stride,nz=z+dj*stride;
      if(nx<min.x||nx>max.x||nz<min.z||nz>max.z)continue;
      const floor=world.floorAt(nx,nz,y+(allowJump?.80:.72),allowJump?8.8:1.65);
      if(!floor||visited.has(key(ni,nj,floor.position.y)))continue;
      const from={x,y,z}, to={x:nx,y:floor.position.y,z:nz};
      let jump=false,foot=walkEdge(walker,from,to);
      if(!foot&&allowJump){jump=true;foot=walkEdge(walker,from,to,true);}
      if(!foot)continue;
      const nextLength=length+stride*Math.hypot(di,dj);
      const estimate=Math.hypot(nx-target.x,nz-target.z)+Math.abs(foot.y-target.y);
      queue.push({i:ni,j:nj,y:foot.y,length:nextLength,priority:nextLength+2*estimate,jump,parent:trace?node:null});
    }
  }
  return {meters:null,stride,visited:visited.size,closest};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
const ids=process.argv.length>2?process.argv.slice(2):maps.releaseIds;
const override=process.env.VW_ROUTE_SPAWNS?JSON.parse(process.env.VW_ROUTE_SPAWNS):{};
const teams=process.env.VW_ROUTE_TEAM?[process.env.VW_ROUTE_TEAM]:['attack','defend'];
for(const id of ids){
  const {map,world}=await maps.loadAscentWorld(id);
  for(const team of teams)for(const site of map.sites){
    const candidate=override[id]?.[team];
    const spawn=candidate?{x:candidate[0],y:candidate[1],z:candidate[2]}:map.spawns[team][0], reverse=process.env.VW_ROUTE_REVERSE==='1';
    const start=reverse?site:spawn, target=reverse?{...spawn,radius:.7,heightTolerance:.3}:site;
    let match=findRoute(world,start,target,1);
    if(match.meters===null)match=findRoute(world,start,target,.5);
    if(match.meters===null)match={...findRoute(world,start,target,.5,true),allowJump:true};
    console.log(JSON.stringify({map:id,team,site:site.id,...match}));
    if(match.meters===null)process.exitCode=1;
  }
}
}
