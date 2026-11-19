'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameServer, loadAscentWorld, rayBox, overlapsWorld, MAP } = require('./server.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(url, join) {
  const ws = new WebSocket(url), messages = [];
  ws.addEventListener('message', e => messages.push(JSON.parse(e.data)));
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const client = {
    ws, messages, send: data => ws.send(JSON.stringify(data)),
    async wait(predicate, after = 0, timeout = 2500) {
      const until = Date.now() + timeout;
      while (Date.now() < until) { const message = messages.slice(after).find(predicate); if (message) return message; await delay(10); }
      assert.fail('Timed out waiting for WebSocket response; recent messages: ' + JSON.stringify(messages.slice(-3)));
    },
    async command(command, predicate) { const after = messages.length; this.send(command); return this.wait(predicate, after); }
  };
  client.send({ type: 'join', ...join });
  client.welcome = await client.wait(m => m.type === 'welcome');
  return client;
}

test('map has traversable gates, body collision and shared sites', () => {
  assert.ok(MAP.boxes.length > 35);
  assert.equal(MAP.sites.length, 2);
  assert.equal(overlapsWorld(-25, -7), false, 'A arch must be traversable below the lintel');
  assert.equal(overlapsWorld(0, -16), false, 'Mid arch must be traversable');
  assert.equal(overlapsWorld(-24, 12), true, 'Buildings must stop movement');
  assert.equal(overlapsWorld(0, 29), false, 'Attacker spawn is clear');
  for (const team of Object.values(MAP.spawns)) for (const p of team) assert.equal(overlapsWorld(p.x, p.z), false, 'All spawn positions must be clear');
  assert.equal(rayBox({ x: 0, y: 1, z: 4 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0, w: 2, h: 2, d: 2 }), 3);
});

