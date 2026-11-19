import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { FPSFirstPersonRig } from './fps-first-person-rig.js';
import { MotionController } from './character-motion.js';
import { RemotePose } from './remote-pose.js';
import { attachThirdPersonWeapon } from './third-person-weapon.js';
import { loadAscentCollision } from './ascent-collision.mjs';

const loader = new GLTFLoader();
let locomotionRequest;
function loadLocomotion(){
  return locomotionRequest ??= fetch('/assets/animations/bot-locomotion.json').then(async response=>{
    if(!response.ok)throw new Error('第三人称移动动画加载失败');
    return (await response.json()).clips;
  }).catch(error=>{locomotionRequest=null;throw error;});
}
const materials = new Map();
const box = new THREE.BoxGeometry(1,1,1);
const tmp = new THREE.Object3D();
const mat = (color, roughness=.85, metalness=0) => {
  const key=[color,roughness,metalness].join();
  if(!materials.has(key)) materials.set(key,new THREE.MeshStandardMaterial({color,roughness,metalness}));
  return materials.get(key);
};
function canvasTexture(draw,size=256){const c=document.createElement('canvas');c.width=c.height=size;draw(c.getContext('2d'),size);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}
function plasterTexture(){return canvasTexture((c,s)=>{c.fillStyle='#d8cbb9';c.fillRect(0,0,s,s);let seed=42;for(let i=0;i<18000;i++){seed=(seed*16807)%2147483647;const n=seed/2147483647; c.fillStyle=`rgba(${n>.5?'255,255,255':'74,57,44'},${.015+n*.055})`;c.fillRect((i*31)%s,Math.floor(i*13.73)%s,1+n*4,1+n*3);}});}
function stoneTexture(){const t=canvasTexture((c,s)=>{c.fillStyle='#a8a8a0';c.fillRect(0,0,s,s);for(let y=0;y<8;y++)for(let x=0;x<4;x++){const xx=x*64+(y%2)*32; c.fillStyle=['#c1c0b4','#b7b7ac','#cac9bc','#aeb0a6'][(x*7+y*3)%4];c.fillRect(xx, y*32+1,62,30);c.fillRect(xx-s,y*32+1,62,30);c.strokeStyle='#92978f';c.strokeRect(xx,y*32,64,32);}for(let i=0;i<3000;i++){c.fillStyle=i%2?'#ffffff0d':'#3333330c';c.fillRect((i*113)%s,(i*47)%s,2,2);}});t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(28,24);return t;}
function labelTexture(text,color='#efe7d7',bg='transparent') {return canvasTexture((c,s)=>{c.clearRect(0,0,s,s);if(bg!=='transparent'){c.fillStyle=bg;c.fillRect(0,0,s,s);}c.fillStyle=color;c.font=`bold ${text.length>5?28:110}px Arial`;c.textAlign='center';c.textBaseline='middle';c.fillText(text,s/2,s/2);});}

