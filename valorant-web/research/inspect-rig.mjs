import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
globalThis.ProgressEvent=class{constructor(type,data){Object.assign(this,{type,...data});}};
for(const name of ['jett','sage']){
  const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url));
  const jsonLength=bytes.readUInt32LE(12),j=JSON.parse(bytes.toString('utf8',20,20+jsonLength));
  const binaryOffset=20+jsonLength+8,binaryLength=bytes.readUInt32LE(20+jsonLength);
  delete j.images;delete j.textures;j.materials?.forEach(m=>{delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;});
  j.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(binaryOffset,binaryOffset+binaryLength).toString('base64');
  const g=await new GLTFLoader().parseAsync(JSON.stringify(j),'');const mixer=new THREE.AnimationMixer(g.scene);mixer.clipAction(g.animations[0]).play();mixer.update(0);
  g.scene.updateMatrixWorld(true);const b=new THREE.Box3().setFromObject(g.scene),height=b.getSize(new THREE.Vector3()).y;const info={height,bounds:{min:b.min.toArray(),max:b.max.toArray()},bones:{},armVertices:0,totalVertices:0};
  g.scene.traverse(o=>{if(/^(R_Hand_|L_Hand_|Head_|R_WeaponPoint_|Spine4_|L_Elbow_|R_Elbow_)/.test(o.name)&&!o.name.includes('end'))info.bones[o.name]=o.getWorldPosition(new THREE.Vector3()).multiplyScalar(1.82/height).toArray();
    if(o.isSkinnedMesh){const skinIndex=o.geometry.attributes.skinIndex,weight=o.geometry.attributes.skinWeight;const allowed=new Set(o.skeleton.bones.map((b,i)=>/^[LR]_(Shoulder|Elbow|Hand|Thumb|Index|Middle|Pinky|Ring|Sleeve)/.test(b.name)?i:-1).filter(i=>i>=0));for(let i=0;i<skinIndex.count;i++){info.totalVertices++;let w=0;for(let c=0;c<4;c++)if(allowed.has(skinIndex.array[i*4+c]))w+=weight.array[i*4+c];if(w>.45)info.armVertices++;}}
  });console.log(name,JSON.stringify(info));
}
