// UTF-8. Actual rig, palm sockets and skin under the scene's weapon placement.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ViewArms} from '../src/view-arms.js';
import {createFirstPersonPhantom} from '../src/weapon-model.js';
import {applyViewWeaponPose, VIEW_WEAPON_POSE} from '../src/view-weapon-pose.js';

globalThis.ProgressEvent ||= class { constructor(type,data){Object.assign(this,{type,...data});} };
async function loadRig(name) {
  const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url));
  const size=bytes.readUInt32LE(12),data=JSON.parse(bytes.toString('utf8',20,20+size));
  delete data.images;delete data.textures;
  data.materials?.forEach(m=>{
    delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;
    delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;
  });
  data.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(28+size,28+size+bytes.readUInt32LE(20+size)).toString('base64');
  return new GLTFLoader().parseAsync(JSON.stringify(data),'');
}
const weaponData=JSON.parse(fs.readFileSync(new URL('../assets/weapons/res-phantom/scene.gltf',import.meta.url),'utf8'));
for(const b of weaponData.buffers)b.uri='data:application/octet-stream;base64,'+fs.readFileSync(new URL('../assets/weapons/res-phantom/'+b.uri,import.meta.url)).toString('base64');
const phantom=await new GLTFLoader().parseAsync(JSON.stringify(weaponData),'');
const sides=['L','R'],degrees=r=>r*180/Math.PI;
function find(root,key){let result;root.traverse(b=>{if(b.isBone&&new RegExp('^'+key+'_\\d+$').test(b.name))result=b;});return result;}
function summary(values){const a=values.slice().sort((x,y)=>x-y);return{count:a.length,min:a[0],p05:a[Math.floor(a.length*.05)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};}
function bendDegrees(arms,side) {
  const hand=arms.bones[side+'_Hand'],wrist=hand.getWorldPosition(new THREE.Vector3());
  const forearm=wrist.clone().sub(arms.bones[side+'_Elbow'].getWorldPosition(new THREE.Vector3()));
  const palm=find(arms.model,side+'_Middle1').getWorldPosition(new THREE.Vector3()).sub(wrist);
  // These real bone rays measure bending separately from axial forearm roll.
  return degrees(forearm.angleTo(palm));
}
function samples(arms,side) {
  const wrist=[],edges=[];
  arms.model.traverse(mesh=>{
    if(!mesh.isSkinnedMesh||!mesh.visible)return;
    const si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight,sk=mesh.skeleton;
    const indices=mesh.geometry.index.array,nearElbow=new Set(),seen=new Set();
    for(const index of new Set(indices)) {
      let hand=0,distal=0,proximal=0,needle=0;
      for(let c=0;c<4;c++) {
        const bone=sk.bones[si.array[index*4+c]],w=sw.array[index*4+c];
        if(bone===arms.bones[side+'_Hand'])hand+=w;
        if(new RegExp('^'+side+'_Elbow_Twst3_').test(bone.name))distal+=w;
        if(new RegExp('^'+side+'_Elbow_Twst2_').test(bone.name))proximal+=w;
        if(new RegExp('^'+side+'_Elbow_Ndl_').test(bone.name))needle+=w;
      }
      if(hand>.15&&distal>.15)wrist.push({mesh,index});
      if(needle>.01&&proximal>.01)nearElbow.add(index);
    }
    for(let i=0;i<indices.length;i+=3)for(let c=0;c<3;c++) {
      const a=indices[i+c],b=indices[i+(c+1)%3];
      if(!nearElbow.has(a)||!nearElbow.has(b))continue;
      const key=Math.min(a,b)+':'+Math.max(a,b);
      if(seen.has(key))continue;seen.add(key);
      const p=mesh.geometry.attributes.position;
      if(new THREE.Vector3().fromBufferAttribute(p,a).distanceTo(new THREE.Vector3().fromBufferAttribute(p,b))>1e-5)edges.push({mesh,a,b});
    }
  });
  assert.ok(wrist.length>50&&edges.length>100,`${side}: source wrist/elbow samples must be present`);
  return{wrist,edges};
}
function wristDeterminants(vertices) {
  const out=[],boneMatrix=new THREE.Matrix4(),blend=new THREE.Matrix4(),linear=new THREE.Matrix3();
  for(const{mesh,index}of vertices) {
    const si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight,sk=mesh.skeleton;
    blend.elements.fill(0);let scale=0;
    for(let c=0;c<4;c++) {
      const w=sw.array[index*4+c];if(!w)continue;
      const bi=si.array[index*4+c];boneMatrix.multiplyMatrices(sk.bones[bi].matrixWorld,sk.boneInverses[bi]);
      scale+=Math.cbrt(Math.abs(linear.setFromMatrix4(boneMatrix).determinant()))*w;
      for(let e=0;e<16;e++)blend.elements[e]+=boneMatrix.elements[e]*w;
    }
    const determinant=linear.setFromMatrix4(blend).determinant()/scale**3;
    assert.ok(Number.isFinite(determinant),'finite weighted wrist deformation');out.push(determinant);
  }
  return out;
}
function elbowLengths(edges) {
  const cache=new Map();
  return edges.map(({mesh,a,b})=>{
    if(!cache.has(mesh))cache.set(mesh,new Map());const points=cache.get(mesh);
    const point=i=>{if(!points.has(i))points.set(i,mesh.localToWorld(mesh.getVertexPosition(i,new THREE.Vector3())));return points.get(i);};
    return point(a).distanceTo(point(b));
  });
}
// Recorded by elbow-skin.test's old full-swing control on the same real edges,
// old (.24,-.23,-.4) placement, 240-frame bob/recoil/roll stress sequence.
const historicalElbowMax={jett:{L:.07844927843180531,R:.08392328846519635},sage:{L:.08460772035851945,R:.09052709173762742}};
const results=[];
for(const name of ['jett','sage']) {
  const asset=await loadRig(name),camera=new THREE.PerspectiveCamera(76,16/9,.06,280),arms=new ViewArms(asset,camera);
  const weapon=createFirstPersonPhantom(phantom.scene),root=new THREE.Group();camera.add(root);root.add(weapon.group);
  root.position.set(.24,-.23,-.4);camera.updateMatrixWorld(true);arms.bindWeapon(weapon.anchors);
  const baseline=Object.fromEntries(sides.map(side=>[side,bendDegrees(arms,side)]));
  applyViewWeaponPose(root);camera.updateMatrixWorld(true);arms.update(0);
  const staticBend=Object.fromEntries(sides.map(side=>[side,bendDegrees(arms,side)]));const staticOrientation=Object.fromEntries(sides.map(side=>[side,arms.bones[side+'_Hand'].getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(weapon.anchors[side].getWorldQuaternion(new THREE.Quaternion()).normalize())]));
  const staticProjection=Object.fromEntries(sides.map(side=>[side,Object.fromEntries(['Hand','Middle1'].map(joint=>[
    joint,find(arms.model,side+'_'+joint).getWorldPosition(new THREE.Vector3()).project(camera).toArray()
  ]))]));
  const selected=Object.fromEntries(sides.map(side=>[side,samples(arms,side)]));
  const measurements=Object.fromEntries(sides.map(side=>[side,{bend:[],wrist:[],edges:[],socket:0,orientation:0,boneLength:0}]));
  for(let frame=0;frame<240;frame++) {
    const time=frame/60,recoil=frame%60<6?.07:0;
    camera.position.set(Math.sin(time)*10,2+time,-30);camera.rotation.set(Math.sin(time)*.5,time,0,'YXZ');
    applyViewWeaponPose(root,{bob:frame*.15,moving:frame%80<60,recoil,reloadRoll:Math.sin(time*5)*.4});
    camera.updateMatrixWorld(true);arms.update(1/60);arms.model.updateMatrixWorld(true);
    for(const side of sides) {
      const m=measurements[side],shoulder=arms.bones[side+'_Shoulder'],elbow=arms.bones[side+'_Elbow'],hand=arms.bones[side+'_Hand'];
      m.bend.push(bendDegrees(arms,side));m.wrist.push(...wristDeterminants(selected[side].wrist));m.edges.push(...elbowLengths(selected[side].edges));
      const socket=arms.bones[side+'_WeaponPoint'],anchor=weapon.anchors[side];
      const socketError=socket.getWorldPosition(new THREE.Vector3()).distanceTo(anchor.getWorldPosition(new THREE.Vector3()));if(socketError>m.socket){m.socket=socketError;m.socketFrame=frame;}
      const orientation=hand.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(anchor.getWorldQuaternion(new THREE.Quaternion()).normalize());m.orientation=Math.max(m.orientation,orientation);
      const a=shoulder.getWorldPosition(new THREE.Vector3()),b=elbow.getWorldPosition(new THREE.Vector3()),c=hand.getWorldPosition(new THREE.Vector3());
      m.boneLength=Math.max(m.boneLength,Math.abs(a.distanceTo(b)-arms.referenceLengths[side].upper),Math.abs(b.distanceTo(c)-arms.referenceLengths[side].lower));
    }
  }
  const result={agent:name,baseline,staticBend,staticOrientation,staticProjection,dynamic:Object.fromEntries(sides.map(side=>{
    const m=measurements[side];return[side,{bend:summary(m.bend),wrist:summary(m.wrist),elbowEdges:summary(m.edges),maxSocketError:m.socket,maxSocketErrorFrame:m.socketFrame,maxOrientationError:m.orientation,maxBoneLengthError:m.boneLength}];
  }))};results.push(result);arms.dispose();weapon.dispose();root.removeFromParent();
}
fs.writeFileSync(new URL('./weapon-pose-results.json',import.meta.url),JSON.stringify({pose:VIEW_WEAPON_POSE,results},null,2)+'\n','utf8');
console.log(JSON.stringify({pose:VIEW_WEAPON_POSE,results},null,2));
for(const r of results)for(const side of sides) {
  const m=r.dynamic[side],label=`${r.agent} ${side}`;
  assert.ok(r.staticBend[side]<r.baseline[side]-10,`${label}: static pose must reduce anatomical wrist bend by at least 10 degrees`);
  for(const[joint,[x,y,z]]of Object.entries(r.staticProjection[side])) {
    assert.ok(Math.abs(x)<.98&&y>-.95&&y<.1&&z>=-1&&z<=1,`${label} ${joint}: moving the weapon must keep the wrist and palm inside the game camera view`);
  }
  assert.ok(m.maxSocketError<.001,`${label}: real palm detaches from its weapon anchor`);
  assert.ok(m.maxOrientationError<.00001,`${label}: real palm loses weapon orientation`);
  assert.ok(m.maxBoneLengthError<.00001,`${label}: rig bones stretch`);
  assert.ok(m.wrist.min>.65&&m.wrist.p05>.70,`${label}: moving the weapon regresses the actual wrist seam`);
  assert.ok(m.elbowEdges.max<historicalElbowMax[r.agent][side]+.000001,`${label}: moving the weapon exceeds the old elbow skin spikes`);
}
console.log('Weapon placement passed anatomical wrist, real grip, wrist skin and elbow skin checks.');
