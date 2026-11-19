'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const source = process.argv[2];
if (!source) throw Error('Usage: node research/import-ascent-full.cjs <extracted map folder>');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
if (!/^[a-z]+$/.test(manifest.key)) throw Error('Invalid map key');
const id=manifest.key==='ascent'?'ascent-full':manifest.key;
const target = path.resolve(__dirname, '../assets/maps', id);
fs.mkdirSync(target, { recursive: true });
const profiles = {
  brick: [[.55,.41,.32], .94], stone: [[.55,.53,.48], .93], plaster: [[.65,.58,.49], .92],
  wood: [[.45,.31,.22], .79], metal: [[.44,.47,.49], .63], fabric: [[.43,.52,.42], .9],
  foliage: [[.33,.46,.25], .97], glass: [[.36,.48,.51], .27], accent: [[.54,.48,.42], .84],
};
function profile(material) {
  const n = material.name.toLowerCase();
  if (/envcollision|collisionhull|blockout|decal|graffiti|floater|papers|stain|sticker|poster|skybox/.test(n)) return null;
  if (/leaf|leaves|foliage|plant|ivy|grass|vine|hedge|shrub/.test(n)) return 'foliage';
  if (/glass|water/.test(n)) return 'glass';
  if (/cloth|tarp|awning|fabric|carpet|flag/.test(n)) return 'fabric';
  if (/metal|iron|fence|electri|pipe|antenna|vent|generator|neon/.test(n)) return 'metal';
  if (/wood|plank|barrel|shutter|woodcrate/.test(n)) return 'wood';
  if (/brick|terracotta|rooftile|roof_tile/.test(n)) return 'brick';
  if (/stone|paving|cobble|gravel|ground|concrete|stairs|floor/.test(n)) return 'stone';
  if (/plaster|stucco|wall|trimkit|building/.test(n)) return 'plaster';
  return 'accent';
}
const linear8 = v => Math.round(255 * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4));
const output = [], omitted=[];
for (const level of manifest.levels) {
  if(!/^[A-Za-z0-9_]+$/.test(level)) throw Error('Invalid level name: '+level);
  if(/vista|skybox|backdrop|^canyon_(apathnomid|asidepath)$/i.test(level)){omitted.push({level,reason:'nonplayable scenery or prototype'});continue;}
  const input = fs.readFileSync(path.join(source, level + '.glb'));
  const n = input.readUInt32LE(12);
  const j = JSON.parse(input.toString('utf8', 20, 20 + n)), bin = input.subarray(28 + n), buckets = new Map();
  if(!j.meshes?.length){omitted.push({level,reason:'source contains no meshes'});continue;}
  if(j.meshes.length!==1||j.nodes.length!==1||['translation','rotation','scale','matrix'].some(k=>k in j.nodes[0]))throw Error('Unexpected source geometry transform: '+level);
  function accessor(number, component, type) {
    const a = j.accessors[number], view = j.bufferViews[a.bufferView];
    if (!a || a.sparse || view.buffer !== 0 || a.type !== type || (component && a.componentType !== component)) throw Error('Unexpected source accessor');
    const bytes = a.componentType === 5123 ? 2 : a.componentType === 5121 ? 1 : 4;
    const size = type === 'VEC3' ? 3 : 1, start = (view.byteOffset || 0) + (a.byteOffset || 0), stride = view.byteStride || bytes * size;
    const method = {5121:'readUInt8',5123:'readUInt16LE',5125:'readUInt32LE',5126:'readFloatLE'}[a.componentType];
    if (!method || start+(a.count-1)*stride+bytes*size > bin.length) throw Error('Invalid source accessor');
    return { count: a.count, get: (i,k=0) => bin[method](start+i*stride+k*bytes) };
  }
  for (const p of j.meshes[0].primitives) {
    const mat = j.materials[p.material], kind = profile(mat);
    if (!kind) continue;
    const shade = (mat.extras?.vt_color || profiles[kind][0]).slice(0,3).map(linear8);
    const created = new Map();
    const pos = accessor(p.attributes.POSITION, 5126, 'VEC3'), norm = accessor(p.attributes.NORMAL, 5126, 'VEC3'), ix = accessor(p.indices, null, 'SCALAR');
    for (let i = 0; i < ix.count; i += 3) {
      const a = ix.get(i), b = ix.get(i+1), c = ix.get(i+2);
      const tx = Math.floor((pos.get(a,2)+pos.get(b,2)+pos.get(c,2))/66);
      const tz = Math.floor((pos.get(a,0)+pos.get(b,0)+pos.get(c,0))/66);
      const key = kind+':'+tx+':'+tz;
      if (!buckets.has(key)) buckets.set(key, { kind, pos:[], normal:[], color:[], index:[] });
      const out = buckets.get(key);
      if (!created.has(key)) created.set(key, new Map());
      const remap = created.get(key);
      for (const v of [a,b,c]) {
        if (!remap.has(v)) {
          remap.set(v, out.pos.length/3);
          out.pos.push(pos.get(v,2)+manifest.origin_x,pos.get(v,1)+manifest.origin_y,manifest.origin_z-pos.get(v,0));
          out.normal.push(norm.get(v,2),norm.get(v,1),-norm.get(v,0));
          out.color.push(...shade,255);
        }
        out.index.push(remap.get(v));
      }
    }
  }
  if(!buckets.size){omitted.push({level,reason:'no rendered surfaces'});continue;}
  const gltf = { asset:{version:'2.0',generator:'AimArena map release importer'}, scene:0, scenes:[{nodes:[]}], nodes:[], meshes:[], materials:[], buffers:[{}], bufferViews:[], accessors:[] };
  const blobs = []; let offset = 0, triangles = 0;
  function write(values, type, componentType, target, normalized = false) {
    const buffer = Buffer.from(values.buffer), min = [], max = [], size = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4;
    if (target === 34962 && componentType === 5126 && type === 'VEC3') {
      for (let i=0;i<3;i++) { min[i]=Infinity; max[i]=-Infinity; }
      for (let i=0;i<values.length;i++) { const a=i%size; min[a]=Math.min(min[a],values[i]); max[a]=Math.max(max[a],values[i]); }
    }
    const a = {bufferView:gltf.bufferViews.length,componentType,count:values.length/size,type};
    if (normalized) a.normalized = true;
    if (min.length) { a.min = min; a.max = max; }
    const padded = (buffer.length+3)&~3;
    gltf.bufferViews.push({buffer:0,byteOffset:offset,byteLength:buffer.length,target});
    blobs.push(buffer); if(padded>buffer.length)blobs.push(Buffer.alloc(padded-buffer.length)); offset+=padded;
    return gltf.accessors.push(a)-1;
  }
  for (const [name, b] of buckets) {
    let material = gltf.materials.findIndex(m => m.name === b.kind);
    if (material < 0) material = gltf.materials.push({name:b.kind,pbrMetallicRoughness:{metallicFactor:0,roughnessFactor:profiles[b.kind][1]},doubleSided:/foliage|metal|fabric/.test(b.kind)})-1;
    const attributes = {
      POSITION:write(Float32Array.from(b.pos),'VEC3',5126,34962),
      NORMAL:write(Float32Array.from(b.normal),'VEC3',5126,34962),
      COLOR_0:write(Uint8Array.from(b.color),'VEC4',5121,34962,true),
    };
    const narrow = b.pos.length/3<=65536;
    const indices = write((narrow?Uint16Array:Uint32Array).from(b.index),'SCALAR',narrow?5123:5125,34963);
    const mesh = gltf.meshes.push({name,primitives:[{attributes,indices,material}]})-1;
    gltf.scenes[0].nodes.push(gltf.nodes.push({name,mesh})-1);
    triangles+=b.index.length/3;
  }
  gltf.buffers[0].byteLength = offset;
  const js = Buffer.from(JSON.stringify(gltf),'utf8'), json = Buffer.alloc((js.length+3)&~3,32); js.copy(json);
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2,4); header.writeUInt32LE(28+json.length+offset,8);
  header.writeUInt32LE(json.length,12); header.write('JSON',16); binHeader.writeUInt32LE(offset); binHeader.write('BIN\0',4);
  const glb = Buffer.concat([header,json,binHeader,...blobs]);
  const encoded = zlib.gzipSync(glb, { level: 6 });
  const file = level + '.glb';
  fs.writeFileSync(path.join(target, file + '.gz'),encoded);
  output.push({file, triangles, batches:buckets.size, bytes:encoded.length, sha256:crypto.createHash('sha256').update(encoded).digest('hex'),sourceSha256:crypto.createHash('sha256').update(input).digest('hex')});
  console.log(file,triangles,buckets.size,encoded.length);
}
fs.copyFileSync(path.join(source,'collision.json'),path.join(target,'collision.json'));
fs.writeFileSync(path.join(target,'levels.json'),JSON.stringify({source:'https://github.com/Pyromesis/CA-VAL-AIM/releases/tag/maps',levels:output,omitted},null,2)+'\n','utf8');
