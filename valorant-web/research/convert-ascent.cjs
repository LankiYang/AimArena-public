// UTF-8. Convert the published VMAP mesh to glTF 2.0 without simplifying it.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const repo = path.join(__dirname, 'map-candidate-2');
const sourceCommit = '961d8cb363155f1fa704256bc90c15bce471d5ce';
const originalPath = path.join(__dirname, 'ascentB-original.bin');
const source = fs.existsSync(originalPath) ? fs.readFileSync(originalPath) : cp.execFileSync('git', ['show', 'HEAD:assets/maps/ascentB.bin'], { cwd: repo, maxBuffer: 100_000_000 });
const vertexCount = source.readUInt32LE(8), triangleCount = source.readUInt32LE(12);
const vertexBytes = vertexCount * 32, indexBytes = triangleCount * 12;
if (source.toString('ascii', 0, 4) !== 'VMAP' || source.readUInt32LE(4) !== 1 || source.length !== 40 + vertexBytes + indexBytes) throw Error('Invalid/truncated VMAP');
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
const colorMin = [255,255,255,255], colorMax=[0,0,0,0];
const flagCounts = {};
for (let i = 0; i < vertexCount; i++) {
  const o = 40 + i * 32;
  for (let a = 0; a < 3; a++) { const v = source.readFloatLE(o+a*4); if (!Number.isFinite(v)) throw Error('Invalid vertex'); min[a] = Math.min(min[a],v); max[a]=Math.max(max[a],v); }
  for(let c=0;c<4;c++){colorMin[c]=Math.min(colorMin[c],source[o+24+c]);colorMax[c]=Math.max(colorMax[c],source[o+24+c]);}
  const flag=source[o+28];flagCounts[flag]=(flagCounts[flag]||0)+1;
}
for (let i = 0; i < triangleCount * 3; i++) if (source.readUInt32LE(40+vertexBytes+i*4)>=vertexCount) throw Error('Out of range index');
const bin=source.subarray(40);
const metadata={source:'https://github.com/vanshnegi4444-sys/aimlab',sourceCommit,sourceFile:'assets/maps/ascentB.bin',originalRights:'VALORANT map geometry: Riot Games. Upstream software MIT (Vansh Negi, 2026). User states project authorization.',conversion:'VMAP v1 positions, normals, vertex colors and triangle indices preserved; no reduction, no original texture maps.',limitations:'Ascent B excerpt only. Upstream reports floor gaps and missing Market corridor. Not a full Ascent map.',vertexCount,triangleCount,min,max,colorMin,colorMax,flagCounts};
const gltf={asset:{version:'2.0',generator:'VMAP to GLB converter',extras:metadata},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'Ascent B — published geometry excerpt',mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,COLOR_0:2},indices:3,material:0,mode:4}]}],materials:[{name:'Preserved vertex colors',pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],roughnessFactor:1,metallicFactor:0},doubleSided:true}],buffers:[{byteLength:bin.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:vertexBytes,byteStride:32,target:34962},{buffer:0,byteOffset:vertexBytes,byteLength:indexBytes,target:34963}],accessors:[{bufferView:0,byteOffset:0,componentType:5126,count:vertexCount,type:'VEC3',min,max},{bufferView:0,byteOffset:12,componentType:5126,count:vertexCount,type:'VEC3'},{bufferView:0,byteOffset:24,componentType:5121,normalized:true,count:vertexCount,type:'VEC4'},{bufferView:1,byteOffset:0,componentType:5125,count:triangleCount*3,type:'SCALAR'}]};
const rawJson=Buffer.from(JSON.stringify(gltf),'utf8'), json=Buffer.alloc(Math.ceil(rawJson.length/4)*4,32);rawJson.copy(json);
const binPad=Buffer.alloc(Math.ceil(bin.length/4)*4);bin.copy(binPad);
const header=Buffer.alloc(12);header.write('glTF',0);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+json.length+8+binPad.length,8);
const jh=Buffer.alloc(8);jh.writeUInt32LE(json.length,0);jh.writeUInt32LE(0x4e4f534a,4);
const bh=Buffer.alloc(8);bh.writeUInt32LE(binPad.length,0);bh.writeUInt32LE(0x004e4942,4);
fs.mkdirSync(path.join(root,'assets/maps'),{recursive:true});
fs.writeFileSync(path.join(root,'assets/maps/ascent-b.glb'),Buffer.concat([header,jh,json,bh,binPad]));
fs.writeFileSync(path.join(root,'assets/maps/ascent-b.metadata.json'),JSON.stringify(metadata,null,2)+'\n','utf8');
fs.writeFileSync(path.join(__dirname,'ascentB-original.bin'),source);
console.log(JSON.stringify(metadata,null,2));
