import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { APP_BASE_PATH, GAME_DIR, mimeOf } from './paths.ts';
import { startBundler, getBundleFile } from './bundle.ts';
import { attachGameServer } from './net.ts';
import { checkWorldCaches } from './world-cache-check.ts';
import { loadWorld } from './world.ts';
import { loadNav, navCachePath } from './nav.ts';
import type { MapId } from '../shared/catalog.ts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 5173);
const host = process.env.HOST ?? '127.0.0.1';
const dev = process.env.DEV !== '0';

async function buildCache(map: MapId): Promise<void> {
  const worker = new Worker(new URL('./world-worker.ts', import.meta.url), {
    workerData: { map, mode: 'build' }, execArgv: process.execArgv,
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let result: { ok: boolean; error?: string } | undefined;
  worker.once('message', message => { result = message; });
  worker.once('error', reject);
  worker.once('exit', code => {
    if (code !== 0) reject(new Error(`${map}: world builder exited with code ${code}`));
    else if (!result?.ok) reject(new Error(result?.error ?? `${map}: world builder returned no result`));
    else resolve();
  });
  await promise;
}

await startBundler(dev);
for (const status of await checkWorldCaches()) {
  if (status.state !== 'ok') {
    await buildCache(status.map);
    await fs.promises.rm(navCachePath(status.map), { force: true });
  }
  if (!fs.existsSync(navCachePath(status.map))) await loadNav(await loadWorld(status.map));
}

const index = await fs.promises.readFile(path.join(GAME_DIR, 'client', 'index.html'));
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const requested = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (APP_BASE_PATH && requested === APP_BASE_PATH) {
      res.writeHead(308, { location: `${APP_BASE_PATH}/` }).end();
      return;
    }
    if (APP_BASE_PATH && !requested.startsWith(`${APP_BASE_PATH}/`)) {
      res.writeHead(404).end();
      return;
    }
    const route = APP_BASE_PATH ? requested.slice(APP_BASE_PATH.length) : requested;
    if (route === '/healthz') { res.writeHead(200).end(req.method === 'HEAD' ? undefined : 'ok'); return; }
    const bundle = await getBundleFile(route);
    if (bundle) {
      res.writeHead(200, { 'content-type': bundle.type, 'content-length': bundle.body.length, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bundle.body);
      return;
    }
    if (route === '/' || !path.posix.extname(route)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': index.length, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : index);
      return;
    }
    const prefix = route.startsWith('/data/') ? '/data/' : '/';
    const root = prefix === '/data/' ? path.join(GAME_DIR, 'data') : path.join(GAME_DIR, 'client', 'public');
    const file = path.resolve(root, `.${route.slice(prefix.length - 1)}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
    try {
      const body = await fs.promises.readFile(file);
      res.writeHead(200, { 'content-type': mimeOf(file), 'content-length': body.length, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      res.writeHead(404).end();
    }
  } catch (error) {
    console.error('[http]', error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
attachGameServer(server);
server.listen(port, host, () => console.log(`AimArena listening on ${host}:${port}`));
