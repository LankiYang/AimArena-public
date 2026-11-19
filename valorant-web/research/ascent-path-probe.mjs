// UTF-8. Read-only source-mesh walking reachability probe; never edits geometry.
import fs from 'node:fs';
import * as THREE from 'three';
import { buildAscentCollision, AscentWalker } from '../src/ascent-collision.mjs';

const world = buildAscentCollision(fs.readFileSync(new URL('../assets/maps/ascent-b.glb', import.meta.url)));
const target = new THREE.Vector3(-32, 0.999896, -66), dt = 1 / 60, frames = 10, speed = 5.2;
const maxNodes = Number(process.argv.find(a => a.startsWith('--max='))?.slice(6) || 4500);
const selected = process.argv.find(a => a.startsWith('--team='))?.slice(7);
const directions = Array.from({ length: 8 }, (_, i) => ({ x: Math.sin(i * Math.PI / 4), z: -Math.cos(i * Math.PI / 4) }));
const key = p => [Math.round(p.x / .5), Math.round(p.y / .5), Math.round(p.z / .5)].join(',');
const distance = p => Math.hypot(p.x - target.x, p.z - target.z) + Math.abs(p.y - target.y) * .5;

function save(walker, parent = null, action = null, cost = 0) {
  return { capsule: walker.capsule.clone(), velocity: walker.velocity.clone(), grounded: walker.grounded, p: walker.getFoot(), parent, action, cost };
}
function load(walker, state) { walker.capsule.copy(state.capsule); walker.velocity.copy(state.velocity); walker.grounded = state.grounded; walker.fellOut = false; }
function route(node) { const result = []; while (node.parent) { result.push(node); node = node.parent; } return result.reverse(); }

function search(label, spawn) {
  const walker = new AscentWalker(world, spawn);
  for (let i = 0; i < 30; i++) walker.update({ x: 0, z: 0 }, dt, { speed });
  const start = save(walker), open = [start], seen = new Map([[key(start.p), start]]), started = performance.now(); let explored = 0, best = start, maxX = start.p.x, minX = maxX, minZ = start.p.z, maxZ = minZ;
  while (open.length && explored < maxNodes) {
    let choice = 0;
    for (let i = 1; i < open.length; i++) if (open[i].cost + distance(open[i].p) * 1.15 < open[choice].cost + distance(open[choice].p) * 1.15) choice = i;
    const state = open.splice(choice, 1)[0]; explored++;
    if (distance(state.p) < distance(best.p)) best = state;
    if (Math.hypot(state.p.x - target.x, state.p.z - target.z) < 1.2 && Math.abs(state.p.y - target.y) < .4 && state.grounded) { best = state; break; }
    for (let action = 0; action < directions.length; action++) {
      load(walker, state);
      for (let i = 0; i < frames; i++) walker.update(directions[action], dt, { speed });
      const p = walker.getFoot();
      if (walker.fellOut || p.y < -2.5 || p.y > 4 || Math.hypot(p.x - state.p.x, p.z - state.p.z) < .16) continue;
      const nodeKey = key(p), cost = state.cost + frames * dt * speed;
      if (seen.has(nodeKey) && seen.get(nodeKey).cost <= cost + .01) continue;
      const next = save(walker, state, action, cost); seen.set(nodeKey, next); open.push(next);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    if (explored % 500 === 0) console.log(`${label}: explored ${explored}, open ${open.length}, closest ${distance(best.p).toFixed(2)}m, ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  const path = route(best), found = Math.hypot(best.p.x - target.x, best.p.z - target.z) < 1.2 && Math.abs(best.p.y - target.y) < .4 && best.grounded;
  const withinPlantRadius = Math.hypot(best.p.x - target.x, best.p.z - target.z) < 8 && Math.abs(best.p.y - target.y) < 2.5 && best.grounded;
  // Replay every selected real input step from the original spawn as evidence.
  load(walker, start); let maxReplayDrift = 0, minFootY = Infinity, maxFootY = -Infinity, floorMissFrames = 0, nonGroundedFrames = 0, fellOut = false;
  for (const state of path) {
    for (let i = 0; i < frames; i++) {
      walker.update(directions[state.action], dt, { speed }); const foot = walker.getFoot();
      minFootY = Math.min(minFootY, foot.y); maxFootY = Math.max(maxFootY, foot.y);
      if (!world.floorAt(foot.x, foot.z, foot.y + .2, .65)) floorMissFrames++;
      if (!walker.grounded) nonGroundedFrames++;
      fellOut ||= walker.fellOut;
    }
    maxReplayDrift = Math.max(maxReplayDrift, walker.getFoot().distanceTo(state.p));
  }
  const turns = [{ action: 'start', foot: start.p.toArray().map(n => Number(n.toFixed(4))) }];
  path.forEach((state, i) => { if (i === path.length - 1 || state.action !== path[i + 1].action) turns.push({ action: state.action, direction: directions[state.action], foot: state.p.toArray().map(n => Number(n.toFixed(4))) }); });
  return { label, spawn, target: target.toArray(), found, withinPlantRadius, explored, pending: open.length, exhausted: open.length === 0, maxNodes, seconds: (performance.now() - started) / 1000, closest: best.p.toArray(), closestDistance: distance(best.p), searchBounds: { minX, maxX, minZ, maxZ }, replay: { maxDrift: maxReplayDrift, totalFrames: path.length * frames, minFootY, maxFootY, floorMissFrames, nonGroundedFrames, fellOut }, waypoints: turns, actions: path.map(state => state.action), framesPerAction: frames, dt, speed, limits: 'Bounded eight-direction actual-capsule walking search, 0.5m visited-state cells. No jumping/abilities, no added geometry. Failure is not a proof of global impossibility.' };
}

const results = [];
if (!selected || selected === 'attack') results.push(search('attack BMain', [-23.6, 1.00001, -50]));
if (!selected || selected === 'defend') results.push(search('defend CT', [-5.7, 1.003405, -95]));
const report = { sourceTriangles: world.stats.triangleCount, results };
fs.writeFileSync(new URL('./ascent-path-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2)); world.dispose();