test('two real WebSocket clients: authoritative movement, buy, skills, blocked shots, kill and next round', async t => {
  const game = createGameServer({ readyMs: 70, durations: { buy: 5000, live: 20000, end: 250 } });
  t.after(() => game.close()); const address = await game.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${address.port}`;
  const a = await connect(url, { name: 'ATTACK', room: 'integration', team: 'attack', agent: 'jett' });
  await a.wait(m => m.type === 'snapshot' && m.phase === 'waiting');
  const preview = await a.command({ type: 'ability', skill: 'smoke' }, m => m.type === 'event' && m.event === 'ability'); assert.equal(preview.skill, 'smoke');
  const b = await connect(url, { name: 'DEFEND', room: 'integration', team: 'defend', agent: 'sage' });
  await b.wait(m => m.type === 'snapshot' && m.phase === 'buy');
  const room = game.rooms.get('integration'), pa = room.players.get(a.welcome.selfId), pb = room.players.get(b.welcome.selfId);
  assert.equal(pa.team, 'attack'); assert.equal(pb.team, 'defend'); assert.equal(room.bomb.carrierId, pa.id);
  const health = await (await fetch(`http://127.0.0.1:${address.port}/health`)).json(); assert.equal(health.players, 2);
  const world = await (await fetch(`http://127.0.0.1:${address.port}/world.json`)).json(); assert.equal(world.boxes.length, MAP.boxes.length);
  await a.command({ type: 'buy', weapon: 'phantom' }, m => m.type === 'event' && m.event === 'purchase'); assert.equal(pa.weapon, 'phantom'); assert.equal(pa.credits, 5100);
  await a.command({ type: 'buy', weapon: 'armor' }, m => m.type === 'event' && m.event === 'purchase' && m.weapon === 'armor'); assert.equal(pa.armor, 50);
  a.send({ type: 'ready' }); await a.wait(m => m.type === 'snapshot' && m.phase === 'live');
  const start = { x: pa.x, z: pa.z };
  a.send({ type: 'input', seq: 1, dt: 999, moveX: 9999, moveZ: -9999, yaw: 0, pitch: 0, jump: false });
  await delay(130);
  assert.ok(Math.hypot(pa.x - start.x, pa.z - start.z) <= 1, 'Client dt and huge movement cannot create a speed hack');
  assert.equal(pa.ackSeq, 1);
  const prior = pa.x; a.send({ type: 'input', seq: 0, moveX: -1, moveZ: 0, yaw: 0, pitch: 0 }); await delay(30); assert.ok(pa.x >= prior, 'Old input sequence must be rejected');
  a.send({ type: 'input', seq: 2, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, crouch: true }); await delay(30); assert.equal(pa.crouch, true);
  // Deterministic position fixtures isolate hit validation; all game commands still travel over real sockets.
  Object.assign(pa, { x: 0, y: 0, z: 8, crouch: false, input: null, history: [] });
  Object.assign(pb, { x: 0, y: 0, z: -20, crouch: false, history: [] });
  // A dedicated world wall lies between players: use the left wine-shop footprint.
  Object.assign(pa, { x: -24, z: 22 }); Object.assign(pb, { x: -24, z: 2 }); await delay(35);
  const hp = pb.hp; await a.command({ type: 'fire', yaw: 0, pitch: 0, shotId: 'blocked' }, m => m.type === 'event' && m.event === 'shot' && m.shotId === 'blocked'); assert.equal(pb.hp, hp, 'Server geometry must block hits through buildings');
  const oldZ = pa.z; await a.command({ type: 'ability', skill: 'dash' }, m => m.type === 'event' && m.event === 'ability' && m.skill === 'dash'); assert.ok(pa.z > 18.8 && pa.z <= oldZ, 'Dash must stop against the building');
  Object.assign(pa, { x: 0, y: 0, z: 0, crouch: false, input: null, history: [], lastFire: 0 }); Object.assign(pb, { x: 0, y: 0, z: -4, hp: 100, armor: 0, crouch: false, history: [] }); await delay(35);
  await a.command({ type: 'fire', yaw: 0, pitch: Math.atan2(-0.7, 4), shotId: 'hit-1' }, m => m.type === 'event' && m.event === 'hit'); assert.equal(pb.hp, 61);
  await b.command({ type: 'ability', skill: 'heal' }, m => m.type === 'event' && m.event === 'ability' && m.skill === 'heal'); assert.equal(pb.hp, 100);
  const hpAfterHeal = pb.hp; b.send({ type: 'ability', skill: 'heal' }); await delay(25); assert.equal(pb.hp, hpAfterHeal, 'Heal cooldown must be server-owned');
  await delay(100); await a.command({ type: 'fire', yaw: 0, pitch: Math.atan2(-0.7, 4) }, m => m.type === 'event' && m.event === 'hit' && m.hp === 61);
  await delay(90); await a.command({ type: 'fire', yaw: 0, pitch: 0 }, m => m.type === 'event' && m.event === 'kill');
  assert.equal(pb.alive, false); assert.equal(room.phase, 'end'); assert.equal(room.score.attack, 1);
  await a.wait(m => m.type === 'snapshot' && m.phase === 'buy' && m.round === 2); assert.equal(pb.hp, 100); assert.equal(pb.alive, true);
  for (const resource of ['/server.cjs', '/server.test.cjs', '/shared/world.cjs', '/docs/TECH-RESEARCH.md', '/README.md', '/ASSETS.md', '/package.json', '/pnpm-lock.yaml', '/research/ascentB-original.bin', '/node_modules/ws/index.js', '/node_modules/three/package.json', '/assets/%2e%2e/server.cjs']) {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${resource}`, { method: 'HEAD' })).status, 403, resource + ' must stay private');
  }
  for (const resource of ['/index.html', '/style.css', '/src/main.js', '/node_modules/three/build/three.module.js', '/node_modules/three/examples/jsm/loaders/GLTFLoader.js']) {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${resource}`, { method: 'HEAD' })).status, 200, resource + ' must remain public');
  }
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/index.html`, { method: 'POST' })).status, 405);
});

test('two real WebSocket clients: plant hold, cancellation, defuse and explosion win', async t => {
  const game = createGameServer({ readyMs: 40, durations: { buy: 5000, live: 20000, end: 150, plant: 130, defuse: 150, bomb: 700 } });
  t.after(() => game.close()); const address = await game.listen(0, '127.0.0.1'), url = `ws://127.0.0.1:${address.port}`;
  const a = await connect(url, { name: 'A', room: 'bomb', team: 'attack', agent: 'jett' }); const b = await connect(url, { name: 'B', room: 'bomb', team: 'defend', agent: 'sage' });
  const room = game.rooms.get('bomb'), pa = room.players.get(a.welcome.selfId), pb = room.players.get(b.welcome.selfId);
  a.send({ type: 'ready' }); await a.wait(m => m.type === 'snapshot' && m.phase === 'live');
  Object.assign(pa, { x: -25, z: -11, input: null }); Object.assign(pb, { x: -27, z: -11, input: null });
  await a.command({ type: 'interact', action: 'start' }, m => m.type === 'event' && m.event === 'plantStart'); a.send({ type: 'interact', action: 'stop' }); await delay(40); assert.equal(room.bomb.state, 'carried');
  await a.command({ type: 'interact', action: 'start' }, m => m.type === 'event' && m.event === 'plantStart'); await a.wait(m => m.type === 'event' && m.event === 'plant'); assert.equal(room.bomb.state, 'planted'); assert.equal(pa.hasBomb, false);
  await b.command({ type: 'interact', action: 'start' }, m => m.type === 'event' && m.event === 'defuseStart'); await b.wait(m => m.type === 'event' && m.event === 'defuse'); assert.equal(room.score.defend, 1); assert.equal(room.lastResult.reason, 'defused');
  await a.wait(m => m.type === 'snapshot' && m.phase === 'buy' && m.round === 2); a.send({ type: 'ready' }); const after = a.messages.length; await a.wait(m => m.type === 'snapshot' && m.phase === 'live' && m.round === 2, after);
  Object.assign(pa, { x: 25, z: -11, input: null }); Object.assign(pb, { x: 29, z: -23, input: null });
  await a.command({ type: 'interact', action: 'start' }, m => m.type === 'event' && m.event === 'plantStart'); const result = await a.wait(m => m.type === 'event' && m.event === 'roundEnd' && m.reason === 'exploded'); assert.equal(result.winner, 'attack'); assert.equal(room.score.attack, 1);
});

