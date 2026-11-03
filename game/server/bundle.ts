// bundle.ts — 用 esbuild 把 game/client/main.ts 打成 /app.js + /app.css（内存里，不落盘）
//   开发模式（默认）：监听源码变化自动重打；DEV=0 时只打一次并压缩
import path from 'node:path';
import * as esbuild from 'esbuild';
import { GAME_DIR } from './paths.ts';

export type BundleFile = { body: Buffer; type: string; etag: string };
const files = new Map<string, BundleFile>();
let lastError = '';
let ready: Promise<void>;

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function startBundler(dev: boolean): Promise<void> {
  const { promise, resolve: resolveFirst, reject: rejectFirst } = Promise.withResolvers<void>();
  ready = promise;
  let first = true;
  const capture: esbuild.Plugin = {
    name: 'capture',
    setup(build) {
      build.onEnd((r) => {
        if (r.errors.length) {
          lastError = r.errors.map((e) => `${e.location?.file}:${e.location?.line} ${e.text}`).join('\n');
          console.error('[bundle] 构建失败\n' + lastError);
        } else {
          lastError = '';
          for (const f of r.outputFiles ?? []) {
            const name = '/' + path.basename(f.path);
            files.set(name, {
              body: Buffer.from(f.contents),
              type: TYPES[path.extname(name)] ?? 'application/octet-stream',
              etag: `"${f.hash}"`,
            });
          }
          console.log(`[bundle] ${[...files.keys()].join(' ')} 已更新`);
        }
        if (first) {
          first = false;
          if (r.errors.length) rejectFirst(new Error(`Client bundle failed:\n${lastError}`));
          else resolveFirst();
        }
      });
    },
  };
  const opts: esbuild.BuildOptions = {
    entryPoints: {
      app: path.join(GAME_DIR, 'client', 'main.ts'),
    },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: path.join(GAME_DIR, '.cache', 'bundle'),
    write: false,
    sourcemap: dev ? 'linked' : false,
    minify: !dev,
    loader: { '.svg': 'text' },
    // 字体、镜像素材都由服务器直接提供，CSS 里的 url() 不参与打包
    external: ['fonts/*', '/fonts/*', '/cdn/*', '/data/*'],
    define: { __DEV__: JSON.stringify(dev) },
    logLevel: 'silent',
    plugins: [capture],
  };
  void (async () => {
    const ctx = await esbuild.context(opts);
    if (dev) await ctx.watch();
    else {
      await ctx.rebuild();
      await ctx.dispose();
    }
  })().catch((error) => rejectFirst(error instanceof Error ? error : new Error(String(error))));
  return ready;
}

export async function getBundleFile(name: string): Promise<BundleFile | null> {
  await ready;
  if (lastError && name === '/app.js') {
    // 构建失败时把错误显示在页面上，而不是给一个旧版本让人摸不着头脑
    const js = `document.body.innerHTML='<pre style="color:#f66;padding:20px;white-space:pre-wrap">'+${JSON.stringify(
      '构建失败：\n' + lastError,
    )}.replace(/</g,'&lt;')+'</pre>'`;
    return { body: Buffer.from(js), type: TYPES['.js'], etag: '"err"' };
  }
  return files.get(name) ?? null;
}
