'use strict';

const fs = require('node:fs');
const path = require('node:path');
const createGraph = require('ngraph.graph');
const { aStar } = require('ngraph.path');
const { AscentWalker } = require('../src/ascent-collision.mjs');
const { walkEdge } = require('./nav-edge.mjs');
const { isInPlantZone } = require('../src/plant-zone.mjs');

const navigationCache = new Map();
const distance = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);
const cost = (a,b) => Math.hypot(a.x-b.x,a.z-b.z,a.y-b.y);
const delta = (a,b) => Math.atan2(Math.sin(a-b),Math.cos(a-b));
const NAV_DIR = path.join(__dirname,'bot-nav');

function loadNavigation(adapter){
  const id=adapter?.map.id;
  if(adapter?.map.collision!=='volumes')return null;
  if(navigationCache.has(id))return navigationCache.get(id);
  const file=path.join(NAV_DIR,id+'.json');
  if(!fs.existsSync(file))return null;
  const {nodes,edges}=JSON.parse(fs.readFileSync(file,'utf8'));
  const graph=createGraph({multigraph:false});
  const points=nodes.map(([x,y,z],id)=>({x,y,z,id}));
  points.forEach(p=>graph.addNode(p.id,p));
  for(const [a,b,jump] of edges)graph.addLink(a,b,{jump:!!jump});
  const finder=aStar(graph,{oriented:true,distance:(a,b,link)=>cost(a.data,b.data)+(link.data.jump?.75:0),heuristic:(a,b)=>cost(a.data,b.data)});
  const walker=new AscentWalker(adapter.world);
  function candidates(target, radius, height, count){
    return points.filter(p=>distance(p,target)<=radius&&Math.abs(p.y-target.y)<=height).sort((a,b)=>cost(a,target)-cost(b,target)).slice(0,count);
  }
  return {
    route(from, goal, failedEdges){
      const starts=candidates(from,3,.72,16).filter(p=>(distance(p,from)<.045&&Math.abs(p.y-from.y)<.08)||walkEdge(walker,from,p)).slice(0,5);
      const endpoints=goal.zone
        ? points.filter(p=>isInPlantZone(p,goal.zone)).sort((a,b)=>cost(a,goal)-cost(b,goal))
        : candidates(goal,goal.key==='recover'?1.05:1.85,1.1,16);
      if(!starts.length||!endpoints.length)return [];
      const search=failedEdges?.size?aStar(graph,{oriented:true,
        blocked:(_a,_b,link)=>failedEdges.has(link.fromId+':'+link.toId),
        distance:(a,b,link)=>cost(a.data,b.data)+(link.data.jump?.75:0),heuristic:(a,b)=>cost(a.data,b.data),
      }):finder;
      let bestRoute=null,bestCost=Infinity;
      for(const start of starts)for(const end of endpoints){
        const traversed=search.find(start.id,end.id);
        if(!traversed.length)continue;
        if(goal.zone)return asWaypoints(traversed);
        const walked=traversed.reduce((sum,n,i)=>sum+(i?cost(n.data,traversed[i-1].data):0),0);
        const score=walked+cost(start,from)+cost(end,goal)*(goal.hold?4:1.5);
        if(score<bestCost){bestRoute=traversed;bestCost=score;}
      }
      function asWaypoints(traversed){
        return traversed.reverse().map((n,i,a)=>({...n.data,jump:i>0&&graph.getLink(a[i-1].id,n.id).data.jump}));
      }
      return bestRoute?asWaypoints(bestRoute):[];
    },
  };
}

const difficulty = {
  easy:{reaction:620,aimError:.038,shotDelay:440,range:30},
  normal:{reaction:365,aimError:.021,shotDelay:315,range:38},
  hard:{reaction:215,aimError:.012,shotDelay:235,range:44},
};
function botMode(value){return typeof value==='string'&&Object.hasOwn(difficulty,value)?value:null;}

