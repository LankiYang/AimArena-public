// UTF-8. Material reconstruction over the complete, unchanged Ascent B mesh.
// This is an authored Mediterranean material study, not recovered Riot textures.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const ASCENT_ENVIRONMENT_METADATA = Object.freeze({
  version: 1,
  sourceGeometry: 'Ascent B published VMAP excerpt / 192,209 original triangles',
  materialStatus: 'Reconstructed materials; original Riot texture maps and material IDs are unavailable.',
  flagEvidence: 'Upstream VMapVertex flag 1 is floor, 2 is head. The source renderer reads only position, normal and color; flags are not material IDs.',
  method: 'Unchanged source positions, triangle indices and normals, split into material groups; per-triangle planar world UVs. Architectural materials inferred conservatively from face slope, height and connected component bounds.',
  pbrSource: 'ambientCG Plaster001 and Bricks097, CC0. Supplementary tiling maps are deterministic procedural textures created for this project.',
  collision: 'No added collidable obstacles. Distant skyline and wall paint are visual dressing only.',
});

const SURFACES = ['plaster', 'plasterCool', 'plasterRose', 'stone', 'paving', 'roof', 'wood', 'metal', 'glass', 'trim'];
// 0-based source triangle ranges, confirmed by positional-weld component audit.
const EVIDENCE = {
  roof: [[92282, 92291], [37301, 37344], [67978, 67993], [108317, 108360]],
  frame: [[31054, 31187], [31246, 31355], [31574, 31661], [31662, 31733], [31880, 31967]],
  door: [[55445, 55470]],
};
const inRanges = (triangle, ranges) => ranges.some(([a, b]) => triangle >= a && triangle <= b);

