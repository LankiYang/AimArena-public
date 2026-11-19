import fs from 'node:fs/promises';
import { AscentWalker } from '../src/ascent-collision.mjs';
import maps from '../shared/ascent-world.cjs';
import { findRoute } from './release-route-probe.mjs';
import { walkEdge } from '../shared/nav-edge.mjs';

const dir=new URL('../shared/bot-nav/',import.meta.url);
await fs.mkdir(dir,{recursive:true});
const rounded=n=>Math.round(n*100000)/100000;
const cell=(x,z)=>Math.floor(x)+':'+Math.floor(z);
for(const id of (process.argv.length>2?process.argv.slice(2):maps.releaseIds)){
  const {map,world}=await maps.loadAscentWorld(id), walker=new AscentWalker(world);
  const nodes=[], edges=[], keys=new Map(), connected=new Set(), cells=new Map();
  function point(p){
    const key=[rounded(p.x),rounded(p.y),rounded(p.z)].join(':');
    if(keys.has(key))return keys.get(key);
    const index=nodes.push([p.x,p.y,p.z].map(rounded))-1;
    keys.set(key,index);
    const bin=cell(p.x,p.z);
    if(!cells.has(bin))cells.set(bin,[]);
    cells.get(bin).push(index);
    return index;
  }
  function edge(a,b,jump){
    const key=a+':'+b;
    if(a===b||connected.has(key))return;
    connected.add(key);edges.push(jump?[a,b,1]:[a,b]);
  }
  function route(start,goal){
    const attempts=[[1,false],[.5,false],[.5,true]];
    for(const [stride,jump] of attempts){
      const {route}=findRoute(world,start,goal,stride,jump,true);
      if(!route)continue;
      for(let i=1;i<route.length;i++){
        const a=route[i-1],b=route[i],ai=point(a),bi=point(b);
        edge(ai,bi,b.jump);
        if(walkEdge(walker,b,a))edge(bi,ai,false);
        else if(a.y-b.y<.8&&walkEdge(walker,b,a,true))edge(bi,ai,true);
      }
      return true;
    }
    return false;
  }
  for(const team of ['attack','defend']){
    const [start,...others]=map.spawns[team];
    for(const site of map.sites)if(!route(start,site))throw Error(id+' '+team+' '+site.id);
    for(const spawn of others){
      const goal={...start,radius:.55,heightTolerance:.3};
      if(!route(spawn,goal)&&!map.sites.some(site=>route(spawn,site)))throw Error(id+' disconnected '+team+' spawn: '+JSON.stringify(spawn));
    }
  }
  // Stitch independent route samples at floor level. Every connector also uses the game capsule.
  for(const [a,[x,y,z]] of nodes.entries()){
    for(let ix=-1;ix<=1;ix++)for(let iz=-1;iz<=1;iz++)for(const b of cells.get(cell(x+ix,z+iz))||[]){
      if(a>=b)continue;
      const [bx,by,bz]=nodes[b], dist=Math.hypot(bx-x,bz-z);
      if(dist>.95||Math.abs(by-y)>.72)continue;
      if(!connected.has(a+':'+b)&&walkEdge(walker,{x,y,z},{x:bx,y:by,z:bz}))edge(a,b,false);
      if(!connected.has(b+':'+a)&&walkEdge(walker,{x:bx,y:by,z:bz},{x,y,z}))edge(b,a,false);
    }
  }
  await fs.writeFile(new URL(id+'.json',dir),JSON.stringify({nodes,edges})+'\n','utf8');
  console.log(id,nodes.length+' waypoints',edges.length+' links');
}
