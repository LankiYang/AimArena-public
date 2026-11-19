import * as THREE from 'three';
import { ArenaScene } from './scene.js';
import { AscentWalker } from './ascent-collision.mjs';

const $=id=>document.getElementById(id),show=(id,on=true)=>$(id)?.classList.toggle('hidden',!on);
const safe=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let agent='jett',arena,map,ws,selfId,snapshot,self,local,yaw=0,pitch=0,seq=0,serverOffset=0,lastSend=0,lastShot=0,active=false,aim=false,mouseDown=false,paused=false,leaving=false;
let weapons={},keys=new Set(),fpsFrames=0,fpsTime=0,lastHp=100,uiTime=0,audio;
let predictionWalker,minimapBackground,sensitivity=Number(localStorage.getItem('vw-sensitivity')||1),volume=Number(localStorage.getItem('vw-volume')||.4),quality=localStorage.getItem('vw-quality')||'medium';
const serverNow=()=>Date.now()+serverOffset;
const send=(type,data={})=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type,...data}));};
function toast(text){$('toast').textContent=text;show('toast');clearTimeout(toast.timer);toast.timer=setTimeout(()=>show('toast',false),3200);}
function selectAgent(value){agent=value;$('agentJett')?.classList.toggle('selected',value==='jett');$('agentJett')?.classList.toggle('active',value==='jett');$('agentSage')?.classList.toggle('selected',value==='sage');$('agentSage')?.classList.toggle('active',value==='sage');$('agentJett')?.setAttribute('aria-pressed',String(value==='jett'));$('agentSage')?.setAttribute('aria-pressed',String(value==='sage'));document.body.dataset.agent=value;const portrait=$('heroPortrait');if(portrait)portrait.src=`/assets/ui/${value}-portrait.png`;const title=$('agentName');if(title)title.textContent=value.toUpperCase();const sub=$('agentRole');if(sub)sub.textContent=value==='jett'?'决斗 / DUELIST':'哨卫 / SENTINEL';}
$('agentJett')?.addEventListener('click',()=>selectAgent('jett'));$('agentSage')?.addEventListener('click',()=>selectAgent('sage'));selectAgent('jett');
const storedName=localStorage.getItem('vw-name');if(storedName)$('playerName').value=storedName;
const query=new URLSearchParams(location.search);
if(query.has('room'))$('roomCode').value=query.get('room').slice(0,16);
if(query.get('map')==='ascent-study')$('mapSelect').value='ascent-study';
function selectMap(){const original=$('mapSelect').value==='ascent-b';if($('mapTitle'))$('mapTitle').textContent=original?'ASCENT · B SITE':'ASCENT STUDY';if($('mapSubtitle'))$('mapSubtitle').textContent=original?'原版 B 区几何 · 重建 PBR 材质':'原创地中海风格 · 双点对抗';if($('loadingMapName'))$('loadingMapName').textContent=original?'ASCENT B':'ASCENT STUDY';if($('loadingMapMode'))$('loadingMapMode').textContent=original?'原版 B 区几何 / 重建材质':'原创双点战术场';if($('hudMapName'))$('hudMapName').textContent=original?'ASCENT · B':'ASCENT STUDY';}
$('mapSelect')?.addEventListener('change',selectMap);selectMap();
if($('qualitySelect'))$('qualitySelect').value=quality;if($('sensitivity'))$('sensitivity').value=sensitivity;if($('volume'))$('volume').value=volume;
$('qualitySelect')?.addEventListener('change',e=>{quality=e.target.value;localStorage.setItem('vw-quality',quality);arena?.setQuality(quality);});
$('sensitivity')?.addEventListener('input',e=>{sensitivity=Number(e.target.value);localStorage.setItem('vw-sensitivity',sensitivity);});
$('volume')?.addEventListener('input',e=>{volume=Number(e.target.value);localStorage.setItem('vw-volume',volume);});
$('copyRoomBtn')?.addEventListener('click',async()=>{const url=new URL(location.href);url.search='';url.searchParams.set('room',snapshot?.room||$('roomCode').value);url.searchParams.set('map',map?.id||$('mapSelect').value);try{await navigator.clipboard.writeText(url.href);toast('房间链接已复制，好友使用相同链接即可加入');}catch{toast(`房间码：${snapshot?.room||$('roomCode').value}`);}});

