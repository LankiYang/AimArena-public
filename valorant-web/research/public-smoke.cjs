'use strict';
// UTF-8. One bounded, authorized public endpoint smoke test. TLS validation stays enabled.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const WebSocket = require('ws');
const { parseArgs } = require('node:util');

const args = parseArgs({ options: { map: { type: 'string' }, base: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
if (args.values.help) {
  console.log('Usage: node research/public-smoke.cjs [--map ascent-b|ascent-study] [--base https://new-tunnel.example]\nDefault map: ascent-b; default endpoint: http://localhost:3000. HTTPS keeps certificate validation enabled.');
  process.exit(0);
}
const endpoint = new URL(args.values.base || 'http://localhost:3000');
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Endpoint must be an HTTP(S) origin without credentials');
const base = endpoint.origin;
const mapId = args.values.map || args.positionals[0] || 'ascent-b';
if (!['ascent-b', 'ascent-study'].includes(mapId) || args.positionals.length > 1) throw new Error('Expected map ascent-b or ascent-study; use --help for usage');
const room = ('SMK' + Date.now().toString(36) + randomBytes(3).toString('hex')).toUpperCase();
const result = { startedAt: new Date().toISOString(), endpoint: base, mapId, room, tlsValidation: true, checks: [], sockets: [], passed: false };
const clients = [];
let movementTimer;

function httpRequest(method, pathname) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = (endpoint.protocol === 'https:' ? https : http).request(new URL(pathname, base), { method, rejectUnauthorized: true, timeout: 15000, headers: { 'user-agent': 'valorant-web-authorized-smoke/0.1', accept: '*/*' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ method, path: pathname, status: res.statusCode, contentType: res.headers['content-type'] || '', contentLength: res.headers['content-length'] || null, elapsedMs: Date.now() - started, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${pathname} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

function until(predicate, description, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const socketError = clients.find(c => c.error)?.error;
      if (socketError) { clearInterval(timer); reject(socketError); return; }
      try { if (predicate()) { clearInterval(timer); resolve(); } }
      catch (error) { clearInterval(timer); reject(error); }
      if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error(`Timed out waiting for ${description}`)); }
    }, 40);
  });
}

function connect(name, team, agent) {
  const client = { name, team, agent, welcome: null, snapshot: null, snapshots: 0, events: [], error: null, closeCode: null };
  const ws = client.ws = new WebSocket(base.replace(/^http/, 'ws'), { rejectUnauthorized: true, handshakeTimeout: 15000 });
  clients.push(client);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, room, team, agent, map: mapId })));
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); }
    catch { client.error = new Error('Invalid JSON from WebSocket'); return; }
    if (message.type === 'welcome') client.welcome = message;
    if (message.type === 'snapshot') { client.snapshot = message; client.snapshots++; }
    if (message.type === 'event') client.events.push(message.event);
    if (message.type === 'error') client.error = new Error(`Server rejected ${name}: ${message.code || ''} ${message.message || ''}`);
  });
  ws.on('error', error => { client.error = error; });
  ws.on('close', code => { client.closeCode = code; });
  return client;
}

function send(client, message) { assert.equal(client.ws.readyState, WebSocket.OPEN); client.ws.send(JSON.stringify(message)); }

async function close(client) {
  if (client.ws.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { client.ws.terminate(); resolve(); }, 2500);
    client.ws.once('close', () => { clearTimeout(timer); resolve(); });
    if (client.ws.readyState === WebSocket.OPEN) client.ws.close(1000, 'authorized smoke test completed');
    else if (client.ws.readyState === WebSocket.CONNECTING) client.ws.terminate();
  });
}

