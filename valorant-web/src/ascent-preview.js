import * as THREE from 'three';
import { buildAscentCollision, AscentWalker, ASCENT_SPAWNS } from './ascent-collision.mjs';
import { buildAscentEnvironment } from './ascent-environment.js';

const $=id=>document.getElementById(id),canvas=$('view');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
const scene=new THREE.Scene();scene.background=new THREE.Color('#73827e');scene.fog=new THREE.Fog('#73827e',55,190);
const camera=new THREE.PerspectiveCamera(74,innerWidth/innerHeight,.04,240);
const worldRoot=new THREE.Group();scene.add(worldRoot);
const safeSpawn=[-23.6,1,-50];
let world=null,walker=null,yaw=-ASCENT_SPAWNS.bMain.yaw,pitch=0,started=false,jumpQueued=false,lastTime=performance.now(),moveToastTimer=0;
const keys=new Set(),eye=new THREE.Vector3(),forward=new THREE.Vector3(),right=new THREE.Vector3(),move=new THREE.Vector3();let crouch=false;
function message(text){const toast=$('toast');toast.textContent=text;toast.classList.remove('hidden');clearTimeout(moveToastTimer);moveToastTimer=setTimeout(()=>toast.classList.add('hidden'),2300);}
function setup() {
  world=buildAscentCollision(window.__ascentGLB);walker=new AscentWalker(world,safeSpawn);const environment=buildAscentEnvironment(scene,world.geometry,{quality:'high'});environment.ready.then(()=>{renderer.shadowMap.needsUpdate=true;});
  $('loadStatus').textContent=`${world.stats.triangleCount.toLocaleString()} 三角 · 碰撞就绪`;
  const floor=world.floorAt(safeSpawn[0],safeSpawn[2],4,8);if(!floor)throw new Error('B Main 出生点缺少实际地面');
  camera.position.copy(walker.getEye());window.__ascentWalk={ready:true,stats:world.stats,environment,renderer,scene,world,walker,camera,safeSpawn,selectSpawn(point){walker.reset(point);yaw=-ASCENT_SPAWNS.bMain.yaw;pitch=0;}};updateHud();
}
fetch('/assets/maps/ascent-b.glb').then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.arrayBuffer();}).then(data=>{window.__ascentGLB=data;setup();}).catch(error=>{$('loadStatus').textContent='地图载入失败';message(error.message);console.error(error);});
function updateHud(){if(!walker||!world)return;const p=walker.getFoot();$('position').textContent=`XYZ  ${p.x.toFixed(1)} / ${p.y.toFixed(2)} / ${p.z.toFixed(1)}`;const surface=world.floorAt(p.x,p.z,p.y+1.8,4);$('surface').textContent=surface?`地面命中  +${surface.distance.toFixed(2)} m`:'下方无地面';}
function requestMouse(){canvas.requestPointerLock?.();}
$('start').addEventListener('click',()=>{if(!world)return;started=true;$('entry').classList.add('hidden');requestMouse();});
document.addEventListener('pointerlockchange',()=>{keys.clear();jumpQueued=false;if(document.pointerLockElement===canvas){started=true;$('entry').classList.add('hidden');}else if(started){started=false;$('entry').classList.remove('hidden');}});
document.addEventListener('mousemove',event=>{if(document.pointerLockElement!==canvas)return;yaw-=event.movementX*.0022;pitch=THREE.MathUtils.clamp(pitch-event.movementY*.0022,-1.35,1.35);});
document.addEventListener('keydown',event=>{if(document.pointerLockElement!==canvas)return;const key=event.key.toLowerCase();if(['w','a','s','d',' ','shift','c'].includes(key))event.preventDefault();if(key===' '&&!event.repeat)jumpQueued=true;if(key==='c'&&!event.repeat)crouch=!crouch;keys.add(key);});
document.addEventListener('keyup',event=>keys.delete(event.key.toLowerCase()));addEventListener('blur',()=>keys.clear());
function tick(now){const dt=Math.min(.05,(now-lastTime)/1000);lastTime=now;if(walker){forward.set(-Math.sin(yaw),0,-Math.cos(yaw));right.set(Math.cos(yaw),0,-Math.sin(yaw));move.set(0,0,0);if(started){if(keys.has('w'))move.add(forward);if(keys.has('s'))move.sub(forward);if(keys.has('d'))move.add(right);if(keys.has('a'))move.sub(right);}const speed=keys.has('shift')?2.7:crouch?1.6:5.4;walker.update(move,dt,{jump:started&&jumpQueued,crouch,speed});jumpQueued=false;if(walker.fellOut){walker.reset(safeSpawn);yaw=-ASCENT_SPAWNS.bMain.yaw;pitch=0;message('此处原始地图有缺口，已返回 B Main 安全出生点。');}camera.position.copy(walker.getEye(eye));camera.rotation.set(pitch,yaw,0,'YXZ');updateHud();}renderer.render(scene,camera);}
renderer.setAnimationLoop(tick);addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
