'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {createGameServer,loadAscentWorld}=require('../server.cjs');
const {releaseIds}=require('../shared/ascent-world.cjs');
const {loadNavigation,botDeployment,updateBot}=require('../shared/bots.cjs');
const {isInPlantZone}=require('../src/plant-zone.mjs');

test('all release maps have usable directed routes from every seat to each objective',async()=>{
  for(const id of releaseIds){
    const adapter=await loadAscentWorld(id), nav=loadNavigation(adapter);
    assert.ok(nav,id);
    for(const [team,spawns] of Object.entries(adapter.map.spawns))for(const [i,spawn] of spawns.entries())for(const site of adapter.map.sites){
      const route=nav.route(spawn,{...site,zone:site});
      assert.ok(route.length>0&&isInPlantZone(route.at(-1),site),`${id} ${team} seat ${i+1} to ${site.id}`);
    }
  }
});

async function socket(url,join){
  const ws=new WebSocket(url), messages=[];
  ws.addEventListener('message',e=>messages.push(JSON.parse(e.data)));
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.send(JSON.stringify({type:'join',...join}));
  async function wait(pred){
    for(let i=0;i<200;i++){
      const message=messages.find(pred);if(message)return message;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail('Expected message not received, recent types: '+messages.slice(-8).map(m=>m.event||m.code||m.type));
  }
  return {ws,messages,wait};
}

test('one real client starts a bot match; bots fight and play the objective, and guests replace bots',async t=>{
  let now=100000;
  const adapter=await loadAscentWorld('ascent-full');
  const game=createGameServer({releaseWorlds:[adapter],now:()=>now,random:()=>.5,durations:{buy:100}});
  t.after(()=>game.close());
  const {port}=await game.listen(0,'127.0.0.1'), url='ws://127.0.0.1:'+port;
  const player=await socket(url,{room:'training',team:'attack',botMode:'normal'});
  const snapshot=await player.wait(m=>m.type==='snapshot'&&m.phase==='buy');
  assert.equal(snapshot.botMode,'normal');
  assert.equal(snapshot.players.length,10);
  assert.equal(snapshot.players.filter(p=>p.bot).length,9);
  const r=game.rooms.get('training'), carrierId=r.bomb.carrierId, carrier=r.players.get(carrierId);
  assert.equal(carrier.bot,true);
  const originalAmmo=carrier.ammo;
  let approach;
  let shot=false, planted=false;
  for(let frame=0;frame<3200&&!planted;frame++){
    now+=1000/60;game.update(1/60);
    shot ||= [...r.players.values()].some(p=>p.bot&&p.ammo<originalAmmo);
    if(carrier.brain.route.length>10)approach=carrier.brain.route.slice();
    planted=r.bomb.state==='planted';
    if(frame%30===0)await new Promise(resolve=>setImmediate(resolve));
  }
  assert.ok(shot,'bots should engage after leaving spawn');
  assert.ok(planted,'a bot should reach site A and plant without help');
  assert.ok(Math.hypot(carrier.spawn.x-r.bomb.x,carrier.spawn.z-r.bomb.z)>20);
  assert.ok(isInPlantZone(r.bomb,r.map.sites[0]));
  await player.wait(m=>m.type==='snapshot'&&m.bomb?.state==='planted');
  const guest=await socket(url,{room:'training',team:'defend',botMode:'normal'});
  await guest.wait(m=>m.type==='snapshot'&&m.players.filter(p=>p.bot).length===8);
  assert.equal([...r.players.values()].filter(p=>p.team==='defend').length,5);
  const wrong=await socket(url,{room:'training',botMode:'hard'});
  assert.equal((await wrong.wait(m=>m.type==='error')).code,'MODE_MISMATCH');
  const pvp=await socket(url,{room:'real-only',botMode:'pvp'});
  assert.equal((await pvp.wait(m=>m.type==='snapshot')).players.length,1);
  const health=await (await fetch('http://127.0.0.1:'+port+'/health')).json();
  assert.equal(health.players,3);assert.equal(health.bots,8);
  // Set up an uncontested retake on the already traversed route.
  for(const p of r.players.values())if(p.team==='attack'&&p.bot)p.alive=false;
  const defender=[...r.players.values()].find(p=>p.team==='defend'&&p.bot&&p.alive);
  const retake=approach.findLast(p=>Math.hypot(p.x-r.bomb.x,p.z-r.bomb.z)>5);
  assert.ok(defender&&retake);
  Object.assign(defender,{x:retake.x,y:retake.y,z:retake.z,vy:0,input:null});
  adapter.sync(defender);
  botDeployment(defender);
  for(let frame=0;frame<2320&&r.phase==='live';frame++){
    now+=1000/60;game.update(1/60);
    if(frame%30===0)await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(r.lastResult?.reason,'defused',JSON.stringify({bomb:r.bomb,defenders:[...r.players.values()].filter(p=>p.bot&&p.team==='defend').map(p=>[p.alive,p.x,p.y,p.z,p.brain.goal,p.brain.index,p.brain.route.length])}));
  guest.ws.close();player.ws.close();
  for(let i=0;i<100&&game.rooms.has('training');i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(game.rooms.has('training'),false);
});

test('bot reacts to a visible opponent, but cannot target them through smoke or an ice wall',()=>{
  const enemy={id:'human',team:'attack',alive:true,x:0,y:0,z:-14};
  const room={phase:'live',liveAt:0,botMode:'normal',players:new Map([[enemy.id,enemy]]),ascent:{raycast:()=>null},smokes:[],barriers:[],map:{sites:[{id:'A',x:0,y:0,z:0,radius:3}]}};
  const p={x:0,y:0,z:0,yaw:0,pitch:0,ammo:30,team:'defend',botSlot:0,grounded:true,room};
  room.round=1;
  botDeployment(p);
  let shots=0;
  const actions={fire:()=>shots++,interact:()=>{},reload:()=>{},rayBox:()=>7,random:()=>.5};
  room.botNav={route:()=>[]};
  room.smokes=[{x:0,y:1.3,z:-7,radius:3}];
  for(let t=100;t<=1000;t+=100)updateBot(p,t,1/60,actions);
  assert.equal(shots,0);
  room.smokes=[];room.barriers=[{}];
  for(let t=1100;t<=2000;t+=100)updateBot(p,t,1/60,actions);
  assert.equal(shots,0);
  room.barriers=[];
  for(let t=2100;t<=2400;t+=100)updateBot(p,t,1/60,actions);
  assert.equal(shots,0);
  updateBot(p,2500,1/60,actions);
  assert.equal(shots,1);
});