(async () => {
  try {
    const checks = await Promise.allSettled([
      httpRequest('GET', '/health'),
      httpRequest('GET', '/world.json?map=' + encodeURIComponent(mapId)),
      ...['/', '/showcase.html', '/src/main.js', '/assets/agents/jett.glb', ...(mapId === 'ascent-b' ? ['/src/ascent-collision.mjs', '/assets/maps/ascent-b.glb'] : [])].map(p => httpRequest('HEAD', p))
    ]);
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i];
      if (check.status === 'rejected') { result.checks.push({ kind: 'http', passed: false, error: String(check.reason) }); continue; }
      const data = check.value;
      if (data.path === '/health') {
        try { data.health = JSON.parse(data.body); } catch { data.health = null; }
        data.passed = data.status === 200 && data.health?.ok === true;
      } else if (data.path.startsWith('/world.json?')) {
        try { data.world = JSON.parse(data.body); } catch { data.world = null; }
        data.passed = data.status === 200 && data.world?.id === mapId;
        if (data.world) data.world = { id: data.world.id, collision: data.world.collision, sites: data.world.sites?.map(s => s.id), triangleCount: data.world.triangleCount };
      } else data.passed = data.status === 200;
      delete data.body;
      result.checks.push({ kind: 'http', ...data });
    }
    assert.ok(result.checks.every(c => c.passed), 'One or more HTTP checks failed');

    const a = connect('PUBLIC_SMOKE_A', 'attack', 'jett');
    const b = connect('PUBLIC_SMOKE_B', 'defend', 'sage');
    await until(() => clients.every(c => c.welcome && c.snapshot?.players.length === 2 && ['buy', 'live'].includes(c.snapshot.phase)), 'both welcome messages and shared two-player snapshots');
    assert.notEqual(a.welcome.selfId, b.welcome.selfId);
    for (const c of clients) {
      assert.equal(c.welcome.room, room);
      assert.equal(c.snapshot.room, room);
      assert.equal(c.welcome.mapId, mapId);
      assert.equal(c.snapshot.mapId, mapId);
      assert.equal(c.snapshot.players.find(p => p.id === c.welcome.selfId).team, c.team);
    }
    result.checks.push({ kind: 'websocket', name: 'two real sockets join selected map on opposite teams', passed: true, mapId, phase: a.snapshot.phase, players: a.snapshot.players.map(p => ({ id: p.id, team: p.team, agent: p.agent })) });

    send(a, { type: 'ready' }); send(b, { type: 'ready' });
    await until(() => clients.every(c => c.snapshot?.phase === 'live'), 'ready transitions to live', 10000);
    result.checks.push({ kind: 'websocket', name: 'ready advances buy to live', passed: true, round: a.snapshot.round });

    const origin = a.snapshot.players.find(p => p.id === a.welcome.selfId);
    const startPosition = { x: origin.x, y: origin.y, z: origin.z };
    const movement = mapId === 'ascent-b' ? { moveX: 0, moveZ: -1 } : { moveX: 1, moveZ: 0 };
    let seq = 0;
    movementTimer = setInterval(() => send(a, { type: 'input', seq: ++seq, ...movement, yaw: 0, pitch: 0, jump: false, walk: false, crouch: false }), 50);
    await until(() => {
      const own = a.snapshot.players.find(p => p.id === a.welcome.selfId);
      const remote = b.snapshot.players.find(p => p.id === a.welcome.selfId);
      return own.ackSeq >= 1 && Math.hypot(own.x - startPosition.x, own.z - startPosition.z) > 0.1 && Math.hypot(remote.x - startPosition.x, remote.z - startPosition.z) > 0.1;
    }, 'server acknowledges movement and replicates it to peer', 6000);
    clearInterval(movementTimer); movementTimer = null;
    send(a, { type: 'input', seq: ++seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0 });
    const moved = a.snapshot.players.find(p => p.id === a.welcome.selfId);
    const peerMoved = b.snapshot.players.find(p => p.id === a.welcome.selfId);
    assert.ok([moved.x, moved.y, moved.z, peerMoved.x, peerMoved.y, peerMoved.z].every(Number.isFinite));
    if (mapId === 'ascent-b') assert.ok(Math.abs(moved.y - 1) < 0.15, 'BMain movement must stay on actual source floor');
    result.checks.push({ kind: 'websocket', name: 'authoritative movement replicated to peer', passed: true, from: startPosition, own: { x: moved.x, y: moved.y, z: moved.z, ackSeq: moved.ackSeq }, peer: { x: peerMoved.x, y: peerMoved.y, z: peerMoved.z } });
    result.passed = true;
  } catch (error) {
    result.error = { name: error.name, message: error.message, code: error.code || null };
  } finally {
    if (movementTimer) clearInterval(movementTimer);
    await Promise.all(clients.map(close));
    result.sockets = clients.map(c => ({ name: c.name, team: c.team, agent: c.agent, snapshots: c.snapshots, closeCode: c.closeCode, closed: c.ws.readyState === WebSocket.CLOSED, events: [...new Set(c.events)] }));
    result.allTestConnectionsClosed = result.sockets.every(s => s.closed);
    if (!result.allTestConnectionsClosed) result.passed = false;
    try { const health = await httpRequest('GET', '/health'); result.healthAfterCleanup = { status: health.status, ...JSON.parse(health.body) }; } catch (error) { result.cleanupHealthError = error.message; }
    result.finishedAt = new Date().toISOString();
    const destination = path.resolve(__dirname, '../artifacts/public-smoke.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  }
})();
