// toy-leaderboard.ts — SDK 适配、按需读榜与生命周期同步；不轮询、不逐次击杀请求。
import type { MatchStats } from '../shared/lobby.ts';
import { getToyApi, type ToyMyRank, type ToyRankItem } from './toy.ts';
import { KILL_BOARD, KILL_DEVICE_PREFIX, KillLedger, MAX_TOY_SCORE, toyErrorMessage, type KillSyncState } from './kill-ledger.ts';
import { selectedServerId } from './server-target.ts';

const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
  // 旧 WebView 仍有 getRandomValues；这里的随机标记不是登录凭据。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
};
const locks = navigator.locks;
let storage: Storage | undefined;
try { storage = localStorage; } catch { /* 隐私模式仍能只用云端/内存游玩。 */ }
// Web Locks 保护同一设备多个标签页的 journal。旧 WebView 没有锁时按标签页分片，
// 不能让两个标签页各自覆盖同一个贡献值；sessionStorage 使标签页刷新后仍能找回分片。
const deviceStore = (() => { try { return locks ? localStorage : sessionStorage; } catch { return undefined; } })();
const deviceStorageKey = locks ? 'aimarena.kills.device.v1' : 'aimarena.kills.tab.v1';
let deviceId = '';
try { deviceId = deviceStore?.getItem(deviceStorageKey) ?? ''; } catch {}
if (!/^[a-f0-9]{32}$/.test(deviceId)) {
  deviceId = uuid();
  try { deviceStore?.setItem(deviceStorageKey, deviceId); } catch {}
}
const ledger = new KillLedger({
  api: getToyApi,
  deviceKey: KILL_DEVICE_PREFIX + deviceId,
  uuid,
  storage,
  withLock: (fn) => locks ? locks.request(`aimarena-kills-${deviceId}`, fn) : fn(),
});

export interface KillBoardView {
  list: ToyRankItem[];
  mine: ToyMyRank | null;
  error: string;
}
let cached: (KillBoardView & { syncedTotal: number }) | null = null;
let reading: Promise<KillBoardView> | null = null;
let readRetryAfter = 0;
let readFailures = 0;
const validScore = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= MAX_TOY_SCORE;
const TEST_STATE: KillSyncState = { status: 'unsupported', message: '测试服战绩不计入正式击杀榜', total: 0, sessionKills: 0, sessionDeaths: 0 };

export const killLeaderboard = {
  get state() { return selectedServerId() === 'production' ? ledger.state : { ...TEST_STATE }; },
  subscribe: (fn: () => void) => ledger.subscribe(fn),
  observe: (s: MatchStats) => selectedServerId() === 'production' ? ledger.observe(s) : false,
  prepare: () => selectedServerId() === 'production' ? ledger.prepare() : Promise.resolve(false),
  flush: (reason: Parameters<KillLedger['flush']>[0]) => selectedServerId() === 'production' ? ledger.flush(reason) : Promise.resolve(false),
  async load(force = false): Promise<KillBoardView> {
    if (selectedServerId() !== 'production') return { list: [], mine: null, error: '测试服不显示正式击杀榜，测试战绩不会上传' };
    if (reading) return reading;
    if (!force && !ledger.hasPending && cached && cached.syncedTotal === ledger.state.total) return cached;
    if (Date.now() < readRetryAfter) return { list: cached?.list ?? [], mine: cached?.mine ?? null, error: '平台暂时限流，已保留现有榜单；请稍后再点刷新' };
    const api = getToyApi();
    if (typeof api?.getRankList !== 'function' || typeof api?.getMyRank !== 'function') {
      return { list: [], mine: null, error: '请在 B 站 Toy 中查看击杀榜；普通网页仍可正常游玩' };
    }
    reading = (async () => {
      await ledger.flush('leaderboard');
      if (ledger.state.status === 'rate-limit') return { list: cached?.list ?? [], mine: cached?.mine ?? null, error: ledger.state.message };
      // 两个独立的只读接口并行；游客读榜失败不应被个人排名的登录要求遮蔽。
      const [listResult, myResult] = await Promise.allSettled([
        api.getRankList!({ board: KILL_BOARD, period: 'all', limit: 50 }),
        api.getMyRank!({ board: KILL_BOARD, period: 'all' }),
      ]);
      const errors: string[] = [];
      const fail = (e: unknown) => {
        const err = e as { type?: string; code?: number };
        if (err?.type === 'http_error' && Number(err.code) === 307044) {
          readRetryAfter = Date.now() + 1000 * 2 ** Math.min(5, readFailures++) * (1 + Math.random());
        }
        errors.push(toyErrorMessage(e));
      };
      let list = cached?.list ?? [];
      if (listResult.status === 'fulfilled') {
        if (!Array.isArray(listResult.value)) fail(new Error('排行榜响应格式异常'));
        else list = listResult.value.filter(r => Number.isSafeInteger(r.rank) && r.rank > 0 && validScore(r.score))
          .map(r => ({ rank: r.rank, score: r.score, nickname: String(r.nickname ?? '玩家'), avatar: String(r.avatar ?? '') }));
      } else fail(listResult.reason);
      let mine: ToyMyRank | null = null;
      if (myResult.status === 'fulfilled') {
        const m = myResult.value;
        if (typeof m?.ranked === 'boolean' && validScore(m.score) && Number.isSafeInteger(m.rank) && m.rank >= 0) {
          mine = m;
          ledger.noteRemoteScore(m.score);
        } else fail(new Error('个人排名响应格式异常'));
      } else fail(myResult.reason);
      if (!errors.length) { readRetryAfter = 0; readFailures = 0; }
      const result = { list, mine, error: [...new Set(errors)].join('；'), syncedTotal: ledger.state.total };
      // 错误不是有效缓存：重开面板可重试，但限流仍必须等退避时间。
      if (!errors.length) cached = result;
      return result;
    })().finally(() => { reading = null; });
    return reading;
  },
};

let installed = false;
export function installKillLeaderboard() {
  if (installed) return;
  installed = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void killLeaderboard.flush('hidden');
  });
  window.addEventListener('pagehide', () => { void killLeaderboard.flush('hidden'); });
}
