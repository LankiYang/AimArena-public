// UTF-8. Read-only analysis of actual elbow skin helpers and skin matrices.
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ViewArms} from '../src/view-arms.js';
import {createFirstPersonPhantom} from '../src/weapon-model.js';
globalThis.ProgressEvent ||= class{constructor(type,data){Object.assign(this,{type,...data});}};
async function loadRig(name){const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url)),n=bytes.readUInt32LE(12),j=JSON.parse(bytes.toString('utf8',20,20+n));delete j.images;delete j.textures;j.materials?.forEach(m=>{delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;});j.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(28+n,28+n+bytes.readUInt32LE(20+n)).toString('base64');return new GLTFLoader().parseAsync(JSON.stringify(j),'');}
const j=JSON.parse(fs.readFileSync(new URL('../assets/weapons/res-phantom/scene.gltf',import.meta.url),'utf8'));for(const b of j.buffers)b.uri='data:application/octet-stream;base64,'+fs.readFileSync(new URL('../assets/weapons/res-phantom/'+b.uri,import.meta.url)).toString('base64');const phantom=await new GLTFLoader().parseAsync(JSON.stringify(j),'');
const find=(root,key)=>{let r;root.traverse(b=>{if(b.isBone&&new RegExp('^'+key+'_\\d+$').test(b.name))r=b;});return r;};
const stats=values=>{const sorted=values.slice().sort((a,b)=>a-b);return{count:values.length,min:sorted[0],p05:sorted[Math.floor(sorted.length*.05)],median:sorted[Math.floor(sorted.length*.5)]};};
function elbowMetrics(arms,side){const groups={},bm=new THREE.Matrix4(),blend=new THREE.Matrix4(),lin=new THREE.Matrix3();arms.model.traverse(mesh=>{if(!mesh.isSkinnedMesh||!mesh.visible)return;const si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight,sk=mesh.skeleton,elbow=arms.bones[side+'_Elbow'],ep=elbow.getWorldPosition(new THREE.Vector3());for(const index of new Set(mesh.geometry.index.array)){const weights=[];let hasNeedle=false,hasUpper=false;for(let c=0;c<4;c++){const w=sw.array[index*4+c],bone=sk.bones[si.array[index*4+c]];if(w>.01){weights.push([bone.name,w]);if(bone.name.startsWith(side+'_Elbow_Ndl_'))hasNeedle=true;if(bone.name.startsWith(side+'_Shoulder_Twst3_'))hasUpper=true;}}if(!hasNeedle&&!hasUpper)continue;const key=hasNeedle&&hasUpper?'needle+upper':hasNeedle?'needle':'upper';if(!groups[key])groups[key]={det:[],dist:[],weightKeys:{}};blend.elements.fill(0);let normal=0;for(let c=0;c<4;c++){const w=sw.array[index*4+c];if(!w)continue;const bi=si.array[index*4+c];bm.multiplyMatrices(sk.bones[bi].matrixWorld,sk.boneInverses[bi]);normal+=Math.cbrt(Math.abs(lin.setFromMatrix4(bm).determinant()))*w;for(let e=0;e<16;e++)blend.elements[e]+=bm.elements[e]*w;}const det=lin.setFromMatrix4(blend).determinant()/normal**3;groups[key].det.push(det);const world=mesh.localToWorld(mesh.getVertexPosition(index,new THREE.Vector3()));groups[key].dist.push(world.distanceTo(ep));const wk=weights.map(x=>x[0]).sort().join('+');groups[key].weightKeys[wk]=(groups[key].weightKeys[wk]||0)+1;}});return Object.fromEntries(Object.entries(groups).map(([key,g])=>[key,{det:stats(g.det),radius:stats(g.dist),weightKeys:g.weightKeys}]));}
const results=[];
for(const name of ['jett','sage']){
 const asset=await loadRig(name),camera=new THREE.PerspectiveCamera(),arms=new ViewArms(asset,camera),weapon=createFirstPersonPhantom(phantom.scene),gunRoot=new THREE.Group();camera.add(gunRoot);gunRoot.add(weapon.group);gunRoot.position.set(.24,-.23,-.4);camera.updateMatrixWorld(true);arms.bindWeapon(weapon.anchors);arms.update(1/60);
 const result={agent:name,bones:[],tracks:asset.animations[0].tracks.filter(t=>/Shoulder_Twst|Elbow_Ndl/.test(t.name)).map(t=>t.name),variants:{}};
 const helpers=[];arms.model.traverse(b=>{if(b.isBone&&/^[LR]_(Shoulder_Twst|Elbow_Ndl|Elbow_Twst)/.test(b.name)&&!/end/.test(b.name)){helpers.push({bone:b,q:b.quaternion.clone(),p:b.position.clone()});result.bones.push({name:b.name,parent:b.parent.name,position:b.position.toArray(),q:b.quaternion.toArray()});}});
 const restore=()=>{for(const h of helpers){h.bone.quaternion.copy(h.q);h.bone.position.copy(h.p);}arms.model.updateMatrixWorld(true);};
 for(const variant of ['current','twist-only','twist-only-twst2','swing2-10percent','swing2-25percent','twist-only-twst2+needle-half-bind','needle-half-delta','needle-half-bind','needle-skin-mid','upper-follow-twist','needle-skin-mid+upper-follow-twist']){
  restore();
  for(const side of ['L','R']){
   const elbow=arms.bones[side+'_Elbow'],shoulder=arms.bones[side+'_Shoulder'],needle=find(arms.model,side+'_Elbow_Ndl'),upper=find(arms.model,side+'_Shoulder_Twst3'),reference=arms.restRotations.get(elbow),nrest=helpers.find(h=>h.bone===needle).q;
   if(variant.startsWith('twist-only')||variant.startsWith('swing2-')){
    const hand=arms.bones[side+'_Hand'],delta=hand.quaternion.clone().multiply(arms.restRotations.get(hand).clone().invert()).normalize(),axis=hand.position.clone().normalize(),projection=delta.x*axis.x+delta.y*axis.y+delta.z*axis.z,twist=new THREE.Quaternion(axis.x*projection,axis.y*projection,axis.z*projection,delta.w).normalize(),swing=delta.clone().multiply(twist.clone().invert()).normalize();
    const angle=arms.twistAngles[side];
    for(const {bone,rest,fraction} of arms.forearmTwists[side]){const is2=/Twst2_/.test(bone.name),swingFraction=variant==='twist-only'?0:is2?(variant.startsWith('swing2-10')?.1:variant.startsWith('swing2-25')?.25:0):fraction;bone.quaternion.copy(new THREE.Quaternion().slerp(swing,swingFraction).multiply(new THREE.Quaternion().setFromAxisAngle(axis,angle*fraction)).multiply(rest)).normalize();bone.updateMatrixWorld(true);}
    result.swingAngles??={};result.swingAngles[side]=swing.angleTo(new THREE.Quaternion());
   }
   if(variant.includes('upper-follow-twist')){
     const delta=elbow.quaternion.clone().multiply(reference.clone().invert()),axis=elbow.position.clone().normalize(),projection=delta.x*axis.x+delta.y*axis.y+delta.z*axis.z,twist=new THREE.Quaternion(axis.x*projection,axis.y*projection,axis.z*projection,delta.w).normalize();
     for(const h of helpers.filter(h=>h.bone.name.startsWith(side+'_Shoulder_Twst'))){const f=Math.abs(h.bone.position.x/elbow.position.x);h.bone.quaternion.copy(new THREE.Quaternion().slerp(twist,f).multiply(h.q));h.bone.updateMatrixWorld(true);}
   }
   if(variant==='needle-half-delta'){const partial=reference.clone().slerp(elbow.quaternion,.5);needle.quaternion.copy(elbow.quaternion.clone().invert().multiply(partial).multiply(nrest));needle.updateMatrixWorld(true);}
   if(variant.includes('needle-half-bind')){
     let mesh;arms.model.traverse(m=>{if(m.isSkinnedMesh&&m.visible)mesh=m;});const sk=mesh.skeleton,ei=sk.bones.indexOf(elbow),si=sk.bones.indexOf(shoulder),ebind=sk.boneInverses[ei].clone().invert(),sbind=sk.boneInverses[si].clone().invert(),elocal=sbind.invert().multiply(ebind),bq=new THREE.Quaternion().setFromRotationMatrix(elocal);const partial=bq.clone().slerp(elbow.quaternion,.5);needle.quaternion.copy(elbow.quaternion.clone().invert().multiply(partial).multiply(nrest));needle.updateMatrixWorld(true);
   }
   if(variant.includes('needle-skin-mid')){
     let mesh;arms.model.traverse(m=>{if(m.isSkinnedMesh&&m.visible)mesh=m;});const sk=mesh.skeleton,ni=sk.bones.indexOf(needle),ui=sk.bones.indexOf(upper),ei=sk.bones.indexOf(elbow),nBind=sk.boneInverses[ni].clone().invert().decompose(new THREE.Vector3(),new THREE.Quaternion(),new THREE.Vector3());
     const uDelta=new THREE.Matrix4().multiplyMatrices(upper.matrixWorld,sk.boneInverses[ui]),eDelta=new THREE.Matrix4().multiplyMatrices(elbow.matrixWorld,sk.boneInverses[ei]),uq=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(uDelta)),eq=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(eDelta)),nq=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(sk.boneInverses[ni].clone().invert()));const desired=uq.slerp(eq,.5).multiply(nq).normalize();needle.quaternion.copy(elbow.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(desired)).normalize();needle.updateMatrixWorld(true);
   }
  }
  result.variants[variant]=Object.fromEntries(['L','R'].map(s=>[s,elbowMetrics(arms,s)]));
 }
 results.push(result);arms.dispose();weapon.dispose();
}
fs.writeFileSync(new URL('./elbow-probe-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n','utf8');console.log(JSON.stringify(results.map(r=>({agent:r.agent,bones:r.bones,tracks:r.tracks,variants:Object.fromEntries(Object.entries(r.variants).map(([v,s])=>[v,Object.fromEntries(Object.entries(s).map(([side,g])=>[side,Object.fromEntries(Object.entries(g).map(([k,m])=>[k,{det:m.det,radius:m.radius}]))]))]))})),null,2));