test('malformed and prototype-key purchases cannot corrupt state or stall another socket', async t => {
  const game = createGameServer({ durations: { buy: 20000 } });
  t.after(() => game.close()); const address = await game.listen(0, '127.0.0.1'), url = `ws://127.0.0.1:${address.port}`;
  const attacker = await connect(url, { name: '<script>bad</script>', room: 'adversarial', team: 'attack', agent: 'jett' });
  const other = await connect(url, { name: 'OTHER', room: 'adversarial', team: 'defend', agent: 'sage' });
  const room = game.rooms.get('adversarial'), pa = room.players.get(attacker.welcome.selfId), pb = room.players.get(other.welcome.selfId);
  const credits = pa.credits;
  for (const weapon of ['__proto__', 'constructor', 'toString', 'not-a-gun']) {
    await attacker.command({ type: 'buy', weapon }, m => m.type === 'error' && m.code === 'WEAPON');
    assert.equal(pa.credits, credits); assert.equal(pa.weapon, 'phantom'); assert.equal(pa.ammo, 30);
  }
  attacker.ws.send('{bad json'); await attacker.wait(m => m.type === 'error' && m.code === 'MESSAGE');
  attacker.send({ type: 'input', seq: 1, moveX: null, moveZ: 0, yaw: 0, pitch: 0 }); await delay(30);
  assert.equal(pa.inputSeq, -1, 'Non-finite movement must not be adopted');
  // Skills are forbidden during buy. In waiting mode, Sage must still be unable to use Jett smoke.
  const solo = await connect(url, { room: 'agent-validation', agent: 'sage', team: 'attack' });
  await solo.command({ type: 'ability', skill: 'smoke' }, m => m.type === 'error' && m.code === 'ABILITY');
  assert.equal(game.rooms.get('agent-validation').smokes.length, 0);
  const tickBefore = (await (await fetch(`http://127.0.0.1:${address.port}/health`)).json()).tick;
  const started = performance.now();
  for (let i = 0; i < 400; i++) attacker.send({ type: 'input', seq: i + 2, moveX: 1, moveZ: 1, yaw: 0, pitch: 0, dt: 1e12 });
  await other.command({ type: 'ping', clientTime: 12345 }, m => m.type === 'pong' && m.clientTime === 12345);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, 'One bounded burst must not prevent another client receiving a pong');
  await delay(70);
  const health = await (await fetch(`http://127.0.0.1:${address.port}/health`)).json();
  assert.ok(health.tick > tickBefore); assert.equal(health.players, 3); assert.equal(pb.hp, 100);
  assert.ok(Number.isFinite(pa.x) && Number.isFinite(pa.z) && Number.isFinite(pa.credits));
  assert.ok(pa.inputSeq < 401, 'Per-connection burst limit must discard excess inputs');
  console.log(`Bounded 400-message burst: independent socket pong ${elapsed.toFixed(1)}ms; not a concurrency benchmark.`);
});

