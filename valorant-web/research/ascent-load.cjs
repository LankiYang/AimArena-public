'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {WebSocket}=require('ws');
const {createGameServer,loadAscentWorld}=require('../server.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const ascentWorld=await loadAscentWorld(),game=createGameServer({ascentWorld,readyMs:20,durations:{buy:100,live:10000}});
 const address=await game.listen(0,'127.0.0.1'),clients=[],report={map:'ascent-b',triangles:ascentWorld.stats?.triangleCount,clients:10,durationMs:3000,passed:false};
 try{
  for(let i=0;i<10;i++){
   const ws=new WebSocket(`ws://127.0.0.1:${address.port}`),c={ws,snapshots:0,last:null,pongs:[]};clients.push(c);
   ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='snapshot'){c.snapshots++;c.last=m;}if(m.type==='pong')c.pongs.push(Date.now()-m.clientTime);});
   await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.send(JSON.stringify({type:'join',name:'CPU-'+i,room:'LOADCHECK',team:i<5?'attack':'defend',agent:i%2?'sage':'jett',map:'ascent-b'}));
  }
  await delay(200);assert(clients.every(c=>c.last?.players.length===10));
  const started=performance.now();let iterations=0;const interval=setInterval(()=>{
   iterations++;clients.forEach((c,i)=>{c.ws.send(JSON.stringify({type:'input',seq:iterations,moveX:Math.sin(iterations*.03+i)*.4,moveZ:i<5?-.6:.5,yaw:0,pitch:0,walk:iterations%30<15,jump:iterations%60===0}));if(iterations%15===0)c.ws.send(JSON.stringify({type:'ping',clientTime:Date.now()}));});
  },1000/60);
  await delay(report.durationMs);clearInterval(interval);const elapsed=performance.now()-started;
  for(const c of clients){assert(c.last.players.every(p=>[p.x,p.y,p.z,p.hp].every(Number.isFinite)));assert(c.last.players.every(p=>p.y>-5));assert(c.snapshots>=20);assert(c.pongs.length>=3);}
  report.elapsedMs=Math.round(elapsed);report.inputIterations=iterations;report.snapshotCounts=clients.map(c=>c.snapshots);const pongs=clients.flatMap(c=>c.pongs).sort((a,b)=>a-b);report.pongMedianMs=pongs[Math.floor(pongs.length*.5)];report.pong95Ms=pongs[Math.floor(pongs.length*.95)];report.passed=true;report.scope='Ten loopback clients on this host, three-second bounded CPU responsiveness check; not internet or production capacity certification.';
 }finally{clients.forEach(c=>c.ws.close());await game.close();fs.mkdirSync(new URL('../artifacts/',`file:///${__dirname.replaceAll('\\','/')}/`),{recursive:true});fs.writeFileSync(require('node:path').join(__dirname,'../artifacts/ascent-load.json'),JSON.stringify(report,null,2),'utf8');}
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