export class ArenaScene {
  constructor(canvas,map,onProgress){
    this.map=map;this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#91b5c8');this.scene.fog=new THREE.Fog('#b7cbd2',75,180);
    this.camera=new THREE.PerspectiveCamera(76,innerWidth/innerHeight,.06,280);this.camera.rotation.order='YXZ';
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.65));this.renderer.setSize(innerWidth,innerHeight);
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.renderer.shadowMap.autoUpdate=false;this.renderer.shadowMap.needsUpdate=true;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.12;
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    if(!map.collision){
    this.scene.add(new THREE.HemisphereLight('#dceaff','#65625a',2.5));
    const sun=new THREE.DirectionalLight('#ffe1b0',4.5);sun.position.set(-32,48,20);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-60,right:60,top:50,bottom:-50,near:1,far:130});sun.shadow.normalBias=.06;sun.shadow.bias=-.0002;this.scene.add(sun);
    const fill=new THREE.DirectionalLight('#a9d6ff',.5);fill.position.set(30,12,-25);this.scene.add(fill);
    }
    this.static=new THREE.Group();this.scene.add(this.static);this.dynamic=new THREE.Group();this.scene.add(this.dynamic);
    this.players=new Map();this.effects=[];this.smokes=new Map();this.barriers=new Map();this.slows=new Map();this.assets={};this.viewRig=null;this.scene.add(this.camera);
    if(!map.collision){this.buildMap();this.buildSkyline();this.mergeStatic();}
    if(map.collision==='volumes'){
      let art=0,models=0;
      this.ready=Promise.all([
        this.loadAssets((p,label)=>{models=p;onProgress?.(art*.86+models*.14,label);}),
        this.loadFullMap((p,label)=>{art=p;onProgress?.(art*.86+models*.14,label);}),
      ]);
    }else this.ready=Promise.all([this.loadAssets(onProgress),map.id==='ascent-b'?this.loadOriginalMap(onProgress):Promise.resolve()]);
    this.resizeHandler=()=>{this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix();this.renderer.setSize(innerWidth,innerHeight);};addEventListener('resize',this.resizeHandler);
  }
  async loadOriginalMap(onProgress){
    onProgress?.(.05,'ASCENT B · 构建原始三角面碰撞…');this.exactWorld=await loadAscentCollision('/assets/maps/ascent-b.glb');const {buildAscentEnvironment}=await import('./ascent-environment.js');this.environment=buildAscentEnvironment(this.scene,this.exactWorld.geometry,{quality:this.quality||'medium'});await this.environment.ready;this.renderer.shadowMap.needsUpdate=true;onProgress?.(.95,'ASCENT B · 精确几何与重建材质就绪');
  }
  async loadFullMap(onProgress){
    const [{loadAscentFullCollision},{loadAscentFullEnvironment}]=await Promise.all([import('./ascent-full-collision.mjs'),import('./ascent-full-environment.js')]);
    const [world,environment]=await Promise.all([
      loadAscentFullCollision(this.map.collisionUrl),
      loadAscentFullEnvironment(this.scene,this.map,(p,label)=>onProgress?.(p*.92,label)),
    ]);
    this.exactWorld=world;this.environment=environment;
    environment.setQuality(this.quality||'medium');
    this.renderer.shadowMap.needsUpdate=true;
    onProgress?.(1,`${this.map.title} · 就绪`);
  }
  setQuality(level){this.quality=level;this.renderer.setPixelRatio(Math.min(devicePixelRatio,level==='high'?1.65:level==='low'?.8:1.15));this.renderer.shadowMap.enabled=level!=='low';this.renderer.shadowMap.needsUpdate=true;if(this.environment?.setQuality)this.environment.setQuality(level);else if(this.environment?.sun){this.environment.sun.castShadow=level!=='low';this.environment.sun.shadow.needsUpdate=true;}this.renderer.setSize(innerWidth,innerHeight);}
  dispose(){removeEventListener('resize',this.resizeHandler);this.viewRig?.dispose();this.exactWorld?.dispose();this.environment?.dispose();this.scene.traverse(o=>{o.geometry?.dispose();const ms=Array.isArray(o.material)?o.material:[o.material];ms.forEach(m=>{if(m){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose();}});});this.renderer.dispose();}
  mesh(geo,material,x,y,z,rotation=0,parent=this.static){const m=new THREE.Mesh(geo,material);m.position.set(x,y,z);m.rotation.y=rotation;m.castShadow=m.receiveShadow=true;parent.add(m);return m;}
  block(x,y,z,w,h,d,color,rotation=0){const m=this.mesh(box,typeof color==='object'?color:mat(color),x,y,z,rotation);m.scale.set(w,h,d);return m;}
  rounded(x,y,z,w,h,d,color,r=.06,parent=this.static){return this.mesh(new RoundedBoxGeometry(w,h,d,2,r),mat(color),x,y,z,0,parent);}
  buildMap(){
    const floorMat=new THREE.MeshStandardMaterial({map:stoneTexture(),roughness:1,color:'#d2cdbd'});
    this.block(0,-.2,0,88,.4,72,floorMat);
    // Broad paving courses, drains and the central pedestrian route.
    for(let x=-40;x<=40;x+=8){this.block(x,.014,0,.18,.025,66,'#8c928b');}
    for(let z=-32;z<=32;z+=8)this.block(0,.012,z,84,.02,.13,'#9b9e94');
    const textureLoader=new THREE.TextureLoader();
    const plasterMap=textureLoader.load('/assets/textures/plaster-color.jpg');plasterMap.colorSpace=THREE.SRGBColorSpace;plasterMap.wrapS=plasterMap.wrapT=THREE.RepeatWrapping;
    const plasterNormal=textureLoader.load('/assets/textures/plaster-normal.jpg');plasterNormal.wrapS=plasterNormal.wrapT=THREE.RepeatWrapping;
    this.plaster=new THREE.MeshStandardMaterial({map:plasterMap,normalMap:plasterNormal,normalScale:new THREE.Vector2(.12,-.12),roughness:.96,color:'#eed6bd'});
    const groundMap=textureLoader.load('/assets/textures/bricks-color.jpg');groundMap.colorSpace=THREE.SRGBColorSpace;groundMap.wrapS=groundMap.wrapT=THREE.RepeatWrapping;groundMap.repeat.set(32,27);floorMat.map=groundMap;
    const groundNormal=textureLoader.load('/assets/textures/bricks-normal.jpg');groundNormal.wrapS=groundNormal.wrapT=THREE.RepeatWrapping;groundNormal.repeat.set(32,27);floorMat.normalMap=groundNormal;floorMat.normalScale=new THREE.Vector2(.27,-.27);
    for(const b of this.map.boxes){
      const building=b.kind==='building';const color=b.color||'#cbbca6';
      const wallMat=building?this.plaster.clone():mat(color);if(building)wallMat.color.set(color);
      this.block(b.x,b.y,b.z,b.w,b.h,b.d,wallMat);
      if(building){this.buildBuilding(b);}else if(b.kind==='crate'){this.buildCrate(b);}else{
        this.block(b.x,b.y+b.h/2+.05,b.z,b.w+.2,.18,b.d+.2,'#d5d5c4');
        this.block(b.x,.35,b.z,b.w+.08,.7,b.d+.08,'#9b9d8f');
      }
    }
    for(const site of this.map.sites){
      const ring=new THREE.Mesh(new THREE.RingGeometry(site.radius-.11,site.radius,64),new THREE.MeshBasicMaterial({color:'#edcc85',transparent:true,opacity:.52,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.set(site.x,.026,site.z);this.static.add(ring);
      const letter=this.mesh(new THREE.PlaneGeometry(3,3),new THREE.MeshBasicMaterial({map:labelTexture(site.id,'#f3dcb8'),transparent:true,depthWrite:false}),site.x,.03,site.z);letter.rotation.x=-Math.PI/2;
      this.sign(site.id,site.x,3.4,site.z-5.5,2.3,0,'#af5946');
    }
    // Street furniture sits outside walkable lanes or on solid building footprints.
    [[-38,-24],[-38,8],[38,-24],[38,10],[-10,29],[10,-29]].forEach(([x,z])=>this.lamp(x,z));
    [[-39,-30],[39,-30],[-39,29],[39,29],[-30,30],[29,30]].forEach(([x,z],i)=>this.tree(x,z,i));
    this.sign('A ←',-11,2.4,12,2.6,0,'#9b5843');this.sign('→ B',11,2.4,12,2.6,0,'#6a807c');
    for(const x of [-33,33]){this.block(x,.12,28,7,.25,1,'#a8a99a');for(let n=0;n<9;n++)this.block(x-3+n*.75,.36,28,.7,.12,.9,'#bfbfb0');}
  }
  buildBuilding(b){
    const top=b.y+b.h/2;const base=b.y-b.h/2;
    this.block(b.x,base+.43,b.z,b.w+.12,.85,b.d+.12,'#a49c88');
    this.block(b.x,top-.25,b.z,b.w+.25,.24,b.d+.25,'#ede2c9');
    this.block(b.x,top+.12,b.z,b.w+.65,.32,b.d+.65,'#857b66');
    this.block(b.x,top+.4,b.z,b.w+.55,.28,b.d+.55,'#b27759');
    // Individually spaced terracotta roof courses make a continuous tiled roof.
    for(let z=b.z-b.d/2;z<b.z+b.d/2+.2;z+=.55)this.block(b.x,top+.6,z,b.w+.6,.11,.42,'#a5654b');
    const faces=[{axis:'x',front:b.z+b.d/2+.035,len:b.w,origin:b.x,rot:0},{axis:'x',front:b.z-b.d/2-.035,len:b.w,origin:b.x,rot:Math.PI},{axis:'z',front:b.x+b.w/2+.035,len:b.d,origin:b.z,rot:Math.PI/2},{axis:'z',front:b.x-b.w/2-.035,len:b.d,origin:b.z,rot:-Math.PI/2}];
    for(const f of faces){for(let u=-f.len/2+1.6;u<f.len/2-.7;u+=3.2){for(let y=2.6;y<top-1;y+=3){const px=f.axis==='x'?f.origin+u:f.front,pz=f.axis==='x'?f.front:f.origin+u;this.window(px,y,pz,f.rot);}}
      const px=f.axis==='x'?b.x:f.front,pz=f.axis==='x'?f.front:b.z;this.door(px,1.25,pz,f.rot);
    }
    if(b.w>5&&b.d>4){const side=b.z+b.d/2+.12;this.sign(['GELATERIA','VINO • CAFFÈ','ALIMENTARI','PIZZERIA'][Math.abs(Math.round(b.x+b.z))%4],b.x,3.5,side,Math.min(b.w-1,5),0,'#e8d4aa');
      const awning=this.block(b.x,3,side+.62,Math.min(b.w-1,4.8),.14,1.3,'#607e79');awning.rotation.x=.12;
      for(let n=0;n<7;n++)this.block(b.x-2+n*.62,2.92,side+1.24,.31,.35,.08,'#d7d8bf');
    }
    for(let i=0;i<Math.min(3,Math.floor(b.w/3));i++){const x=b.x-b.w/2+.6+i*2.6;this.block(x,top+1,b.z,.75,1.2,.75,'#b1a188');this.block(x,top+1.68,b.z,1,.17,1,'#a97557');}
  }
  window(x,y,z,rot){
    const g=new THREE.Group();g.position.set(x,y,z);g.rotation.y=rot;this.static.add(g);
    const add=(a,b,c,w,h,d,col)=>{const m=new THREE.Mesh(box,mat(col));m.position.set(a,b,c);m.scale.set(w,h,d);m.castShadow=m.receiveShadow=true;g.add(m);};
    add(0,0,0,1.3,1.8,.09,'#4b5e5d');add(0,0,.025,.89,1.5,.08,'#2f4147');
    for(const xx of [-.58,.58]){add(xx,0,.12,.3,1.75,.12,'#617b70');for(let i=0;i<9;i++)add(xx,-.7+i*.17,.2,.27,.045,.05,'#425e54');}
    add(0,-.98,.13,1.55,.16,.4,'#e2d8be');add(0,.94,.07,1.5,.12,.2,'#e2d8be');add(0,0,.1,.06,1.5,.05,'#849384');add(0,0,.1,.9,.06,.05,'#849384');
    if(Math.sin(x*13+z*7)>.4){add(0,-1.02,.37,1.15,.18,.3,'#7d6452');for(let i=0;i<5;i++){this.mesh(new THREE.SphereGeometry(.18,5,4),mat('#56815a'),x+Math.cos(rot)*(-.4+i*.2),y-.98,z+Math.sin(rot)*(-.4+i*.2)+.36);}}
  }
  door(x,y,z,rot){const g=new THREE.Group();g.position.set(x,y,z);g.rotation.y=rot;this.static.add(g);const a=(xx,yy,w,h,col,zz=0)=>{let m=new THREE.Mesh(box,mat(col));m.position.set(xx,yy,zz);m.scale.set(w,h,.11);g.add(m);};a(0,0,1.6,2.5,'#b2a18a');a(0,-.05,1.26,2.3,'#54665a',.06);a(0,-.07,.04,2.3,'#a29b7e',.13);for(const xx of [-.3,.3])for(const yy of [-.6,.45])a(xx,yy,.46,.68,'#657568',.13);a(.15,-.1,.08,.18,'#ccba77',.2);}
  sign(text,x,y,z,width,rot,bg){const m=new THREE.Mesh(new THREE.PlaneGeometry(width,text.length>5?.7:1.6),new THREE.MeshStandardMaterial({map:labelTexture(text,text.length>5?'#554d3d':'#f3e8cc',bg),roughness:1}));m.position.set(x,y,z+.01);m.rotation.y=rot;this.static.add(m);}
  archway(x,z,w,h,rot){
    const group=new THREE.Group();group.position.set(x,0,z);group.rotation.y=rot;this.static.add(group);
    const stone=mat('#dbcfb4');for(const xx of [-w/2,w/2]){let m=new THREE.Mesh(box,stone);m.position.set(xx,h/2,0);m.scale.set(.5,h,1.1);group.add(m);}
    const arc=new THREE.Mesh(new THREE.TorusGeometry(w/2,.3,6,24,Math.PI),stone);arc.position.set(0,h-.8,0);group.add(arc);
    for(let i=0;i<13;i++){const a=i/12*Math.PI;const m=new THREE.Mesh(box,mat(i%2?'#c7bda7':'#e1d8c1'));m.position.set(Math.cos(a)*w/2,h-.8+Math.sin(a)*w/2,.02);m.rotation.z=a;m.scale.set(.7,.55,1.2);group.add(m);}
  }
  buildCrate(b){const col=b.material==='wood'?'#7d7660':'#6d8580';for(const x of [b.x-b.w/2+.08,b.x+b.w/2-.08])this.block(x,b.y,b.z,.14,b.h+.05,b.d+.1,col);for(const y of [b.y-b.h/2+.08,b.y+b.h/2-.08])this.block(b.x,y,b.z,b.w+.1,.14,b.d+.1,col);for(let z=b.z-b.d/2+.2;z<b.z+b.d/2;z+=.6)this.block(b.x,b.y+b.h/2+.03,z,b.w,.04,.035,'#83958b');}
  makeSiteCrate(x,z){const g=new THREE.Group();g.position.set(x,0,z);this.static.add(g);const m=this.rounded(0,1.05,0,2.3,2.1,2.3,'#586e65',.07,g);const glow=new THREE.MeshStandardMaterial({color:'#8fe5bb',emissive:'#3ea97f',emissiveIntensity:.5,roughness:.45});for(const xx of [-1.17,1.17]){const face=new THREE.Mesh(new THREE.PlaneGeometry(1.8,1.65),glow);face.position.set(xx,1.1,0);face.rotation.y=xx>0?Math.PI/2:-Math.PI/2;g.add(face);}const face=new THREE.Mesh(new THREE.PlaneGeometry(1.8,1.65),glow);face.position.set(0,1.1,1.17);g.add(face);for(const xx of [-.83,.83]){const bar=new THREE.Mesh(box,mat('#344f48'));bar.scale.set(.12,2.1,.13);bar.rotation.z=xx>0?.65:-.65;bar.position.set(xx*.4,1.1,1.18);g.add(bar);}}
  lamp(x,z){this.mesh(new THREE.CylinderGeometry(.07,.12,5,8),mat('#445a54',.7,.4),x,2.5,z);this.block(x,5,z,1.1,.12,.9,'#40554f');this.block(x,4.65,z,.55,.65,.55,'#e2d6a7');this.block(x,4.3,z,.75,.13,.75,'#455952');this.mesh(new THREE.ConeGeometry(.65,.45,4),mat('#43584e'),x,5.28,z,Math.PI/4);}
  tree(x,z,i){this.block(x,.15,z,2.5,.3,2.5,'#aaa58e');this.mesh(new THREE.CylinderGeometry(.12,.25,3.8,7),mat('#706749'),x,2.1,z);for(let n=0;n<6;n++){const a=n*2.4;const crown=this.mesh(new THREE.IcosahedronGeometry(1.4,1),mat(['#647c51','#798957','#8a955c'][n%3]),x+Math.sin(a)*.7,4.2+(n%3)*.4,z+Math.cos(a)*.7);crown.scale.set(1,1.1,1);} }
  buildSkyline(){
    for(let i=0;i<25;i++){const a=i/25*Math.PI*2;const r=90+(i%4)*8;const x=Math.cos(a)*r,z=Math.sin(a)*r,h=8+(i*7)%18;this.block(x,h/2-2,z,8+(i%3)*5,h,8,'#a3b5b5');this.block(x,h-1.5,z,10,.7,10,'#899c9f');}
    // Ascent's lifted skyline, suspended land and detached architectural fragments.
    const island=new THREE.Group();island.position.set(-57,23,-68);this.static.add(island);const rock=this.mesh(new THREE.ConeGeometry(12,23,7),mat('#758b8a'),0,-10,0,0,island);rock.rotation.z=Math.PI;this.mesh(new THREE.CylinderGeometry(13,11,2,8),mat('#a9b5a0'),0,1,0,0,island);for(let i=0;i<8;i++){const a=i*2.3;this.mesh(new THREE.IcosahedronGeometry(1.7,0),mat('#657f7d'),Math.sin(a)*15,-6-i%3*4,Math.cos(a)*11,0,island);}const palace=this.mesh(box,mat('#c9c1aa'),0,6,0,0,island);palace.scale.set(8,10,7);const tower=this.mesh(new THREE.CylinderGeometry(2,2.3,12,8),mat('#b8b5a5'),0,13,0,0,island);this.mesh(new THREE.ConeGeometry(3.4,4,4),mat('#9f7966'),0,21,0,Math.PI/4,island);
    const cloudMat=new THREE.MeshBasicMaterial({color:'#f4eddb',transparent:true,opacity:.18,depthWrite:false});for(let i=0;i<24;i++){const m=new THREE.Mesh(new THREE.SphereGeometry(1,8,5),cloudMat);m.scale.set(12+i%4*4,1.5,5);m.position.set(Math.sin(i*4)*110,43+i%4*4,Math.cos(i*3)*100);this.static.add(m);}
  }
  mergeStatic(){
    // Merge only ordinary, opaque static meshes. Skinned characters stay dynamic.
    this.static.updateMatrixWorld(true);const buckets=new Map(),remove=[];
    this.static.traverse(o=>{if(!o.isMesh||Array.isArray(o.material)||o.material.transparent)return;let geo=o.geometry.clone().applyMatrix4(o.matrixWorld);if(geo.index)geo=geo.toNonIndexed();for(const key of Object.keys(geo.attributes))if(!['position','normal','uv'].includes(key))geo.deleteAttribute(key);if(!buckets.has(o.material))buckets.set(o.material,[]);buckets.get(o.material).push(geo);remove.push(o);});
    remove.forEach(o=>o.removeFromParent());for(const [material,geos] of buckets){const merged=mergeGeometries(geos,false);if(merged){const m=new THREE.Mesh(merged,material);m.castShadow=m.receiveShadow=true;this.scene.add(m);}geos.forEach(g=>g.dispose());}
  }
  async loadAssets(onProgress){
    const tasks=[
      ['jett','/assets/agents/jett.glb','捷风'], ['sage','/assets/agents/sage.glb','贤者'],
      ['rifle','/assets/weapons/res-phantom/scene.gltf','第三人称武器'],
      ['viewModel','/assets/animations/fps-ak74m/scene.gltf','第一人称动作'],
    ];
    let done=0;
    const clips=loadLocomotion().then(clips=>{this.locomotionClips=clips;});
    const results=await Promise.allSettled([clips,...tasks.map(async ([key,url,label])=>{
      try{
        const gltf=await loader.loadAsync(url);
        if(key!=='rifle'&&key!=='viewModel')gltf.userData={bounds:new THREE.Box3().setFromObject(gltf.scene)};
        this.assets[key]=gltf;
        onProgress?.(++done/tasks.length,`${label} · 就绪`);
      }catch(error){
        console.error(`Failed to load ${key}`,error);
        onProgress?.(++done/tasks.length,`${label} · 加载失败`);
        throw error;
      }
    })]);
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    this.viewRig=new FPSFirstPersonRig(this.assets.viewModel,this.camera);
  }
  createPlayer(p,selfTeam){
    const root=new THREE.Group();root.position.set(p.x,p.y,p.z);root.rotation.y=Math.PI-p.yaw;this.dynamic.add(root);
    let model,motion;
    const asset=this.assets[p.agent];
    if(asset){
      model=cloneSkeleton(asset.scene);
      const b=asset.userData.bounds,s=b.getSize(new THREE.Vector3()),c=b.getCenter(new THREE.Vector3()),sc=1.82/s.y;
      model.scale.setScalar(sc);model.position.set(-c.x*sc,-b.min.y*sc,-c.z*sc);
      model.traverse(o=>{if(o.isMesh){o.castShadow=o.receiveShadow=true;o.frustumCulled=false;}});
      root.add(model);
      // Sample the authored two-handed pose once. The showcase loops move the
      // hands and weapon relative to the chest even while standing still.
      if(asset.animations.length){
        const poseMixer=new THREE.AnimationMixer(model);
        poseMixer.clipAction(asset.animations[0]).play();poseMixer.update(0);
      }
      motion=new MotionController(model,{clips:this.locomotionClips,root});
    }
    // Missing production assets are never replaced by a box-shaped character.
    const badge=new THREE.Sprite(new THREE.SpriteMaterial({map:labelTexture(p.name.slice(0,14),p.team===selfTeam?'#b8f3d9':'#ff8189'),depthTest:true,transparent:true}));badge.scale.set(1.4,.45,1);badge.position.y=2.15;root.add(badge);
    const shadow=new THREE.Mesh(new THREE.CircleGeometry(.4,24),new THREE.MeshBasicMaterial({color:'#18282c',transparent:true,opacity:.18,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=.015;root.add(shadow);
    const weapon=model&&this.assets.rifle?attachThirdPersonWeapon(model,this.assets.rifle.scene):null;
    const data={root,model,motion,weapon,pose:new RemotePose(),hp:p.hp,shotUntil:0,castUntil:0};this.players.set(p.id,data);return data;
  }
  updatePlayers(players,selfId,selfTeam,dt,serverTime,renderServerTime){
    const now=performance.now();
    const ids=new Set();for(const p of players){if(p.id===selfId)continue;ids.add(p.id);const d=this.players.get(p.id)||this.createPlayer(p,selfTeam);
      const pose=d.pose.update(p,serverTime,renderServerTime,dt);
      const dx=pose.reset?0:pose.x-d.root.position.x,dz=pose.reset?0:pose.z-d.root.position.z;
      d.root.position.set(pose.x,pose.y,pose.z);d.root.rotation.y=Math.PI-pose.yaw;d.root.visible=p.alive;
      // Unwind last frame's support-hand correction before applying actions.
      // Otherwise it can become the base shoulder/elbow pose the next frame.
      d.weapon?.restoreSupportHand();
      if(pose.reset){d.motion?.reset();d.shotUntil=d.castUntil=0;}
      if(p.hp<d.hp)d.motion?.triggerHit();d.hp=p.hp;
      if(!p.alive)continue;
      const distance=Math.hypot(dx,dz),invDt=1/Math.max(dt,.001),speed=Math.min(12,distance*invDt);
      const shooting=now<d.shotUntil,casting=now<d.castUntil;
      const sin=Math.sin(pose.yaw),cos=Math.cos(pose.yaw);
      const aimPitch=THREE.MathUtils.clamp(pose.pitch,-.8,.8);
      d.motion?.update(dt,{speed,distance,forward:(dx*sin-dz*cos)*invDt,strafe:(dx*cos+dz*sin)*invDt,grounded:pose.grounded,crouch:pose.crouch,shooting,casting,aimPitch,time:now/1000});
      const supportWeight=1-THREE.MathUtils.smoothstep(d.motion?.castWeight??0,.10,.95);
      d.weapon?.update({pitch:aimPitch,supportWeight,visible:true});
    }
    for(const [id,p]of this.players)if(!ids.has(id)){p.weapon?.dispose();p.motion?.dispose();p.root.removeFromParent();this.players.delete(id);}
  }
  playerAction(id,action){const p=this.players.get(id);if(!p)return;if(action==='shot'){p.shotUntil=performance.now()+100;p.motion?.triggerShot();}if(action==='ability')p.castUntil=performance.now()+700;}
  updateSmokes(list,dt){const ids=new Set();for(const s of list){ids.add(s.id);let m=this.smokes.get(s.id);if(!m){const group=new THREE.Group();const core=new THREE.Mesh(new THREE.SphereGeometry(s.radius,24,16),new THREE.MeshStandardMaterial({color:'#bdcfdb',transparent:true,opacity:.96,roughness:1,side:THREE.DoubleSide}));group.add(core);const halo=new THREE.Mesh(new THREE.SphereGeometry(s.radius*1.015,24,16),new THREE.MeshBasicMaterial({color:'#cbe7e9',wireframe:true,transparent:true,opacity:.07}));group.add(halo);this.scene.add(group);m=group;this.smokes.set(s.id,m);}m.position.set(s.x,s.y,s.z);m.rotation.y+=dt*.1;}for(const[id,m]of this.smokes)if(!ids.has(id)){m.removeFromParent();m.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});this.smokes.delete(id);}}
  updateAbilities(barriers,slows,dt){
    const barrierIds=new Set();for(const b of barriers){barrierIds.add(b.id);let g=this.barriers.get(b.id);if(!g){g=new THREE.Group();const ice=new THREE.MeshPhysicalMaterial({color:'#65dbce',emissive:'#246c70',emissiveIntensity:.25,roughness:.26,metalness:.08,transparent:true,opacity:.91,clearcoat:.7});const core=new THREE.Mesh(new RoundedBoxGeometry(b.w,b.h,b.d,2,.12),ice);core.castShadow=core.receiveShadow=true;g.add(core);const edge=new THREE.LineSegments(new THREE.EdgesGeometry(core.geometry,25),new THREE.LineBasicMaterial({color:'#bbfff2',transparent:true,opacity:.45}));g.add(edge);for(let n=0;n<6;n++){const shard=new THREE.Mesh(new THREE.OctahedronGeometry(.15+n%3*.05,0),new THREE.MeshStandardMaterial({color:'#a4f4df',emissive:'#54cbb6',emissiveIntensity:.2,roughness:.35}));shard.position.set(Math.sin(n*5)*b.w*.3,b.h*.5-.04,Math.cos(n*5)*b.d*.25);shard.scale.y=1.4;g.add(shard);}this.scene.add(g);this.barriers.set(b.id,g);}g.position.set(b.x,b.y,b.z);g.children[0].material.opacity=.55+.36*Math.max(0,b.hp)/400;}
    for(const[id,g]of this.barriers)if(!barrierIds.has(id)){g.removeFromParent();g.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});this.barriers.delete(id);}
    const slowIds=new Set();for(const s of slows){slowIds.add(s.id);let g=this.slows.get(s.id);if(!g){g=new THREE.Group();const floor=new THREE.Mesh(new THREE.CircleGeometry(s.radius,48),new THREE.MeshStandardMaterial({color:'#7bd8ca',emissive:'#369d9f',emissiveIntensity:.3,transparent:true,opacity:.56,roughness:.3,depthWrite:false}));floor.rotation.x=-Math.PI/2;g.add(floor);for(let i=0;i<44;i++){const a=i*2.399,r=Math.sqrt(i/44)*s.radius*.96;const piece=new THREE.Mesh(new THREE.OctahedronGeometry(.12+(i%3)*.05,0),mat('#9be2d5',.3,.2));piece.scale.set(1.5,.3,1);piece.position.set(Math.cos(a)*r,.04,Math.sin(a)*r);piece.rotation.y=a;g.add(piece);}this.scene.add(g);this.slows.set(s.id,g);}g.position.set(s.x,(s.y??0)+.035,s.z);g.children[0].material.opacity=.48+Math.sin(performance.now()*.002)*.06;}
    for(const[id,g]of this.slows)if(!slowIds.has(id)){g.removeFromParent();g.traverse(o=>{o.geometry?.dispose();if(![...materials.values()].includes(o.material))o.material?.dispose();});this.slows.delete(id);}
  }
  shot(from,to,color='#ffdaa3'){const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from),new THREE.Vector3(...to)]);const line=new THREE.Line(g,new THREE.LineBasicMaterial({color,transparent:true,opacity:.8}));this.scene.add(line);this.effects.push({mesh:line,life:.09,max:.09});}
  fire(){this.viewRig?.fire();}
  update(dt,player,yaw,pitch,moving,reloadRemaining,walk=false){
    this.camera.position.set(player.x,player.y+(player.crouch?1.05:1.62),player.z);
    this.camera.rotation.set(pitch,-yaw,0);
    if(this.environment?.updateLight?.(this.camera.position))this.renderer.shadowMap.needsUpdate=true;
    this.viewRig?.update(dt,{moving,walk,reloadRemaining,alive:player.alive});
    for(let i=this.effects.length-1;i>=0;i--){const e=this.effects[i];e.life-=dt;e.mesh.material.opacity=Math.max(0,e.life/e.max);if(e.life<=0){e.mesh.removeFromParent();e.mesh.geometry.dispose();e.mesh.material.dispose();this.effects.splice(i,1);}}
    this.renderer.render(this.scene,this.camera);
  }
  stats(){return{calls:this.renderer.info.render.calls,triangles:this.renderer.info.render.triangles,models:Object.keys(this.assets),firstPerson:this.viewRig?.diagnostics()||null,environment:this.environment?{triangles:this.environment.statistics.triangles,texturesReady:this.environment.statistics.texturesReady,textureErrors:this.environment.statistics.textureErrors}:null};}
}