async function join(){
  if(active||$('joinBtn').disabled)return;$('joinBtn').disabled=true;leaving=false;show('loading');$('loadLabel').textContent='建立战术场景…';
  const name=$('playerName').value.trim().slice(0,16)||'PLAYER';localStorage.setItem('vw-name',name);
  try{
    const requestedMap=$('mapSelect')?.value||'ascent-b';
    if(!arena||arena.map.id!==requestedMap){arena?.dispose();arena=null;bombMesh=null;predictionWalker=null;minimapBackground=null;const response=await fetch(`/world.json?map=${encodeURIComponent(requestedMap)}`);if(!response.ok)throw Error('地图数据读取失败');map=await response.json();if(map.id!==requestedMap)throw Error('服务器尚未载入所选地图，请重启服务器');arena=new ArenaScene($('gameCanvas'),map,(p,text)=>{$('loadProgress').style.width=`${Math.round(p*100)}%`;$('loadLabel').textContent=text;});arena.setQuality(quality);await arena.ready;
      if(!arena.assets.jett||!arena.assets.sage||!arena.assets.rifle)throw Error('三维素材加载失败，请检查网络与 assets 文件夹，刷新重试');
    }
    buildMinimapBackground();
    const room=$('roomCode').value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,16)||'ASCENT';
    ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}`);
    const timeout=setTimeout(()=>{if(!active){ws.close();show('loading',false);toast('连接超时，请检查服务器');$('joinBtn').disabled=false;}},10000);
    ws.onopen=()=>send('join',{name,room,agent,map:requestedMap,team:$('teamSelect').value});
    ws.onmessage=event=>{let m;try{m=JSON.parse(event.data);}catch{return;}
      if(m.type==='welcome'){
        clearTimeout(timeout);selfId=m.selfId;weapons=m.weapons;serverOffset=m.serverTime-Date.now();active=true;paused=true;seq=0;keys.clear();show('lobby',false);show('loading',false);show('game');show('hud');show('pauseMenu');$('connectionStatus').textContent=`已连接 · ${m.room}`;toast(`房间 ${m.room} · 分享相同房间码邀请好友`);initAudio();
      }else if(m.type==='snapshot'){
        snapshot=m;serverOffset=serverOffset*.9+(m.serverTime-Date.now())*.1;const p=m.players.find(p=>p.id===selfId);if(!p)return;
        const first=!self;const respawn=self&&!self.alive&&p.alive;self=p;
        if(!local||first||respawn||Math.hypot(local.x-p.x,local.z-p.z)>2){local={...p};if(first||respawn){yaw=p.yaw;pitch=p.pitch;}if(arena.exactWorld)predictionWalker=new AscentWalker(arena.exactWorld,[p.x,p.y,p.z]);}
        else {local.x+=(p.x-local.x)*.28;local.z+=(p.z-local.z)*.28;local.y+=(p.y-local.y)*.5;local.crouch=p.crouch;local.alive=p.alive;if(predictionWalker){const foot=predictionWalker.getFoot();predictionWalker.capsule.translate(new THREE.Vector3(local.x-foot.x,local.y-foot.y,local.z-foot.z));if(Number.isFinite(p.vy))predictionWalker.velocity.y=p.vy;}}
        if(p.hp<lastHp){document.body.classList.add('damaged');setTimeout(()=>document.body.classList.remove('damaged'),180);sound('hit');}lastHp=p.hp;
      }else if(m.type==='event')onEvent(m);
      else if(m.type==='error'){const translated={MAP_MISMATCH:'这个房间已选定另一张地图，请切换地图或使用新房间码',MAP_UNAVAILABLE:'服务器尚未加载此地图，请重启服务器',WALL_BLOCKED:'此处空间不足，请面向空地放置冰墙',NO_SURFACE:'目标位置缺少原始地面，请换一个位置',BUY_PHASE:'请在购买阶段购买装备',CREDITS:'资金不足',ROOM_FULL:'房间人数已满',PLANT_SITE:'携带爆能器进入地图标记的安装区域',ABILITY:'此特工没有该技能'};toast(translated[m.code]||m.message);if(!active){clearTimeout(timeout);show('loading',false);$('joinBtn').disabled=false;ws.close();}}
      else if(m.type==='pong')$('ping').textContent=`${Math.max(1,Date.now()-m.clientTime)} ms`;
    };
    ws.onclose=()=>{clearTimeout(timeout);if(!leaving){toast('服务器连接已断开，请重新加入');leave();} $('joinBtn').disabled=false;};
    ws.onerror=()=>toast('无法连接对战服务器');
  }catch(e){console.error(e);arena?.dispose();arena=null;show('loading',false);toast(e.message||'加载失败');$('joinBtn').disabled=false;}
}
$('joinBtn').addEventListener('click',join);
function leave(){leaving=true;ws?.close();active=false;paused=false;self=local=snapshot=null;mouseDown=false;keys.clear();document.exitPointerLock?.();show('lobby');show('game',false);show('hud',false);show('pauseMenu',false);show('buyMenu',false);show('scoreboard',false);$('joinBtn').disabled=false;for(const [,p]of arena?.players||[])p.root.removeFromParent();arena?.players.clear();}
$('leaveBtn')?.addEventListener('click',leave);
async function resume(){if(!active)return;show('pauseMenu',false);show('buyMenu',false);paused=false;try{await $('gameCanvas').requestPointerLock();}catch{paused=false;show('pauseMenu',false);toast('鼠标锁定未获准：在画面中拖动也可观察');}}
$('resumeBtn')?.addEventListener('click',resume);$('readyBtn')?.addEventListener('click',()=>{send('ready');toast('准备就绪，3 秒后开始回合');});
document.querySelectorAll('[data-weapon]').forEach(b=>b.addEventListener('click',()=>{send('buy',{weapon:b.dataset.weapon});sound('ui');}));
$('closeBuyBtn')?.addEventListener('click',resume);
let hadPointerLock=false;
addEventListener('pointerlockchange',()=>{const locked=!!document.pointerLockElement;if(locked){hadPointerLock=true;return;}if(hadPointerLock&&active&&$('buyMenu').classList.contains('hidden')){paused=true;keys.clear();mouseDown=false;send('interact',{action:'stop'});show('pauseMenu');}hadPointerLock=false;});
addEventListener('keydown',e=>{
  if(!active)return;if(['Space','Tab','KeyB','KeyF'].includes(e.code))e.preventDefault();if(e.code==='Tab'){show('scoreboard');return;}if(e.repeat)return;
  if(e.code==='KeyB'){const opening=$('buyMenu').classList.contains('hidden');show('buyMenu',opening);if(opening){paused=true;keys.clear();mouseDown=false;send('interact',{action:'stop'});document.exitPointerLock?.();show('pauseMenu',false);}else resume();return;}
  if(e.code==='Escape'){paused=true;mouseDown=false;send('interact',{action:'stop'});show('pauseMenu');show('buyMenu',false);return;}
  if(e.code==='Enter'){send('ready');toast('已准备 · 即将开始回合');return;}
  if(paused)return;keys.add(e.code);if(e.code==='KeyR')send('reload');
  if(e.code==='KeyQ')send('ability',{skill:agent==='jett'?'updraft':'slow',x:self.x+Math.sin(yaw)*8,z:self.z-Math.cos(yaw)*8});
  if(e.code==='KeyC')send('ability',{skill:agent==='jett'?'smoke':'wall',x:self.x+Math.sin(yaw)*8,z:self.z-Math.cos(yaw)*8});
  if(e.code==='KeyE')send('ability',{skill:agent==='jett'?'dash':'heal'});
  if(e.code==='KeyF')send('interact',{action:'start'});
});
addEventListener('keyup',e=>{keys.delete(e.code);if(e.code==='Tab')show('scoreboard',false);if(e.code==='KeyF')send('interact',{action:'stop'});});
addEventListener('blur',()=>{keys.clear();mouseDown=false;send('interact',{action:'stop'});send('input',{seq:++seq,moveX:0,moveZ:0,yaw,pitch});});
let drag=false,lastMouse;
$('gameCanvas').addEventListener('mousedown',e=>{if(!active||paused)return;initAudio();if(e.button===0){mouseDown=true;tryShoot(performance.now());if(!document.pointerLockElement)drag=true;}if(e.button===2)aim=true;lastMouse={x:e.clientX,y:e.clientY};});
addEventListener('mouseup',e=>{if(e.button===0){mouseDown=false;drag=false;}if(e.button===2)aim=false;});
addEventListener('mousemove',e=>{if(!active||paused)return;const locked=document.pointerLockElement;let dx=locked?e.movementX:drag?e.clientX-(lastMouse?.x??e.clientX):0,dy=locked?e.movementY:drag?e.clientY-(lastMouse?.y??e.clientY):0;lastMouse={x:e.clientX,y:e.clientY};const gain=(aim?.00125:.002)*sensitivity;yaw+=dx*gain;pitch=THREE.MathUtils.clamp(pitch-dy*gain,-1.48,1.48);});
$('gameCanvas').addEventListener('contextmenu',e=>e.preventDefault());

function collides(x,z,y,crouch){const r=.32,h=crouch?1.2:1.8;return [...map.boxes,...(snapshot?.barriers||[])].some(b=>x+r>b.x-b.w/2&&x-r<b.x+b.w/2&&z+r>b.z-b.d/2&&z-r<b.z+b.d/2&&y+h>b.y-b.h/2+.02&&y<b.y+b.h/2-.02);}
function predict(dx,dz){const b=map.bounds;const x=THREE.MathUtils.clamp(local.x+dx,b.minX+.32,b.maxX-.32);if(!collides(x,local.z,local.y,local.crouch))local.x=x;const z=THREE.MathUtils.clamp(local.z+dz,b.minZ+.32,b.maxZ-.32);if(!collides(local.x,z,local.y,local.crouch))local.z=z;}
function tryShoot(time){const w=weapons[self?.weapon];if(paused||!self?.alive||!w||!['waiting','live'].includes(snapshot?.phase)||self.reloading>serverNow()||self.ammo<=0)return;if(time-lastShot>w.interval){send('fire',{yaw,pitch,shotId:++frame.shotId,clientTime:serverNow()});lastShot=time;}}
function onEvent(m){
  if(m.event==='shot'){const a=m.origin,b=m.end;if(a&&b)arena.shot([a.x,a.y,a.z],[b.x,b.y,b.z],m.playerId===selfId?'#ffe5b6':'#ffaaa0');if(m.playerId===selfId){arena.fire();sound('shot');}else{arena.playerAction(m.playerId,'shot');if(self&&a&&Math.hypot(a.x-self.x,a.z-self.z)<35)sound('distant');}}
  if(m.event==='hit'&&m.playerId===selfId){$('crosshair').classList.add('hit');setTimeout(()=>$('crosshair').classList.remove('hit'),150);sound(m.headshot?'head':'hit');}
  if(m.event==='kill'){const line=document.createElement('div');line.className='kill-row';line.innerHTML=`<span>${safe(m.killerName)}</span><b>${m.headshot?'◇':'—'} ${safe(m.weapon).toUpperCase()} →</b><span>${safe(m.targetName)}</span>`;$('killfeed').prepend(line);setTimeout(()=>line.remove(),5500);}
  if(m.event==='roundStart'){toast(`第 ${m.round} 回合 · 按 B 购买武器`);sound('ui');}
  if(m.event==='live'){toast('屏障降下 · 行动开始');sound('start');}
  if(m.event==='roundEnd'){toast(`${m.winner==='attack'?'进攻方':'防守方'}获胜 · ${m.reason==='elimination'?'全员击破':m.reason==='defused'?'爆能器已拆除':m.reason==='exploded'?'爆能器引爆':'回合结束'}`);sound('start');}
  if(m.event==='plant')toast('爆能器已部署 · 防守方按住 F 拆除');
  if(m.event==='ability'&&m.playerId===selfId){sound('ability');if(m.skill==='dash'&&local){local.x=m.x;local.z=m.z;if(predictionWalker)predictionWalker.reset([m.x,m.y,m.z]);}if(m.skill==='updraft'&&predictionWalker)predictionWalker.velocity.y=7.5;}
  if(m.event==='ability'&&m.playerId!==selfId)arena.playerAction(m.playerId,'ability');
  if(m.event==='reload'&&m.playerId===selfId)sound('reload');
  if(m.event==='joined'&&m.playerId!==selfId)toast(`${m.name} 已加入${m.team==='attack'?'进攻':'防守'}方`);
}
function initAudio(){if(!audio){try{audio=new AudioContext();}catch{}}audio?.resume();}
function sound(kind){if(!audio||audio.state!=='running')return;const t=audio.currentTime,g=audio.createGain();g.connect(audio.destination);const vol=kind==='shot'?.15:kind==='distant'?.025:.065;g.gain.setValueAtTime(Math.max(.001,vol*volume),t);g.gain.exponentialRampToValueAtTime(.001,t+.17);if(['shot','distant','hit'].includes(kind)){const b=audio.createBuffer(1,audio.sampleRate*.15,audio.sampleRate),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.exp(-i/d.length*5);const source=audio.createBufferSource();source.buffer=b;const f=audio.createBiquadFilter();f.type='lowpass';f.frequency.value=kind==='shot'?2300:1000;source.connect(f).connect(g);source.start();}const o=audio.createOscillator();o.type=kind==='shot'?'triangle':'sine';o.frequency.setValueAtTime(({shot:130,head:1300,hit:340,ui:650,start:520,ability:420,reload:700,distant:70})[kind]||400,t);o.frequency.exponentialRampToValueAtTime(kind==='shot'?35:800,t+.12);o.connect(g);o.start();o.stop(t+.18);}
function mapProjection(w,h){const b=map.bounds,scale=Math.min((w-12)/(b.maxX-b.minX),(h-12)/(b.maxZ-b.minZ));return{scale,cx:w/2-(b.minX+b.maxX)/2*scale,cy:h/2-(b.minZ+b.maxZ)/2*scale};}
function buildMinimapBackground(){
  const c=document.createElement('canvas');c.width=c.height=180;const ctx=c.getContext('2d'),{scale,cx,cy}=mapProjection(180,180);ctx.fillStyle='#0c1d25ed';ctx.fillRect(0,0,180,180);
  if(arena.exactWorld){const geo=arena.exactWorld.geometry,pos=geo.attributes.position,ix=geo.index.array;for(let i=0;i<ix.length;i+=3){const a=ix[i],b=ix[i+1],d=ix[i+2];const ax=pos.getX(a),az=pos.getZ(a),ay=pos.getY(a),bx=pos.getX(b),bz=pos.getZ(b),by=pos.getY(b),dx=pos.getX(d),dz=pos.getZ(d),dy=pos.getY(d);const area=(bx-ax)*(dz-az)-(bz-az)*(dx-ax);if(Math.abs(area)<.025)continue;const y=(ay+by+dy)/3;if(y>7)continue;ctx.fillStyle=y<.5?'#43575e':'#76878a';ctx.beginPath();ctx.moveTo(cx+ax*scale,cy+az*scale);ctx.lineTo(cx+bx*scale,cy+bz*scale);ctx.lineTo(cx+dx*scale,cy+dz*scale);ctx.fill();}}
  else{ctx.fillStyle='#71848888';for(const b of map.boxes)ctx.fillRect(cx+(b.x-b.w/2)*scale,cy+(b.z-b.d/2)*scale,b.w*scale,b.d*scale);}minimapBackground=c;
}
function minimap(){const c=$('minimap'),ctx=c.getContext('2d'),w=c.width,h=c.height,{scale,cx,cy}=mapProjection(w,h);ctx.clearRect(0,0,w,h);if(minimapBackground)ctx.drawImage(minimapBackground,0,0,w,h);for(const s of map.sites){ctx.strokeStyle='#d7bd86';ctx.beginPath();ctx.arc(cx+s.x*scale,cy+s.z*scale,s.radius*scale,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#ede4cd';ctx.font='bold 12px Arial';ctx.textAlign='center';ctx.fillText(s.id,cx+s.x*scale,cy+s.z*scale+4);}for(const p of snapshot.players){if(!p.alive||p.team!==self.team)continue;ctx.fillStyle=p.id===selfId?'#fff6d9':'#83d9c6';ctx.beginPath();ctx.arc(cx+p.x*scale,cy+p.z*scale,p.id===selfId?3.5:2.5,0,Math.PI*2);ctx.fill();if(p.id===selfId){ctx.strokeStyle='#fff6d9';ctx.beginPath();ctx.moveTo(cx+p.x*scale,cy+p.z*scale);ctx.lineTo(cx+p.x*scale+Math.sin(yaw)*9,cy+p.z*scale-Math.cos(yaw)*9);ctx.stroke();}}}

function updateHUD(){if(!self||!snapshot)return;const now=serverNow(),phase=snapshot.phase;const remaining=Math.max(0,Math.ceil((snapshot.phaseEndsAt-now)/1000));$('health').textContent=Math.ceil(self.hp);$('armor').textContent=Math.ceil(self.armor||0);$('ammo').textContent=self.ammo;$('reserve').textContent=self.reserve;$('weaponName').textContent=self.weapon.toUpperCase();$('scoreAttack').textContent=snapshot.score.attack;$('scoreDefend').textContent=snapshot.score.defend;$('roundTime').textContent=phase==='waiting'?'—:—':`${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;$('phaseLabel').textContent=({waiting:'等待对手 / FREE ROAM',buy:'购买阶段 / BUY PHASE',live:'回合进行中',end:'回合结束'})[phase];$('roundLabel').textContent=`ROUND ${String(snapshot.round).padStart(2,'0')}`;
  const credits=$('credits');if(credits)credits.textContent=self.credits.toLocaleString();const shopCredits=$('shopCredits');if(shopCredits)shopCredits.textContent=self.credits.toLocaleString();
  const roster=snapshot.players.map(p=>`<div class="roster-player ${p.team===self.team?'ally':'enemy'} ${p.alive?'':'dead'}"><img src="/assets/ui/${p.agent}-icon.png" alt="${safe(p.agent)}"><span>${safe(p.name)}</span></div>`).join('');if($('teamRoster').innerHTML!==roster)$('teamRoster').innerHTML=roster;
  const scoreRows=`<div class="scoreboard-title">${safe(snapshot.room)} <small>${snapshot.players.length}/10 · 真人对战</small></div><table><thead><tr><th>玩家</th><th>阵营</th><th>角色</th><th>生命</th><th>武器</th><th>资金</th></tr></thead><tbody>${snapshot.players.map(p=>`<tr class="${p.id===selfId?'self':''}"><td>${safe(p.name)}</td><td>${p.team==='attack'?'进攻':'防守'}</td><td>${p.agent.toUpperCase()}</td><td>${p.alive?p.hp:'阵亡'}</td><td>${p.weapon.toUpperCase()}</td><td>${p.credits}</td></tr>`).join('')}</tbody></table>`;if(!$('scoreboard').classList.contains('hidden'))$('scoreboard').innerHTML=scoreRows;
  $('connectionStatus').textContent=`${snapshot.room} · ${snapshot.players.length}/10 在线`;
  const near=map.sites.find(s=>Math.hypot(s.x-self.x,s.z-self.z)<=s.radius),bomb=snapshot.bomb||{};
  let hint=phase==='waiting'?'等待另一阵营加入 · 你可以自由探索、试枪和施放技能':phase==='buy'?'按 B 购买武器 · 按 Enter 准备，缩短倒计时':self.hasBomb&&near?'按住 F 部署爆能器':bomb.state==='planted'&&Math.hypot(self.x-bomb.x,self.z-bomb.z)<3?'按住 F 拆除爆能器':'WASD 移动  ·  C Q E '+(agent==='jett'?'烟雾 / 凌空 / 冲刺':'冰墙 / 减速 / 治疗')+'  ·  F 装拆包  ·  B 购买';
  if(!self.alive)hint='你已阵亡 · 等待下一回合';if(bomb.state==='planting'||bomb.state==='defusing')hint=`${bomb.state==='planting'?'部署':'拆除'}中 ${Math.round(bomb.progress*100)}%`;$('hint').textContent=hint;
  $('readyBtn')?.classList.toggle('hidden',phase!=='buy');
  for(const skill of ['smoke','updraft','dash','wall','slow','heal']){const el=$(`cooldown-${skill}`);if(el){const cd=Math.ceil(((self.abilityCooldowns?.[skill]||0)-now)/1000);el.textContent=cd>0?`${cd}s`:'就绪';}}
  $('gameCanvas').dataset.controlState=JSON.stringify({paused,keys:[...keys],agent,yaw,pitch});
  $('gameCanvas').dataset.worldPosition=`${self.x.toFixed(3)},${self.y.toFixed(3)},${self.z.toFixed(3)}`;
  $('gameCanvas').dataset.graphics=JSON.stringify(arena.stats());
  minimap();updateBomb();
}
let bombMesh;
function updateBomb(){if(!snapshot)return;const b=snapshot.bomb;if(!b){if(bombMesh)bombMesh.visible=false;return;}if(!bombMesh){bombMesh=new THREE.Group();const base=new THREE.Mesh(new THREE.CylinderGeometry(.18,.32,.5,6),new THREE.MeshStandardMaterial({color:'#263e40',metalness:.6,roughness:.4}));base.position.y=.25;bombMesh.add(base);const core=new THREE.Mesh(new THREE.OctahedronGeometry(.18,0),new THREE.MeshStandardMaterial({color:'#9ff7ea',emissive:'#57d8c7',emissiveIntensity:2}));core.position.y=.52;bombMesh.add(core);arena.scene.add(bombMesh);}bombMesh.visible=['planted','dropped','defusing'].includes(b.state);bombMesh.position.set(b.x||0,b.y||0,b.z||0);if(bombMesh.visible){bombMesh.children[1].rotation.y=performance.now()*.002;}}

