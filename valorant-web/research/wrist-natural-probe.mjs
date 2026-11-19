// UTF-8. Coordinate-independent wrist bend measurements on the source rigs.
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ViewArms} from '../src/view-arms.js';
import {createFirstPersonPhantom} from '../src/weapon-model.js';
globalThis.ProgressEvent ||= class{constructor(type,data){Object.assign(this,{type,...data});}};
async function loadRig(name){const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url)),n=bytes.readUInt32LE(12),j=JSON.parse(bytes.toString('utf8',20,20+n));delete j.images;delete j.textures;j.materials?.forEach(m=>{delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;});j.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(28+n,28+n+bytes.readUInt32LE(20+n)).toString('base64');return new GLTFLoader().parseAsync(JSON.stringify(j),'');}
const j=JSON.parse(fs.readFileSync(new URL('../assets/weapons/res-phantom/scene.gltf',import.meta.url),'utf8'));for(const b of j.buffers)b.uri='data:application/octet-stream;base64,'+fs.readFileSync(new URL('../assets/weapons/res-phantom/'+b.uri,import.meta.url)).toString('base64');const phantom=await new GLTFLoader().parseAsync(JSON.stringify(j),'');
const find=(root,key)=>{let r;root.traverse(b=>{if(b.isBone&&new RegExp('^'+key+'_\\d+$').test(b.name))r=b;});return r;};
const deg=r=>r*180/Math.PI;
const qmat=m=>new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m)).normalize();
function swingTwist(q,axis){const p=q.x*axis.x+q.y*axis.y+q.z*axis.z,t=new THREE.Quaternion(axis.x*p,axis.y*p,axis.z*p,q.w).normalize(),s=q.clone().multiply(t.clone().invert()).normalize();return{swing:deg(s.angleTo(new THREE.Quaternion())),twist:deg(t.angleTo(new THREE.Quaternion()))};}
const results=[];
for(const name of ['jett','sage']){
 const asset=await loadRig(name),camera=new THREE.PerspectiveCamera(),arms=new ViewArms(asset,camera),weapon=createFirstPersonPhantom(phantom.scene),gunRoot=new THREE.Group();camera.add(gunRoot);gunRoot.add(weapon.group);gunRoot.position.set(.24,-.23,-.4);camera.updateMatrixWorld(true);arms.bindWeapon(weapon.anchors);
 let mesh;arms.model.traverse(m=>{if(m.isSkinnedMesh&&m.visible)mesh=m;});const sk=mesh.skeleton;
 const result={agent:name,sides:{}};
 for(const side of ['L','R']){
  const h=arms.bones[side+'_Hand'],e=arms.bones[side+'_Elbow'],s=arms.bones[side+'_Shoulder'],m=find(arms.model,side+'_Middle1'),ix=find(arms.model,side+'_Index1'),pk=find(arms.model,side+'_Pinky1'),hb=sk.boneInverses[sk.bones.indexOf(h)].clone().invert(),eb=sk.boneInverses[sk.bones.indexOf(e)].clone().invert(),mb=sk.boneInverses[sk.bones.indexOf(m)].clone().invert(),hbind=qmat(eb.clone().invert().multiply(hb)),axis=h.position.clone().normalize();
  const B=new THREE.Vector3().setFromMatrixPosition(eb),C=new THREE.Vector3().setFromMatrixPosition(hb),D=new THREE.Vector3().setFromMatrixPosition(mb),physical=()=>deg(h.getWorldPosition(new THREE.Vector3()).sub(e.getWorldPosition(new THREE.Vector3())).angleTo(m.getWorldPosition(new THREE.Vector3()).sub(h.getWorldPosition(new THREE.Vector3()))));
  const endpoint=weapon.anchors[side].getWorldPosition(new THREE.Vector3()),socket=h.getWorldPosition(new THREE.Vector3()).sub(arms.bones[side+'_WeaponPoint'].getWorldPosition(new THREE.Vector3())),desired=endpoint.clone().add(socket),a=s.getWorldPosition(new THREE.Vector3()),u=arms.referenceLengths[side].upper,l=arms.referenceLengths[side].lower,d=a.distanceTo(desired),bend=deg(Math.acos(THREE.MathUtils.clamp((u*u+l*l-d*d)/(2*u*l),-1,1)));
  result.sides[side]={bindHandQ:hbind.toArray(),bindElbowToHand:C.clone().applyMatrix4(eb.clone().invert()).toArray(),bindHandToMiddle:D.clone().applyMatrix4(hb.clone().invert()).toArray(),currentElbowToHand:h.position.toArray(),bindScales:{elbow:new THREE.Vector3().setFromMatrixScale(eb).toArray(),hand:new THREE.Vector3().setFromMatrixScale(hb).toArray(),middle:new THREE.Vector3().setFromMatrixScale(mb).toArray()},restHandQ:arms.restRotations.get(h).toArray(),handAxis:axis.toArray(),baselineVsBind:swingTwist(h.quaternion.clone().multiply(hbind.clone().invert()),axis),baselineVsIdle:swingTwist(h.quaternion.clone().multiply(arms.restRotations.get(h).clone().invert()),axis),idleVsBind:swingTwist(arms.restRotations.get(h).clone().multiply(hbind.clone().invert()),axis),physicalBaseline:physical(),physicalBind:deg(C.clone().sub(B).angleTo(D.clone().sub(C))),reach:{distance:d,upper:u,lower:l,extensionMargin:u+l-d,foldMargin:d-Math.abs(u-l),internalElbowDegrees:bend},handToMiddleLocal:m.position.toArray(),localPalmPoints:{middle:h.worldToLocal(m.getWorldPosition(new THREE.Vector3())).toArray(),index:h.worldToLocal(ix.getWorldPosition(new THREE.Vector3())).toArray(),pinky:h.worldToLocal(pk.getWorldPosition(new THREE.Vector3())).toArray()}};
 }
 results.push(result);arms.dispose();weapon.dispose();
}
fs.writeFileSync(new URL('./wrist-natural-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n','utf8');console.log(JSON.stringify(results,null,2));
