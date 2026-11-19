// UTF-8. Verify actual downloaded payloads; do not trust filenames or HTTP 200.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),assetRoot=path.join(root,'assets');
const report=[];
function walk(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);}
function crc32(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function checkGltf(j,b){assert.equal(j.asset.version,'2.0');assert.equal(j.buffers.length,1);assert.ok(j.buffers[0].byteLength<=b.length);for(const view of j.bufferViews||[])assert.ok((view.byteOffset||0)+view.byteLength<=b.length,'bufferView out of range');for(const mesh of j.meshes||[])for(const prim of mesh.primitives||[]){assert.ok(j.accessors[prim.attributes.POSITION]);if(prim.indices!==undefined)assert.ok(j.accessors[prim.indices]);}return {meshes:j.meshes?.length||0,skins:j.skins?.length||0,animations:j.animations?.map(a=>a.name)||[],imageCount:j.images?.length||0,asset:j.asset};}
for(const file of walk(assetRoot)){
 const rel=path.relative(root,file).replaceAll('\\','/');if(rel.endsWith('manifest.json'))continue;
 const b=fs.readFileSync(file),ext=path.extname(file).toLowerCase();assert.ok(b.length>0,rel+' empty');
 const row={file:rel,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};
 if(ext==='.glb'){
   assert.equal(b.toString('ascii',0,4),'glTF');assert.equal(b.readUInt32LE(4),2);assert.equal(b.readUInt32LE(8),b.length,rel+' truncated');let offset=12,j,bin;
   while(offset<b.length){const size=b.readUInt32LE(offset),kind=b.readUInt32LE(offset+4);assert.equal(size%4,0);assert.ok(offset+8+size<=b.length);if(kind===0x4e4f534a)j=JSON.parse(b.subarray(offset+8,offset+8+size).toString('utf8'));else if(kind===0x004e4942)bin=b.subarray(offset+8,offset+8+size);offset+=8+size;}
   assert.equal(offset,b.length);assert.ok(j&&bin);Object.assign(row,checkGltf(j,bin));
 } else if(ext==='.gltf'){
   const j=JSON.parse(b.toString('utf8'));assert.ok(!j.buffers[0].uri.includes('://'));Object.assign(row,checkGltf(j,fs.readFileSync(path.join(path.dirname(file),j.buffers[0].uri))));
 } else if(ext==='.png'){
   assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let offset=8,ended=false;
   while(offset<b.length){const size=b.readUInt32BE(offset),type=b.toString('ascii',offset+4,offset+8);assert.ok(offset+12+size<=b.length);assert.equal(crc32(b.subarray(offset+4,offset+8+size)),b.readUInt32BE(offset+8+size),'PNG CRC '+rel);if(type==='IHDR'){row.width=b.readUInt32BE(offset+8);row.height=b.readUInt32BE(offset+12);}if(type==='IEND')ended=true;offset+=size+12;}
   assert.equal(offset,b.length);assert.ok(ended);
 } else if(ext==='.jpg'){
   assert.equal(b.readUInt16BE(0),0xffd8);assert.equal(b.readUInt16BE(b.length-2),0xffd9,rel+' missing JPEG end');
   let o=2;while(o<b.length-4){if(b[o]!==255){o++;continue;}const marker=b[o+1];if(marker===0xda||marker===0xd9)break;const n=b.readUInt16BE(o+2);if([0xc0,0xc1,0xc2].includes(marker)){row.height=b.readUInt16BE(o+5);row.width=b.readUInt16BE(o+7);break;}o+=n+2;}assert.ok(row.width&&row.height);
 } else if(ext==='.json')JSON.parse(b.toString('utf8'));
 report.push(row);
}
fs.writeFileSync(path.join(assetRoot,'manifest.json'),JSON.stringify({verifiedAt:new Date().toISOString(),files:report},null,2)+'\n','utf8');
console.log(`Asset verification passed: ${report.length} files, ${report.reduce((s,r)=>s+r.bytes,0).toLocaleString()} bytes.`);
console.log(report.map(r=>({file:r.file,bytes:r.bytes,width:r.width,height:r.height,meshes:r.meshes,skins:r.skins,animations:r.animations})));