let last=performance.now();function frame(time){requestAnimationFrame(frame);const dt=Math.min(.05,(time-last)/1000);last=time;if(!active||!self||!arena||!local)return;
  let forward=(keys.has('KeyW')?1:0)-(keys.has('KeyS')?1:0),right=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0);if(paused){forward=right=0;}
  let moveX=Math.sin(yaw)*forward+Math.cos(yaw)*right,moveZ=-Math.cos(yaw)*forward+Math.sin(yaw)*right;const n=Math.max(1,Math.hypot(moveX,moveZ));moveX/=n;moveZ/=n;const crouch=keys.has('ControlLeft'),walk=keys.has('ShiftLeft');local.crouch=crouch;
  const slowed=(snapshot.slows||[]).some(s=>s.team!==self.team&&Math.abs(local.y-(s.y||0))<.8&&Math.hypot(local.x-s.x,local.z-s.z)<s.radius),moveSpeed=(crouch?2.1:walk?2.8:5.2)*(slowed?.45:1);
  if(predictionWalker&&self.alive){const allowed=!paused&&!['buy','end'].includes(snapshot.phase);const old=predictionWalker.getFoot();const foot=predictionWalker.update(new THREE.Vector3(allowed?moveX:0,0,allowed?moveZ:0),dt,{jump:allowed&&keys.has('Space'),crouch,speed:moveSpeed});if(collides(foot.x,foot.z,foot.y,crouch)){predictionWalker.capsule.translate(new THREE.Vector3(old.x-foot.x,0,old.z-foot.z));}const pos=predictionWalker.getFoot();local.x=pos.x;local.y=pos.y;local.z=pos.z;local.crouch=predictionWalker.crouched;if(predictionWalker.fellOut)predictionWalker.reset([self.x,self.y,self.z]);}else if(self.alive&&!paused&&!['buy','end'].includes(snapshot.phase))predict(moveX*moveSpeed*dt,moveZ*moveSpeed*dt);
  if(time-lastSend>1000/60){send('input',{seq:++seq,moveX,moveZ,yaw,pitch,jump:keys.has('Space'),walk,crouch});lastSend=time;}
  if(mouseDown)tryShoot(time);
  arena.camera.fov=THREE.MathUtils.lerp(arena.camera.fov,aim?58:76,dt*12);arena.camera.updateProjectionMatrix();arena.updatePlayers(snapshot.players,selfId,self.team,dt);arena.updateSmokes(snapshot.smokes||[],dt);arena.updateAbilities(snapshot.barriers||[],snapshot.slows||[],dt);arena.update(dt,local,yaw,pitch,!!(forward||right),Math.max(0,(self.reloading-serverNow())/1000),walk);
  const inside=(snapshot.smokes||[]).some(s=>Math.hypot(local.x-s.x,local.y+1.6-s.y,local.z-s.z)<s.radius);document.body.classList.toggle('in-smoke',inside);
  if(time-uiTime>100){updateHUD();uiTime=time;}fpsFrames++;fpsTime+=dt;if(fpsTime>=1){const el=$('fps');if(el)el.textContent=`${Math.round(fpsFrames/fpsTime)} FPS`;fpsFrames=0;fpsTime=0;}
}frame.shotId=0;requestAnimationFrame(frame);
setInterval(()=>{if(active)send('ping',{clientTime:Date.now()});},2000);
// Read-only diagnostics used by the browser acceptance checklist.
Object.defineProperty(window,'valorantDiagnostics',{get:()=>({connected:ws?.readyState===1,room:snapshot?.room,players:snapshot?.players.length,phase:snapshot?.phase,self:self?{id:self.id,x:self.x,z:self.z,hp:self.hp,ammo:self.ammo,agent:self.agent}:null,graphics:arena?.stats()})});