function componentsFor(geometry) {
  const pos = geometry.getAttribute('position'), index = geometry.index?.array;
  if (!index) throw new Error('Ascent environment expects the original indexed geometry');
  const parents = new Int32Array(pos.count); for (let i = 0; i < parents.length; i++) parents[i] = i;
  const find = a => { while (parents[a] !== a) { parents[a] = parents[parents[a]]; a = parents[a]; } return a; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parents[b] = a; };
  for (let i = 0; i < index.length; i += 3) { join(index[i], index[i + 1]); join(index[i], index[i + 2]); }
  // Original normal/material seams duplicate vertices. A position-only weld is
  // used for analysis, while every rendered/collidable vertex stays untouched.
  const welded = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 10000)},${Math.round(pos.getY(i) * 10000)},${Math.round(pos.getZ(i) * 10000)}`;
    const prior = welded.get(key); if (prior === undefined) welded.set(key, i); else join(i, prior);
  }
  const blocks = new Map();
  for (let i = 0; i < pos.count; i++) {
    const root = find(i); parents[i] = root;
    let c = blocks.get(root); if (!c) { c = { id: root, triangles: 0, area: 0, wallArea: 0, slopeArea: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; blocks.set(root, c); }
    const v = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    for (let a = 0; a < 3; a++) { c.min[a] = Math.min(c.min[a], v[a]); c.max[a] = Math.max(c.max[a], v[a]); }
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < index.length; i += 3) {
    const block = blocks.get(parents[index[i]]); block.triangles++;
    a.fromBufferAttribute(pos, index[i]); b.fromBufferAttribute(pos, index[i + 1]); c.fromBufferAttribute(pos, index[i + 2]);
    n.crossVectors(b.sub(a), c.sub(a)); const area = n.length() / 2, ny = area > 1e-10 ? Math.abs(n.y) / (area * 2) : 0;
    block.area += area; if (ny < .24) block.wallArea += area; else if (ny < .94) block.slopeArea += area;
  }
  for (const c of blocks.values()) { c.size = c.max.map((v, a) => v - c.min[a]); c.center = c.max.map((v, a) => (v + c.min[a]) / 2); }
  return { parents, blocks };
}

function classifyFace(c, center, normal, triangle) {
  const [x, y, z] = center, ny = Math.abs(normal.y), [w, h, d] = c.size;
  // The upstream course explicitly identifies this object as the green box.
  if (x > -28.6 && x < -22.6 && z > -65.8 && z < -59.5 && y > 1.25 && y < 3.05 && c.max[1] < 3.4) return 'metal';
  if (inRanges(triangle, EVIDENCE.frame)) return 'metal';
  if (inRanges(triangle, EVIDENCE.door)) return 'wood';
  // Confirmed connected roofs, then other elevated slope-dominant components.
  if (ny > .24 && inRanges(triangle, EVIDENCE.roof)) return 'roof';
  if (y > 6.8 && ny > .24 && c.min[1] > 5 && c.slopeArea / c.area > .55 && c.wallArea / c.area < .25 && Math.max(w, d) > 3) return 'roof';
  if (ny > .76 && y < 1.5) return 'paving';
  if (ny > .65 && y < 5.5) return 'stone';
  if (y < 1.75) return 'stone';
  // Pale carved cornices and shallow arch/stone trim retain the source outline.
  if (h < .45 && y > 2.8 && Math.max(w, d) > .4) return 'trim';
  if (ny > .7) return 'trim';
  // Building-scale color regions follow the original streets, not random faces.
  if (x < -40 && z > -82 && z < -58) return 'plasterRose';
  if (x > -15 && z < -72) return 'plasterCool';
  return 'plaster';
}

// Separate render geometry only. The caller's collision geometry is never edited.
export function buildAscentSurfaceGeometry(source) {
  const started = performance.now(), { parents, blocks } = componentsFor(source);
  const pos = source.getAttribute('position'), normals = source.getAttribute('normal'), indices = source.index.array;
  const count = indices.length, positions = new Float32Array(count * 3), normalData = new Float32Array(count * 3), uvs = new Float32Array(count * 2), colors = new Float32Array(count * 3);
  const buckets = SURFACES.map(() => []), counts = Object.fromEntries(SURFACES.map(s => [s, 0]));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t < count; t += 3) {
    a.fromBufferAttribute(pos, indices[t]); b.fromBufferAttribute(pos, indices[t + 1]); c.fromBufferAttribute(pos, indices[t + 2]);
    n.crossVectors(ab.copy(b).sub(a), ac.copy(c).sub(a)).normalize();
    const center = [(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3];
    const surface = classifyFace(blocks.get(parents[indices[t]]), center, n, t / 3), materialIndex = SURFACES.indexOf(surface);
    counts[surface]++; buckets[materialIndex].push(t, t + 1, t + 2);
    const horizontal = Math.abs(n.y) > .62, axisX = Math.abs(n.x) > Math.abs(n.z);
    for (let v = 0; v < 3; v++) {
      const i = indices[t + v], target = (t + v) * 3, x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      positions[target] = x; positions[target + 1] = y; positions[target + 2] = z;
      normalData[target] = normals.getX(i); normalData[target + 1] = normals.getY(i); normalData[target + 2] = normals.getZ(i);
      // Metre-space UVs have consistent texel density and no stretched wall tops.
      uvs[(t + v) * 2] = horizontal ? x : axisX ? z : x;
      uvs[(t + v) * 2 + 1] = horizontal ? z : y;
      // A subtle plinth/weathering gradient, independent of tessellation density.
      const shade = .93 + .07 * THREE.MathUtils.smoothstep(y, .75, 3.6);
      colors[target] = colors[target + 1] = colors[target + 2] = shade;
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setAttribute('normal', new THREE.BufferAttribute(normalData, 3)); geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2)); geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const renderIndex = new Uint32Array(count); let offset = 0;
  for (let m = 0; m < buckets.length; m++) { if (!buckets[m].length) continue; renderIndex.set(buckets[m], offset); geometry.addGroup(offset, buckets[m].length, m); offset += buckets[m].length; }
  geometry.setIndex(new THREE.BufferAttribute(renderIndex, 1)); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData = { ...ASCENT_ENVIRONMENT_METADATA, sourceTriangleCount: count / 3, materialTriangles: counts };
  return { geometry, statistics: { triangles: count / 3, sourceVertices: pos.count, renderVertices: count, components: blocks.size, groups: geometry.groups.length, materialTriangles: counts, buildMs: performance.now() - started } };
}

function canvasTexture(size, draw, color = true) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size; const ctx = canvas.getContext('2d', { alpha: false }); draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas); texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 8; texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace; return texture;
}
function hash(a, b = 0) { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); }
function pavingTexture() {
  return canvasTexture(1024, (ctx, size) => {
    ctx.fillStyle = '#717b79'; ctx.fillRect(0, 0, size, size);
    const rows = 8, cols = 8, cw = size / cols, ch = size / rows;
    for (let row = 0; row < rows; row++) for (let col = -1; col <= cols; col++) {
      const v = hash(col, row), x = col * cw + (row % 2) * cw * .5, y = row * ch;
      const light = 135 + v * 28, cool = 4 + hash(row, col) * 4;
      ctx.fillStyle = `rgb(${light - 5},${light + cool},${light + cool - 1})`; ctx.fillRect(x + 2.4, y + 2.4, cw - 4.8, ch - 4.8);
      ctx.strokeStyle = '#dce1d225'; ctx.lineWidth = 2; ctx.strokeRect(x + 4, y + 4, cw - 8, ch - 8);
    }
    const data = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < data.data.length; i += 4) { const grain = (hash(i) - .5) * 8; data.data[i] += grain; data.data[i + 1] += grain; data.data[i + 2] += grain; }
    ctx.putImageData(data, 0, 0);
  });
}
function tileTexture() {
  return canvasTexture(1024, (ctx, size) => {
    ctx.fillStyle = '#774d3c'; ctx.fillRect(0, 0, size, size);
    const w = 128, h = 128;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const v = hash(col, row), x = col * w, y = row * h;
      const gradient = ctx.createLinearGradient(x, 0, x + w, 0); gradient.addColorStop(0, '#7b4935'); gradient.addColorStop(.35, `rgb(${154 + v * 22},${91 + v * 13},${61 + v * 8})`); gradient.addColorStop(.75, '#b67a51'); gradient.addColorStop(1, '#85553b');
      ctx.fillStyle = gradient; ctx.fillRect(x + 2, y + 3, w - 4, h - 5); ctx.fillStyle = '#d59b6e44'; ctx.fillRect(x + 7, y + 3, w - 14, 4); ctx.fillStyle = '#593d354a'; ctx.fillRect(x + 4, y + h - 6, w - 8, 4);
    }
  });
}
function woodTexture() {
  return canvasTexture(512, (ctx, size) => {
    ctx.fillStyle = '#7a6650'; ctx.fillRect(0, 0, size, size);
    for (let x = 0; x < size; x++) { const a = hash(x); ctx.fillStyle = `rgba(${a > .5 ? '203,180,137' : '51,45,36'},${.04 + a * .14})`; ctx.fillRect(x, 0, 1, size); }
    for (let i = 0; i < 5; i++) { ctx.fillStyle = '#302f2b77'; ctx.fillRect(i * size / 5, 0, 2, size); }
  });
}

function makeMaterials(quality, pending, statistics) {
  const loader = new THREE.TextureLoader(), textures = [], tracked = texture => { textures.push(texture); return texture; };
  const load = (name, color) => {
    let resolveReady;
    pending.push(new Promise(resolve => { resolveReady = resolve; }));
    const texture = tracked(loader.load(`/assets/textures/${name}.jpg`, resolveReady, undefined, error => { statistics.textureErrors.push(name); console.error('Ascent PBR texture unavailable', name, error); resolveReady(); }));
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = quality === 'low' ? 2 : 8; texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return texture;
  };
  const plasterColor = load('plaster-color', true), plasterNormal = load('plaster-normal', false), plasterRough = load('plaster-roughness', false);
  // A square plaster sample covers four metres; large scale avoids noisy walls.
  for (const t of [plasterColor, plasterNormal, plasterRough]) t.repeat.set(.25, .25);
  const brickNormal = load('bricks-normal', false); brickNormal.repeat.set(.23, .36);
  const paving = tracked(pavingTexture()), tile = tracked(tileTexture()), wood = tracked(woodTexture()); paving.repeat.set(.27, .27); tile.repeat.set(.3, .3); wood.repeat.set(.5, .25);
  const common = { side: THREE.DoubleSide, vertexColors: true, roughness: .9, metalness: 0 };
  const plaster = color => new THREE.MeshStandardMaterial({ ...common, color, map: plasterColor, normalMap: quality === 'low' ? null : plasterNormal, roughnessMap: plasterRough, normalScale: new THREE.Vector2(.22, -.22), roughness: .95 });
  const mats = {
    plaster: plaster('#eee0bd'), plasterCool: plaster('#b7c4bb'), plasterRose: plaster('#d4b19c'),
    stone: new THREE.MeshStandardMaterial({ ...common, color: '#b7b9ab', map: plasterColor, normalMap: quality === 'low' ? null : plasterNormal, normalScale: new THREE.Vector2(.15, -.15), roughness: .97 }),
    paving: new THREE.MeshStandardMaterial({ ...common, color: '#e0e0cf', map: paving, normalMap: quality === 'low' ? null : plasterNormal, normalScale: new THREE.Vector2(.12, -.12), roughness: .96 }),
    roof: new THREE.MeshStandardMaterial({ ...common, color: '#e1b798', map: tile, normalMap: quality === 'low' ? null : brickNormal, normalScale: new THREE.Vector2(.22, -.22), roughness: .88 }),
    wood: new THREE.MeshStandardMaterial({ ...common, color: '#baa17f', map: wood, roughness: .86 }),
    metal: new THREE.MeshStandardMaterial({ ...common, color: '#708d80', roughness: .66, metalness: .3 }),
    glass: new THREE.MeshStandardMaterial({ ...common, color: '#3a575c', roughness: .34, metalness: .15 }),
    trim: new THREE.MeshStandardMaterial({ ...common, color: '#e6dfc7', map: plasterColor, roughness: .95 }),
  };
  return { materials: SURFACES.map(name => mats[name]), textures };
}

function paintTexture(text, subtitle, color) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512; const ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.font = 'bold 340px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 230); ctx.font = 'bold 25px Arial'; ctx.fillText(subtitle, 256, 442);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

function addWallPaint(root, source, origin, direction, text, subtitle, color, scale = 1.8) {
  const picker = new THREE.Mesh(source, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); picker.updateMatrixWorld(true);
  const hit = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction), 0, 8).intersectObject(picker)[0]; picker.material.dispose();
  if (!hit || Math.abs(hit.face.normal.y) > .2) return false;
  const normal = hit.face.normal.clone(); if (normal.dot(new THREE.Vector3(...direction)) > 0) normal.negate();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(scale, scale), new THREE.MeshStandardMaterial({ map: paintTexture(text, subtitle, color), transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mesh.position.copy(hit.point).addScaledVector(normal, .013); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal); mesh.name = `Nonblocking wall paint ${text}`; mesh.userData.nonColliding = true; root.add(mesh); return true;
}

export function createAscentSkyline({ merge = true } = {}) {
  const root = new THREE.Group(); root.name = 'Nonblocking distant floating skyline'; root.userData.nonColliding = true;
  const rockMat = new THREE.MeshStandardMaterial({ color: '#758e9a', roughness: 1, flatShading: true });
  const cityMat = new THREE.MeshStandardMaterial({ color: '#bdc5bf', roughness: 1 });
  rockMat.name = 'Ascent skyline rock'; cityMat.name = 'Ascent skyline architecture';
  for (const [x, y, z, scale] of [[-130, 32, -180, 1], [100, 51, -225, .7], [-12, 48, -260, .42]]) {
    const island = new THREE.Group(); island.name = 'Distant floating architecture'; island.position.set(x, y, z); island.scale.setScalar(scale); island.userData.nonColliding = true; root.add(island);
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(12, 1), rockMat); rock.scale.set(1.7, 1.15, 1); rock.position.y = -7; island.add(rock);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(18, 16, 1.7, 11), cityMat); top.position.y = 3; island.add(top);
    for (let i = 0; i < 11; i++) { const h = 3 + (i * 7) % 8; const building = new THREE.Mesh(new THREE.BoxGeometry(2.5 + i % 3, h, 3), cityMat); building.position.set(Math.sin(i * 2.4) * 10, 4 + h / 2, Math.cos(i * 2.4) * 7); island.add(building); }
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.8, 13, 8), cityMat); bell.position.set(1, 13, -2); island.add(bell);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), rockMat); dome.position.set(1, 19.5, -2); island.add(dome);
  }
  const statistics = { originalMeshes: 0, mergedMeshes: 0, triangles: 0 };
  root.updateMatrixWorld(true);
  const buckets = new Map(), originalGeometry = new Set(), inverseRoot = root.matrixWorld.clone().invert();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    statistics.originalMeshes++; statistics.triangles += (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3;
    if (!merge) return;
    // Bake each original local-to-world transform into this skyline root's local
    // space. Keep every indexed triangle and all normal/UV attributes unchanged.
    const local = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld);
    let geometry = mesh.geometry.clone(); geometry.applyMatrix4(local);
    if (geometry.index) { const expanded = geometry.toNonIndexed(); geometry.dispose(); geometry = expanded; }
    geometry.clearGroups();
    if (!buckets.has(mesh.material)) buckets.set(mesh.material, []);
    buckets.get(mesh.material).push(geometry); originalGeometry.add(mesh.geometry);
  });
  if (merge) {
    root.clear();
    for (const [material, parts] of buckets) {
      const geometry = mergeGeometries(parts, false);
      if (!geometry) throw new Error('Skyline material merge failed');
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material); mesh.name = `${material.name} merged`; mesh.userData.nonColliding = true;
      root.add(mesh); statistics.mergedMeshes++; parts.forEach(part => part.dispose());
    }
    originalGeometry.forEach(geometry => geometry.dispose());
  } else statistics.mergedMeshes = statistics.originalMeshes;
  return { root, statistics };
}

export function buildAscentEnvironment(scene, worldGeometry, { quality = 'high' } = {}) {
  const started = performance.now(), root = new THREE.Group(); root.name = 'Ascent B exact geometry with reconstructed materials'; root.userData = { ...ASCENT_ENVIRONMENT_METADATA };
  const built = buildAscentSurfaceGeometry(worldGeometry), statistics = { ...built.statistics, quality, metadata: ASCENT_ENVIRONMENT_METADATA, textureErrors: [], texturesReady: false, paintedSigns: 0 };
  const pending = [], { materials, textures } = makeMaterials(quality, pending, statistics);
  const mesh = new THREE.Mesh(built.geometry, materials); mesh.name = 'All 192209 original Ascent triangles'; mesh.castShadow = mesh.receiveShadow = true; root.add(mesh);
  // Static directional shadows are rendered once by the host renderer.
  const sun = new THREE.DirectionalLight('#ffebcd', 3.25); sun.position.set(-72, 67, -32); sun.target.position.set(-27, 2, -73); sun.castShadow = quality !== 'low'; sun.shadow.mapSize.set(quality === 'ultra' ? 4096 : 2048, quality === 'ultra' ? 4096 : 2048); Object.assign(sun.shadow.camera, { left: -47, right: 47, top: 43, bottom: -43, near: 2, far: 175 }); sun.shadow.normalBias = .035; sun.shadow.bias = -.00012; sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true; root.add(sun, sun.target);
  const hemisphere = new THREE.HemisphereLight('#cae4f4', '#786b54', 1.85); root.add(hemisphere);
  const bounce = new THREE.DirectionalLight('#a3c9df', .45); bounce.position.set(40, 15, -105); root.add(bounce);
  const sky = new Sky(); sky.scale.setScalar(4000); const skyU = sky.material.uniforms; skyU.turbidity.value = 2.5; skyU.rayleigh.value = 1.8; skyU.mieCoefficient.value = .003; skyU.mieDirectionalG.value = .76; skyU.sunPosition.value.copy(sun.position).sub(sun.target.position).normalize().multiplyScalar(1000); sky.name = 'Mediterranean blue sky'; root.add(sky);
  scene.background = new THREE.Color('#b5d5e2'); scene.fog = new THREE.FogExp2('#bdd1d5', .0025);
  const skyline = createAscentSkyline(); root.add(skyline.root); statistics.skyline = skyline.statistics;
  statistics.paintedSigns += Number(addWallPaint(root, worldGeometry, [-25, 3.15, -52], [1, 0, 0], 'B', 'SITO • B', '#b76748', 1.55));
  statistics.paintedSigns += Number(addWallPaint(root, worldGeometry, [-25, 2.7, -55], [-1, 0, 0], '→', 'CANTIERE', '#485e5d', 1.35));
  scene.add(root); statistics.totalBuildMs = performance.now() - started;
  const ready = Promise.allSettled(pending).then(() => { statistics.texturesReady = true; return statistics; });
  return { root, statistics, ready, sun, mesh,
    dispose() { root.removeFromParent(); const geometries = new Set(), materialSet = new Set(), textureSet = new Set(textures); root.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (Array.isArray(o.material)) o.material.forEach(m => materialSet.add(m)); else if (o.material) materialSet.add(o.material); }); for (const g of geometries) g.dispose(); for (const m of materialSet) { if (m.map) textureSet.add(m.map); m.dispose(); } for (const t of textureSet) t.dispose(); sun.shadow.map?.dispose(); },
  };
}