test('agent basics: Jett updraft, Sage slow, ice-wall collision and shooting blocks apart', async t => {
  const game = createGameServer({ readyMs: 40, durations: { buy: 5000, live: 20000 } });
  t.after(() => game.close()); const address = await game.listen(0, '127.0.0.1'), url = `ws://127.0.0.1:${address.port}`;
  const jett = await connect(url, { name: 'JETT', room: 'basics', team: 'attack', agent: 'jett' });
  const sage = await connect(url, { name: 'SAGE', room: 'basics', team: 'defend', agent: 'sage' });
  const room = game.rooms.get('basics'), pj = room.players.get(jett.welcome.selfId), ps = room.players.get(sage.welcome.selfId);
  await jett.command({ type: 'buy', weapon: 'vandal' }, m => m.type === 'error' && m.code === 'WEAPON');
  jett.send({ type: 'ready' }); await jett.wait(m => m.type === 'snapshot' && m.phase === 'live');
  Object.assign(pj, { x: 0, y: 0, z: -3, vy: 0, grounded: true, input: null }); Object.assign(ps, { x: 0, y: 0, z: 8, yaw: 0, input: null });
  await jett.command({ type: 'ability', skill: 'updraft' }, m => m.type === 'event' && m.event === 'ability' && m.skill === 'updraft'); await delay(65);
  assert.ok(pj.y > 0.25, 'Updraft must apply authoritative upward velocity'); assert.ok(pj.abilityCooldowns.updraft > Date.now());
  Object.assign(pj, { x: 0, y: 0, z: -3, vy: 0, grounded: true });
  await sage.command({ type: 'ability', skill: 'slow', x: 0, z: -3 }, m => m.type === 'event' && m.event === 'ability' && m.skill === 'slow'); assert.equal(room.slows[0].radius, 4.5);
  jett.send({ type: 'input', seq: 1, moveX: 1, moveZ: 0, yaw: 0, pitch: 0 }); const xBefore = pj.x; await delay(140);
  assert.ok(pj.x - xBefore < 0.5, 'Enemy slow field must reduce movement'); jett.send({ type: 'input', seq: 2, moveX: 0, moveZ: 0, yaw: 0, pitch: 0 }); await delay(25);
  Object.assign(pj, { x: 0, z: -3, input: null });
  const wallEvent = await sage.command({ type: 'ability', skill: 'wall' }, m => m.type === 'event' && m.event === 'ability' && m.skill === 'wall');
  assert.equal(wallEvent.barriers.length, 4); assert.ok(room.barriers.every(b => b.hp === 400));
  const { movePlayer } = require('./server.cjs'); movePlayer(ps, 0, -8); assert.ok(ps.z > 3.6, 'Wall must block the authoritative movement capsule');
  const beforeHP = ps.hp; const block = room.barriers.find(b => Math.abs(b.x) <= b.w / 2); assert.ok(block); block.hp = 39;
  await jett.command({ type: 'fire', yaw: Math.PI, pitch: 0, shotId: 'ice' }, m => m.type === 'event' && m.event === 'wallBreak');
  assert.equal(room.barriers.length, 3); assert.equal(ps.hp, beforeHP, 'Wall must absorb a bullet before it reaches a player');
  ps.abilityCooldowns.wall = 0; Object.assign(ps, { x: 0, y: 0, z: 8, yaw: 0, input: null }); Object.assign(pj, { x: -0.825, z: 3, input: null });
  await sage.command({ type: 'ability', skill: 'wall' }, m => m.type === 'error' && m.code === 'WALL_BLOCKED');
  const state = await sage.wait(m => m.type === 'snapshot' && m.barriers?.length === 3 && m.slows?.length === 1); assert.equal(state.players.find(p => p.id === pj.id).weapon, 'phantom');
});

