// UTF-8. Read-only rig/skin analysis for wrist twist; does not modify production code.
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ViewArms} from '../src/view-arms.js';
import {createFirstPersonPhantom} from '../src/weapon-model.js';
globalThis.ProgressEvent ||= class{constructor(type,data){Object.assign(this,{type,...data});}};
async function loadRig(name){
 const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url)),n=bytes.readUInt32LE(12),j=JSON.parse(bytes.toString('utf8',20,20+n));
 delete j.images;delete j.textures;j.materials?.forEach(m=>{delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;});
 j.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(28+n,28+n+bytes.readUInt32LE(20+n)).toString('base64');return new GLTFLoader().parseAsync(JSON.stringify(j),'');
}
const j=JSON.parse(fs.readFileSync(new URL('../assets/weapons/res-phantom/scene.gltf',import.meta.url),'utf8'));
for(const b of j.buffers)b.uri='data:application/octet-stream;base64,'+fs.readFileSync(new URL('../assets/weapons/res-phantom/'+b.uri,import.meta.url)).toString('base64');
const phantom=await new GLTFLoader().parseAsync(JSON.stringify(j),'');
const round=v=>Array.isArray(v)?v.map(round):typeof v==='number'?+v.toFixed(6):v;
for(const name of ['jett','sage']){
 const asset=await loadRig(name),camera=new THREE.PerspectiveCamera(),arms=new ViewArms(asset,camera),weapon=createFirstPersonPhantom(phantom.scene),gunRoot=new THREE.Group();
 camera.add(gunRoot);gunRoot.add(weapon.group);gunRoot.position.set(.24,-.23,-.4);camera.updateMatrixWorld(true);
 const info={agent:name,bones:[],skin:{},tracks:[],bound:{},variants:{},sleeveMix:{}};
 const interesting=[];arms.model.traverse(b=>{if(b.isBone&&/^[LR]_(Elbow|Hand|Shoulder|Sleeve)/.test(b.name)){interesting.push(b);info.bones.push({name:b.name,parent:b.parent?.name,position:round(b.position.toArray()),quaternion:round(b.quaternion.toArray()),world:round(b.getWorldPosition(new THREE.Vector3()).toArray())});}});
 for(const track of asset.animations[0]?.tracks||[])if(/(?:Elbow|Hand|Shoulder|Sleeve)/.test(track.name))info.tracks.push(track.name);
 arms.model.traverse(m=>{if(!m.isSkinnedMesh||!m.visible)return;const si=m.geometry.attributes.skinIndex,sw=m.geometry.attributes.skinWeight,used=new Set(m.geometry.index.array);for(const b of interesting){const bi=m.skeleton.bones.indexOf(b);if(bi<0)continue;let sum=0,count=0,max=0;const range=new THREE.Box3();for(const i of used){let w=0;for(let c=0;c<4;c++)if(si.array[i*4+c]===bi)w+=sw.array[i*4+c];if(w>0){sum+=w;count++;max=Math.max(max,w);range.expandByPoint(m.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(m.matrixWorld));}}if(count)info.skin[b.name]={sum:+sum.toFixed(2),count,max,bounds:round([range.min.toArray(),range.max.toArray()])};}});
 arms.bindWeapon(weapon.anchors);arms.update(1/60);
 arms.model.traverse(m=>{if(!m.isSkinnedMesh||!m.visible)return;const si=m.geometry.attributes.skinIndex,sw=m.geometry.attributes.skinWeight,groups={},matrix=new THREE.Matrix4(),blend=new THREE.Matrix4(),linear=new THREE.Matrix3();for(const side of ['L','R']){
  const sleeveIds=new Set(m.skeleton.bones.map((b,i)=>new RegExp('^'+side+'_Sleeve[123]_\\d+$').test(b.name)?i:-1).filter(i=>i>=0));
  for(const index of new Set(m.geometry.index.array)){let sleeve=0;const peers=[];for(let c=0;c<4;c++){const bi=si.array[index*4+c],w=sw.array[index*4+c];if(sleeveIds.has(bi))sleeve+=w;else if(w>.01)peers.push(m.skeleton.bones[bi].name);}if(sleeve<.10)continue;const key=side+':'+(peers.length?peers.join('+'):'sleeve only');if(!groups[key])groups[key]={count:0,det:[],sleeveSum:0};let normalization=0;blend.elements.fill(0);for(let c=0;c<4;c++){const w=sw.array[index*4+c];if(!w)continue;const bi=si.array[index*4+c];matrix.multiplyMatrices(m.skeleton.bones[bi].matrixWorld,m.skeleton.boneInverses[bi]);normalization+=Math.cbrt(Math.abs(linear.setFromMatrix4(matrix).determinant()))*w;for(let e=0;e<16;e++)blend.elements[e]+=matrix.elements[e]*w;}const value=linear.setFromMatrix4(blend).determinant()/normalization**3;groups[key].count++;groups[key].sleeveSum+=sleeve;groups[key].det.push(value);}
  }
  for(const[k,v]of Object.entries(groups)){v.det.sort((a,b)=>a-b);info.sleeveMix[k]={count:v.count,min:v.det[0],median:v.det[Math.floor(v.det.length*.5)],sleeveMean:v.sleeveSum/v.count};}
 });
 for(const side of ['L','R']){
  const elbow=arms.bones[side+'_Elbow'],hand=arms.bones[side+'_Hand'];
  info.bound[side]={elbow:round(elbow.quaternion.toArray()),hand:round(hand.quaternion.toArray()),elbowWorld:round(elbow.getWorldQuaternion(new THREE.Quaternion()).toArray()),handWorld:round(hand.getWorldQuaternion(new THREE.Quaternion()).toArray()),handEuler:round(new THREE.Euler().setFromQuaternion(hand.quaternion).toArray().slice(0,3)),twistState:arms.wristTwistAngles?.[side]};
 }
 const helper=[];arms.model.traverse(b=>{if(b.isBone&&/^[LR]_Elbow_Twst[23]_\d+$/.test(b.name))helper.push({bone:b,base:b.quaternion.clone()});});
 const originalTransfer=arms.transferWristTwist;
 function wristSkinMetric(side){
   const hand=arms.bones[side+'_Hand'],elbow=arms.bones[side+'_Elbow'],axis=hand.getWorldPosition(new THREE.Vector3()).sub(elbow.getWorldPosition(new THREE.Vector3())).normalize();
   const origin=hand.getWorldPosition(new THREE.Vector3()),radial=new THREE.Vector3(),u=new THREE.Vector3().crossVectors(axis,new THREE.Vector3(0,1,0)).normalize(),v=new THREE.Vector3().crossVectors(axis,u).normalize();
   const points=[];
   arms.model.traverse(m=>{if(!m.isSkinnedMesh||!m.visible)return;const si=m.geometry.attributes.skinIndex,sw=m.geometry.attributes.skinWeight,hi=m.skeleton.bones.indexOf(hand),ti=m.skeleton.bones.findIndex(b=>new RegExp('^'+side+'_Elbow_Twst3_\\d+$').test(b.name));for(const i of new Set(m.geometry.index.array)){let wh=0,wt=0;for(let c=0;c<4;c++){if(si.array[i*4+c]===hi)wh+=sw.array[i*4+c];if(si.array[i*4+c]===ti)wt+=sw.array[i*4+c];}if(wh>.15&&wt>.15){const p=m.localToWorld(m.getVertexPosition(i,new THREE.Vector3()));radial.copy(p).sub(origin);points.push([radial.dot(axis),radial.dot(u),radial.dot(v)]);}}});
   const radii=points.map(p=>Math.hypot(p[1],p[2])).sort((a,b)=>a-b),mean=points.reduce((r,p)=>r.map((n,i)=>n+p[i]),[0,0,0]).map(n=>n/points.length);
   let uu=0,vv=0,uv=0;for(const p of points){const du=p[1]-mean[1],dv=p[2]-mean[2];uu+=du*du;vv+=dv*dv;uv+=du*dv;}const root=Math.sqrt((uu-vv)**2+4*uv*uv),minor=Math.sqrt(Math.max(0,(uu+vv-root)/2/points.length)),major=Math.sqrt((uu+vv+root)/2/points.length);
   return {count:points.length,radiusP10:radii[Math.floor(radii.length*.1)],radiusP50:radii[Math.floor(radii.length*.5)],rmsMinor:minor,rmsMajor:major,areaProxy:minor*major,handLocalQ:hand.quaternion.toArray(),points};
 }
 for(const variant of ['current','none','helpers']){
   for(const h of helper)h.bone.quaternion.copy(h.base);
   arms.transferWristTwist=variant==='current'?originalTransfer:variant==='none'?()=>{}:function(side,elbow,hand,desired){
     const current=hand.getWorldQuaternion(new THREE.Quaternion()),axis=hand.getWorldPosition(new THREE.Vector3()).sub(elbow.getWorldPosition(new THREE.Vector3())).normalize(),delta=desired.clone().multiply(current.invert()).normalize();if(delta.w<0)delta.set(-delta.x,-delta.y,-delta.z,-delta.w);
     const projected=delta.x*axis.x+delta.y*axis.y+delta.z*axis.z,angle=2*Math.atan2(projected,delta.w),localAxis=hand.position.clone().normalize();
     for(const h of helper){if(!h.bone.name.startsWith(side+'_'))continue;const t=Math.abs(h.bone.position.x/hand.position.x);h.bone.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(localAxis,angle*t).multiply(h.base));}
   };
   arms.wristTwistAngles={L:null,R:null};arms.update(1/60);arms.model.updateMatrixWorld(true);
   info.variants[variant]=Object.fromEntries(['L','R'].map(s=>[s,wristSkinMetric(s)]));
 }
 console.log(JSON.stringify(info,null,2));arms.dispose();weapon.dispose();
}
