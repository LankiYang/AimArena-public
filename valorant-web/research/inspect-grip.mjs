import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ViewArms } from '../src/view-arms.js';
import { createPhantomModel } from '../src/weapon-model.js';
globalThis.ProgressEvent ||= class {constructor(type,data){Object.assign(this,{type,...data});}};
async function loadRig(name){
 const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url)),n=bytes.readUInt32LE(12),j=JSON.parse(bytes.toString('utf8',20,20+n));
 delete j.images;delete j.textures;j.materials?.forEach(m=>{delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;});
 j.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(28+n,28+n+bytes.readUInt32LE(20+n)).toString('base64');return new GLTFLoader().parseAsync(JSON.stringify(j),'');
}
const j=JSON.parse(fs.readFileSync(new URL('../assets/weapons/res-phantom/scene.gltf',import.meta.url),'utf8'));
for(const b of j.buffers)b.uri='data:application/octet-stream;base64,'+fs.readFileSync(new URL('../assets/weapons/res-phantom/'+b.uri,import.meta.url)).toString('base64');
const source=await new GLTFLoader().parseAsync(JSON.stringify(j),'');source.scene.updateMatrixWorld(true);const sb=new THREE.Box3().setFromObject(source.scene),ss=sb.getSize(new THREE.Vector3());
const gripSource=new THREE.Vector3(sb.min.x+ss.x*.704,sb.min.y+ss.y*.32,sb.getCenter(new THREE.Vector3()).z);
const gun=createPhantomModel(source.scene).group;gun.rotation.y=-Math.PI/2;gun.updateMatrixWorld(true);const rb=new THREE.Box3().setFromObject(gun),rc=rb.getCenter(new THREE.Vector3()),scale=.91/rb.getSize(new THREE.Vector3()).length();const actualScale=.91/ss.x;
gun.scale.setScalar(actualScale);gun.position.set(-rc.x*actualScale,-rc.y*actualScale,-rc.z*actualScale-.13);const gunRoot=new THREE.Group();gunRoot.position.set(.24,-.23,-.4);gunRoot.add(gun);gunRoot.updateMatrixWorld(true);
const cameraGrip=gun.localToWorld(gripSource.clone());
console.log('sourceBounds',sb.min.toArray(),sb.max.toArray(),'gripSource',gripSource.toArray(),'cameraGrip',cameraGrip.toArray());
console.log('meshBounds');source.scene.traverse(o=>{if(o.isMesh){const b=new THREE.Box3().setFromObject(o),s=b.getSize(new THREE.Vector3());console.log(o.name,'min',b.min.toArray().map(x=>+x.toFixed(3)),'max',b.max.toArray().map(x=>+x.toFixed(3)),'color',o.material.color.getHexString());}});
for(const name of ['jett','sage']){
 const a=await loadRig(name),cam=new THREE.PerspectiveCamera(),arms=new ViewArms(a,cam);arms.update(0);cam.updateMatrixWorld(true);
 const bones={};arms.model.traverse(o=>{if(o.isBone&&/^R_(Hand|WeaponPoint|Thumb|Index|Middle|Ring|Pinky)/.test(o.name)&&!/Twst|Ndl/.test(o.name)){bones[o.name]={p:o.getWorldPosition(new THREE.Vector3()).toArray(),localP:o.position.toArray(),q:o.getWorldQuaternion(new THREE.Quaternion()).toArray()};}});
 console.log(name,JSON.stringify(bones));
 arms.dispose();
}