test('Ascent B: actual source floor, room map lock, precise socket movement/rays and one-site round', async t => {
  const ascentWorld = await loadAscentWorld();
  const game = createGameServer({ ascentWorld, readyMs: 40, durations: { buy: 5000, live: 20000, plant: 120, defuse: 150, bomb: 1000 } });
  t.after(() => game.close()); const address = await game.listen(0, '127.0.0.1'), url = `ws://127.0.0.1:${address.port}`;
  const a = await connect(url, { name: 'SOURCE-A', room: 'source', team: 'attack', agent: 'jett', map: 'ascent-b' });
  const b = await connect(url, { name: 'SOURCE-B', room: 'source', team: 'defend', agent: 'sage', map: 'ascent-b' });
  assert.equal(a.welcome.mapId, 'ascent-b'); assert.equal(a.welcome.world.collision, 'triangle'); assert.equal(a.welcome.world.boxes.length, 0);
  const room = game.rooms.get('source'), pa = room.players.get(a.welcome.selfId), pb = room.players.get(b.welcome.selfId);
  const other = new WebSocket(url); t.after(() => other.close()); await new Promise(resolve => other.addEventListener('open', resolve, { once: true }));
  const mismatch = new Promise(resolve => other.addEventListener('message', e => resolve(JSON.parse(e.data)), { once: true })); other.send(JSON.stringify({ type: 'join', room: 'source', map: 'ascent-study' })); assert.equal((await mismatch).code, 'MAP_MISMATCH');
  const data = await (await fetch(`http://127.0.0.1:${address.port}/world.json?map=ascent-b`)).json(); assert.equal(data.id, 'ascent-b'); assert.equal(data.triangleCount, 192209); assert.equal(data.sites.length, 1); assert.equal(data.sites[0].id, 'B');
  a.send({ type: 'ready' }); await a.wait(m => m.type === 'snapshot' && m.mapId === 'ascent-b' && m.phase === 'live');
  const start = { x: pa.x, y: pa.y, z: pa.z };
  a.send({ type: 'input', seq: 1, moveX: 0, moveZ: -1, yaw: 0, pitch: 0 }); await delay(140); a.send({ type: 'input', seq: 2, moveX: 0, moveZ: 0, yaw: 0, pitch: 0 }); await delay(35);
  assert.ok(pa.z < start.z - 0.3 && pa.z > start.z - 1.1, 'Socket movement must advance on exact source floor'); assert.ok(pa.grounded); assert.ok(Math.abs(pa.y - 1) < 0.03);
  const origin = { x: pa.x, y: pa.y + 1.62, z: pa.z }, wall = ascentWorld.raycast(origin, { x: 1, y: 0, z: 0 }, 100); assert.ok(wall && wall.distance < 2, 'BMain east wall fixture exists in original mesh');
  const shot = await a.command({ type: 'fire', yaw: Math.PI / 2, pitch: 0, shotId: 'source-wall' }, m => m.type === 'event' && m.event === 'shot' && m.shotId === 'source-wall');
  assert.ok(Math.abs(shot.end.x - wall.position.x) < 0.02, 'Server ray must stop on the exact original triangle'); assert.equal(pb.hp, 100);
  a.send({ type: 'input', seq: 3, moveX: 1, moveZ: 0, yaw: Math.PI / 2, pitch: 0 }); await delay(180); a.send({ type: 'input', seq: 4, moveX: 0, moveZ: 0, yaw: Math.PI / 2, pitch: 0 }); await delay(35);
  assert.ok(pa.x <= wall.position.x - 0.29, 'Capsule must stop before the original wall');
  await a.command({ type: 'ability', skill: 'updraft' }, m => m.type === 'event' && m.event === 'ability' && m.skill === 'updraft'); await delay(75); assert.ok(pa.y > 1.15 && pa.walker.velocity.y > 0);
  const dashY = pa.y; await a.command({ type: 'ability', skill: 'dash' }, m => m.type === 'event' && m.event === 'ability' && m.skill === 'dash'); assert.ok(pa.x < wall.position.x - 0.2, 'Swept dash cannot tunnel through source wall'); assert.ok(pa.y > dashY - 0.1, 'Dash must not integrate an extra second of gravity');
  const site = data.sites[0]; Object.assign(pa, { x: site.x, y: site.y, z: site.z, vy: 0, input: null }); ascentWorld.sync(pa); Object.assign(pb, { x: site.x - 2, y: site.y, z: site.z, vy: 0, input: null }); ascentWorld.sync(pb); await delay(70);
  await a.command({ type: 'interact', action: 'start' }, m => m.type === 'event' && m.event === 'plantStart'); await a.wait(m => m.type === 'event' && m.event === 'plant'); assert.ok(Math.abs(room.bomb.y - site.y) < 0.1, 'Spike must keep the real source floor height');
  await b.command({ type: 'interact', action: 'start' }, m => m.type === 'event' && m.event === 'defuseStart'); await b.wait(m => m.type === 'event' && m.event === 'roundEnd' && m.reason === 'defused'); assert.equal(room.score.defend, 1);
  const final = await b.wait(m => m.type === 'snapshot' && m.mapId === 'ascent-b' && m.phase === 'end'); assert.ok(final.players.every(p => Number.isFinite(p.vy) && Number.isFinite(p.speed) && typeof p.grounded === 'boolean'));
});