function botDeployment(p) {
  p.brain={route:[],index:0,goal:null,replanAt:0,seeAt:0,seen:null,aim:null,nextShot:0,edgeAt:0,jumped:false,failedEdges:new Set()};
}
function look(p, x, y, z){
  return {yaw:Math.atan2(x-p.x,p.z-z),pitch:Math.atan2(y-(p.y+1.62),Math.max(.01,Math.hypot(x-p.x,z-p.z)))};
}
function setInput(p,time,aim,x=0,z=0,jump=false){
  p.input={moveX:x,moveZ:z,seq:0,jump,yaw:aim.yaw,pitch:aim.pitch,crouch:false,walk:false};
  p.lastInputAt=time;
}
function smokeBlocks(a,b,s){
  const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z;
  const t=Math.max(0,Math.min(1,((s.x-a.x)*dx+(s.y-a.y)*dy+(s.z-a.z)*dz)/(dx*dx+dy*dy+dz*dz||1)));
  return Math.hypot(a.x+dx*t-s.x,a.y+dy*t-s.y,a.z+dz*t-s.z)<s.radius;
}
function perceive(p, profile, rayBox){
  const r=p.room, origin={x:p.x,y:p.y+1.62,z:p.z};
  let best=null;
  for(const other of r.players.values()){
    if(other.team===p.team||!other.alive||distance(p,other)>profile.range)continue;
    const target={x:other.x,y:other.y+(other.crouch?.72:1),z:other.z};
    const aim=look(p,target.x,target.y,target.z), len=cost(origin,target);
    if(best?.len<=len||(len>5&&Math.abs(delta(aim.yaw,p.yaw))>1.1)||r.smokes.some(s=>smokeBlocks(origin,target,s)))continue;
    const dir={x:(target.x-origin.x)/len,y:(target.y-origin.y)/len,z:(target.z-origin.z)/len};
    if((r.ascent.raycast(origin,dir,len)?.distance??Infinity)<len-.08)continue;
    if(r.barriers.some(b=>rayBox(origin,dir,b,len)<len-.08))continue;
    best={id:other.id,aim,len};
  }
  return best;
}
function objective(p){
  const r=p.room,{bomb}=r, sites=r.map.sites;
  function siteGoal(site,key,hold){
    const a=(p.botSlot*2.4+(p.team==='defend'?1:0));
    return {x:site.x+(hold?Math.cos(a)*3:0),y:site.y,z:site.z+(hold?Math.sin(a)*3:0),zone:site,key,hold};
  }
  if(p.team==='attack'){
    if(bomb?.state==='dropped')return {...bomb,key:'recover'};
    if(bomb?.state==='planted'||bomb?.state==='defusing'){
      const site=sites.find(site=>site.id===bomb.site);
      return site?siteGoal(site,'guard-bomb',true):{...bomb,key:'guard-bomb'};
    }
    const site=sites[(r.round-1)%sites.length];
    return siteGoal(site,'attack-'+site.id+(p.hasBomb?'-carry':''),!p.hasBomb);
  }
  if(bomb?.state==='planted'||bomb?.state==='defusing')return {...bomb,key:'defuse'};
  const site=sites[(p.botSlot+r.round-1)%sites.length];
  return siteGoal(site,'guard-'+site.id,true);
}
function arrived(p,goal,b){
  if(goal.zone){
    if(!goal.hold)return isInPlantZone(p,goal.zone);
    const end=b.goal===goal.key&&b.route.at(-1);
    return end&&distance(p,end)<.17&&Math.abs(p.y-end.y)<.25;
  }
  return distance(p,goal)<(goal.key==='recover'?1.05:1.9)&&Math.abs(p.y-goal.y)<1.4;
}
function move(p,goal,time,dt,handlers){
  const b=p.brain,r=p.room;
  if(arrived(p,goal,b)&&p.grounded){
    setInput(p,time,{yaw:p.yaw+dt*(goal.key.startsWith('guard')?.55:.22),pitch:0});
    if((p.hasBomb&&goal.zone&&p.team==='attack')||(goal.key==='defuse'&&r.bomb.state==='planted'))handlers.interact(p,{action:'start'});
    return;
  }
  if(b.goal!==goal.key||(b.goalPoint&&cost(b.goalPoint,goal)>1.3)){
    b.route=[];b.goal=goal.key;b.goalPoint=goal;b.replanAt=0;b.failedEdges.clear();
  }
  if(!b.route.length&&time>=b.replanAt&&p.grounded){
    b.route=r.botNav.route(p,goal,b.failedEdges);
    b.index=0;b.edgeAt=time;b.jumped=false;b.replanAt=time+1250;
  }
  while(b.index<b.route.length&&distance(p,b.route[b.index])<.065&&Math.abs(p.y-b.route[b.index].y)<.18&&p.grounded){
    b.index++;b.edgeAt=time;b.jumped=false;
  }
  const point=b.route[b.index];
  if(!point){
    if(!goal.zone&&distance(p,goal)<3&&Math.abs(p.y-goal.y)<.6){
      const d=Math.max(.1,distance(p,goal)*2);
      setInput(p,time,look(p,goal.x,p.y+1.62,goal.z),(goal.x-p.x)/d,(goal.z-p.z)/d);
    }else setInput(p,time,{yaw:p.yaw+dt*.7,pitch:0});
    if(b.route.length){b.route=[];b.replanAt=time+350;}
    return;
  }
  if(time-b.edgeAt>2100){
    const previous=b.route[b.index-1];
    if(previous)b.failedEdges.add(previous.id+':'+point.id);
    if(b.failedEdges.size>12)b.failedEdges.clear();
    b.route=[];b.replanAt=time+400;
    setInput(p,time,{yaw:p.yaw,pitch:0});return;
  }
  const dist=distance(p,point), divisor=Math.max(dist,5.2*dt,.001);
  const aim=dist>.08?look(p,point.x,p.y+1.62,point.z):{yaw:p.yaw,pitch:0};
  const jump=point.jump&&!b.jumped&&p.grounded;
  if(jump)b.jumped=true;
  setInput(p,time,aim,(point.x-p.x)/divisor,(point.z-p.z)/divisor,jump);
}
function updateBot(p,time,dt,handlers){
  const r=p.room,b=p.brain,profile=difficulty[r.botMode];
  if(r.phase!=='live'){p.input=null;return;}
  if(time-r.liveAt<p.botSlot*140){p.input=null;return;}
  if(p.interacting){setInput(p,time,{yaw:p.yaw,pitch:p.pitch});return;}
  if(time>=b.seeAt){
    b.seeAt=time+100;
    const target=perceive(p,profile,handlers.rayBox);
    if(target?.id!==b.seen)b.acquiredAt=time;
    b.seen=target?.id;b.aim=target?.aim??null;
  }
  if(p.ammo===0||(!b.aim&&p.ammo<10))handlers.reload(p);
  if(b.aim&&!p.reloading){
    setInput(p,time,b.aim);
    b.edgeAt=time;
    if(time-b.acquiredAt>=profile.reaction&&time>=b.nextShot){
      b.nextShot=time+profile.shotDelay;
      const spread=()=>((handlers.random()+handlers.random())-1)*profile.aimError;
      handlers.fire(p,{yaw:b.aim.yaw+spread(),pitch:b.aim.pitch+spread(),clientTime:time});
    }
    return;
  }
  move(p,objective(p),time,dt,handlers);
}

module.exports={botMode,loadNavigation,botDeployment,updateBot};
