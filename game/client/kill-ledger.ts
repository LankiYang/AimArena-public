// kill-ledger.ts — 服务器累计战绩 → 本设备贡献 → Toy 累计击杀总榜。
// 不在击杀回调里调用 SDK。每台设备一个云端 G-counter，合并各设备贡献后上报绝对分数；
// 本地 journal 先写入再上传，网络超时/重复结算不会把同一份击杀加两遍。
import type { MatchStats } from '../shared/lobby.ts';
import type { ToyApi, ToyScoreApi } from './toy.ts';

export const KILL_BOARD = 1;
export const MAX_TOY_SCORE = 16777215;
export const KILL_DEVICE_PREFIX = 'aim_kills_v1_';
const PENDING_PREFIX = 'aimarena.kills.pending.v1.';
export interface DeviceKills { v: 1; nonce: string; total: number }
interface Journal { v: 1; total: number; marks: Record<string, number>; needsRank: boolean }
interface Progress { kills: number; deaths: number; accounted: number }
export interface KillSyncState {
  status: 'idle' | 'syncing' | 'synced' | 'unsupported' | 'rate-limit' | 'error';
  message: string;
  total: number;
  sessionKills: number;
  sessionDeaths: number;
}
export interface KillLedgerDeps {
  api: () => ToyApi | null;
  deviceKey: string;
  uuid: () => string;
  storage?: Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'length' | 'key' | 'removeItem'>>;
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
}
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= MAX_TOY_SCORE;
const scoreApi = (a: ToyApi | null): a is ToyScoreApi => !!a &&
  typeof a.getCloudStorage === 'function' && typeof a.setCloudStorage === 'function' && typeof a.submitScore === 'function';

export function parseDeviceKills(raw: string | undefined): DeviceKills | null {
  if (raw === undefined) return null;
  const d = JSON.parse(raw);
  if (d?.v !== 1 || typeof d.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(d.nonce) || !isCount(d.total)) {
    throw new Error('击杀存档格式异常，已停止覆盖，请稍后重试');
  }
  return d;
}
export function aggregateDeviceKills(items: Record<string, string>): number {
  let total = 0;
  for (const [key, raw] of Object.entries(items)) {
    if (!key.startsWith(KILL_DEVICE_PREFIX)) continue;
    total = Math.min(MAX_TOY_SCORE, total + (parseDeviceKills(raw)?.total ?? 0));
  }
  return total;
}
export function toyErrorMessage(error: unknown): string {
  const e = error as { type?: string; code?: number; message?: string };
  if (e?.type === 'http_error' && Number(e.code) === 307044) return '平台请求较多，正在退避重试；击杀尚未全部同步，请不要关闭页面';
  if (Number(e?.code) === -101 || /login|登录/i.test(String(e?.type) + String(e?.message))) return '请先登录 B 站，再点刷新同步击杀';
  if (/denied|cancel|授权|拒绝/i.test(String(e?.type) + String(e?.message))) return '排行榜授权未完成；同意平台确认后可重试，游戏不受影响';
  if (e?.type === 'unsupported' || /toy id|toy_id/i.test(String(e?.message))) return '当前预览或浏览器未提供排行榜能力，请在正式 B 站 Toy 页面重试';
  if (e?.message?.includes('账号已切换') || e?.message?.includes('存档格式异常') || e?.message?.includes('本地战绩缓存')) return e.message;
  return '击杀同步失败，已保留本次页面的待同步记录；请点刷新重试，成功前不要关闭页面';
}

export class KillLedger {
  private progress = new Map<string, Progress>();
  private active = '';
  private nonce: string | null = null;
  private journals = new Map<string, Journal>();
  private dirty = false;
  private lastSubmitted = 0;
  private flight: Promise<boolean> | null = null;
  private preparing: Promise<boolean> | null = null;
  private requested = false;
  private forceRead = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private retryAfter = 0;
  private listeners = new Set<() => void>();
  private state_: KillSyncState = { status: 'idle', message: '在退出对局、打开榜单或页面隐藏时同步', total: 0, sessionKills: 0, sessionDeaths: 0 };
  private readonly d: KillLedgerDeps;
  constructor(d: KillLedgerDeps) { this.d = d; }
  get state(): KillSyncState { return { ...this.state_ }; }
  get hasPending() { return this.dirty; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify() { for (const fn of this.listeners) fn(); }

  /** 输入只能来自服务器 matchStats；caller 还必须核对 you === 当前连接的 myId。 */
  observe(s: MatchStats): boolean {
    if (!s || typeof s.matchId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(s.matchId) ||
        !Number.isSafeInteger(s.you) || s.you <= 0 || !isCount(s.kills) || !isCount(s.deaths)) return false;
    const key = `${s.matchId}.${s.you}`;
    const p = this.progress.get(key) ?? { kills: 0, deaths: 0, accounted: 0 };
    const changed = s.kills > p.kills;
    p.kills = Math.max(p.kills, s.kills);
    p.deaths = Math.max(p.deaths, s.deaths);
    this.progress.set(key, p);
    if (!s.final || !this.active) this.active = key;
    if (key === this.active) {
      this.state_.sessionKills = p.kills;
      this.state_.sessionDeaths = p.deaths;
    }
    if (changed) {
      this.dirty = true;
      if (this.nonce) this.backupProgress(this.nonce, key, p.kills);
      if (this.state_.status === 'idle' || this.state_.status === 'synced') {
        this.state_.status = 'idle';
        this.state_.message = '有新击杀待同步，打开榜单或退出对局时自动保存';
      }
    }
    this.notify();
    // final 是正常离开/释放前的最后一份权威值；零变化时 flush 不会访问平台。
    if (s.final) void this.flush('settlement');
    return changed;
  }

  noteRemoteScore(score: number) {
    if (!isCount(score)) return;
    this.lastSubmitted = Math.max(this.lastSubmitted, score);
    this.state_.total = Math.max(this.state_.total, score);
  }

  /** 进入对局时只准备一次账号隔离标签；不阻塞加载，不触发排行榜得分授权。 */
  prepare(): Promise<boolean> {
    if (this.preparing) return this.preparing;
    if ((this.d.now ?? Date.now)() < this.retryAfter) return Promise.resolve(false);
    this.preparing = this.d.withLock(async () => {
      const api = this.d.api();
      if (!scoreApi(api)) return false;
      let device = parseDeviceKills((await api.getCloudStorage([this.d.deviceKey]))[this.d.deviceKey]);
      if (this.nonce && device?.nonce !== this.nonce) throw new Error('B 站账号已切换，请刷新页面后重新开始；旧账号战绩不会转入新账号');
      if (!device) {
        const initial: DeviceKills = { v: 1, nonce: this.d.uuid(), total: 0 };
        await api.setCloudStorage({ [this.d.deviceKey]: JSON.stringify(initial) });
        device = parseDeviceKills((await api.getCloudStorage([this.d.deviceKey]))[this.d.deviceKey]);
        if (!device) throw new Error('击杀存档格式异常，设备记录未落盘');
      }
      this.nonce = device.nonce;
      for (const [key, p] of this.progress) if (p.kills > p.accounted) this.backupProgress(device.nonce, key, p.kills);
      const j = this.readJournal(device.nonce, device.total);
      this.dirty ||= j.needsRank || j.total > device.total || this.collectPending(device.nonce).length > 0;
      return true;
    }).catch(error => {
      const e = error as { type?: string; code?: number };
      const limited = e?.type === 'http_error' && Number(e.code) === 307044;
      this.state_.status = limited ? 'rate-limit' : 'error';
      this.state_.message = limited ? '平台暂时限流，稍后打开榜单重试；游戏不受影响' : toyErrorMessage(error);
      if (limited) this.retryAfter = (this.d.now ?? Date.now)() + 1000 * (1 + (this.d.random ?? Math.random)());
      this.notify();
      return false;
    }).finally(() => { this.preparing = null; });
    return this.preparing;
  }

  flush(reason: 'settlement' | 'menu' | 'hidden' | 'disconnect' | 'leaderboard' | 'retry' = 'settlement'): Promise<boolean> {
    this.requested = true;
    this.forceRead ||= reason === 'leaderboard' || reason === 'retry';
    if (this.flight) return this.flight;
    const now = (this.d.now ?? Date.now)();
    if (now < this.retryAfter) return Promise.resolve(false);
    if (!this.dirty && !this.forceRead) { this.requested = false; return Promise.resolve(true); }
    this.flight = (async () => {
      let ok = true;
      do {
        this.requested = false;
        const force = this.forceRead;
        this.forceRead = false;
        try { await this.d.withLock(() => this.syncOnce(force)); }
        catch (error) {
          ok = false;
          this.requested = false;
          this.state_.message = toyErrorMessage(error);
          const e = error as { type?: string; code?: number };
          const limited = e?.type === 'http_error' && Number(e.code) === 307044;
          this.state_.status = limited ? 'rate-limit' : 'error';
          if (limited) {
            this.failures++;
            // 这是错误后的指数退避，不是平台 QPS 阈值，也没有后台榜单轮询。
            const delay = 1000 * 2 ** Math.min(4, this.failures - 1) * (1 + (this.d.random ?? Math.random)());
            this.retryAfter = (this.d.now ?? Date.now)() + delay;
            if (this.failures <= 4 && !this.retry) this.retry = (this.d.schedule ?? setTimeout)(() => {
              this.retry = null;
              void this.flush('retry');
            }, delay);
            else this.state_.message = '平台仍在限流，自动重试已暂停；已保留记录，请稍后手动刷新';
          }
          this.notify();
        }
      } while (this.requested && ok);
      return ok;
    })().finally(() => { this.flight = null; });
    return this.flight;
  }

  /** 本地备份是每连接独立键，写入同步完成；不调用 SDK，也不竞争设备总数。 */
  private backupProgress(nonce: string, key: string, kills: number) {
    try { this.d.storage?.setItem(PENDING_PREFIX + nonce + '.' + key, String(kills)); } catch { /* 隐私/存储满时保留内存，关键节点照常尝试云同步。 */ }
  }
  private collectPending(nonce: string): [string, Progress][] {
    const found = new Map([...this.progress.entries()].filter(([, p]) => p.kills > p.accounted));
    const s = this.d.storage, prefix = PENDING_PREFIX + nonce + '.';
    if (s?.key && typeof s.length === 'number') try {
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (!key?.startsWith(prefix)) continue;
        const scope = key.slice(prefix.length), raw = s.getItem(key);
        if (!/^[A-Za-z0-9_-]{1,100}\.[1-9][0-9]*$/.test(scope) || !raw || !/^[0-9]+$/.test(raw)) continue;
        const kills = Number(raw);
        if (!isCount(kills) || !kills) continue;
        const p = found.get(scope) ?? { kills: 0, deaths: 0, accounted: 0 };
        p.kills = Math.max(p.kills, kills);
        found.set(scope, p);
      }
    } catch { /* 受限存储：已有内存进度仍可结算。 */ }
    return [...found.entries()];
  }

  private readJournal(nonce: string, baseline: number): Journal {
    const cached = this.journals.get(nonce);
    let saved: Journal | null = null;
    try {
      const v = JSON.parse(this.d.storage?.getItem(`aimarena.kills.v1.${nonce}`) ?? 'null');
      if (v?.v === 1 && isCount(v.total) && v.marks && typeof v.marks === 'object') {
        const marks: Record<string, number> = {};
        for (const [key, n] of Object.entries(v.marks)) if (isCount(n)) marks[key] = n;
        saved = { v: 1, total: v.total, marks, needsRank: v.needsRank === true };
      }
    } catch { /* 存储被禁用/旧本地数据损坏：以云端与当前内存为准，不阻止正常游玩。 */ }
    const marks = { ...saved?.marks };
    for (const [key, n] of Object.entries(cached?.marks ?? {})) marks[key] = Math.max(marks[key] ?? 0, n);
    return {
      v: 1,
      total: Math.max(baseline, saved?.total ?? 0, cached?.total ?? 0),
      marks,
      needsRank: !!saved?.needsRank || !!cached?.needsRank,
    };
  }
  private saveJournal(nonce: string, j: Journal) {
    const compact = { ...j, marks: Object.fromEntries(Object.entries(j.marks).slice(-64)) };
    this.journals.set(nonce, compact);
    try {
      this.d.storage?.setItem(`aimarena.kills.v1.${nonce}`, JSON.stringify(compact));
      return !!this.d.storage;
    } catch { return false; /* 内存仍保留；失败提示明确要求同步后再关闭。 */ }
  }

  private async syncOnce(force: boolean) {
    if (!this.dirty && !force) return;
    const api = this.d.api();
    if (!scoreApi(api)) {
      this.state_.status = 'unsupported';
      this.state_.message = '请在 B 站 Toy 中使用排行榜；普通网页仍可正常游玩';
      this.notify();
      return;
    }
    this.state_.status = 'syncing';
    this.state_.message = '正在合并累计击杀…';
    this.notify();
    const items = await api.getCloudStorage([this.d.deviceKey]);
    let device = parseDeviceKills(items[this.d.deviceKey]);
    if (this.nonce && device?.nonce !== this.nonce) throw new Error('B 站账号已切换或设备存档不存在，请刷新页面后开始新的对局；旧账号记录不会转入新账号');
    let pending = [...this.progress.entries()].filter(([, p]) => p.kills > p.accounted);
    if (!device && pending.length) {
      // 先建立当前 SDK 账号下的设备身份，再写本地 journal；不把 A 账号的本地分数转给 B。
      const initial: DeviceKills = { v: 1, nonce: this.d.uuid(), total: 0 };
      await api.setCloudStorage({ [this.d.deviceKey]: JSON.stringify(initial) });
      device = parseDeviceKills((await api.getCloudStorage([this.d.deviceKey]))[this.d.deviceKey]);
      if (!device) throw new Error('击杀存档格式异常，设备记录未落盘');
    }
    if (device && this.nonce && device.nonce !== this.nonce) throw new Error('B 站账号已切换，请刷新页面后开始新的对局；旧账号记录不会转入新账号');
    let journal: Journal | null = null;
    if (device) {
      this.nonce = device.nonce;
      pending = this.collectPending(device.nonce);
      journal = this.readJournal(device.nonce, device.total);
      let delta = 0;
      for (const [key, p] of pending) {
        delta += Math.max(0, p.kills - Math.max(p.accounted, journal.marks[key] ?? 0));
        journal.marks[key] = Math.max(journal.marks[key] ?? 0, p.kills);
      }
      journal.total = Math.min(MAX_TOY_SCORE, journal.total + delta);
      journal.needsRank ||= delta > 0 || journal.total > device.total;
      const backedUp = this.saveJournal(device.nonce, journal); // 总量与消费进度一起保存。
      // 已存在持久化单局备份时，journal 写失败不能先上传再留下旧备份，
      // 否则此时硬关闭页面会在下一次把同一份贡献重复相加。完全禁用存储时仍可用内存同步。
      if (!backedUp && pending.some(([key]) => {
        try { return this.d.storage?.getItem(PENDING_PREFIX + device.nonce + '.' + key) != null; } catch { return false; }
      })) throw new Error('本地战绩缓存暂时无法保存；已保留待同步记录，请释放存储空间后重试，游戏不受影响');
      for (const [key, p] of pending) {
        p.accounted = Math.max(p.accounted, journal.marks[key] ?? 0);
        // 先持久化设备 journal，再移除已合并的单局备份；配额满时不删除唯一副本。
        if (backedUp && this.d.storage?.removeItem) try {
          const pendingKey = PENDING_PREFIX + device.nonce + '.' + key;
          const current = Number(this.d.storage.getItem(pendingKey) ?? 0);
          if (current <= p.accounted) this.d.storage.removeItem(pendingKey);
        } catch {}
      }
      this.dirty = journal.needsRank;
      if (journal.total > device.total) {
        await api.setCloudStorage({ [this.d.deviceKey]: JSON.stringify({ ...device, total: journal.total }) });
      }
    }
    // 不把别的设备的总数作为本设备基数；所有设备的贡献相加，避免换设备重复累加。
    const total = aggregateDeviceKills(await api.getCloudStorage([]));
    if (journal?.needsRank && total > this.lastSubmitted && total > 0) {
      const result = await api.submitScore({ board: KILL_BOARD, score: total });
      if (!isCount(result?.score) || result.score < total) throw new Error('排行榜未确认本次成绩');
      this.lastSubmitted = Math.max(this.lastSubmitted, result.score);
    }
    if (journal && device) {
      journal.needsRank = false;
      this.saveJournal(device.nonce, journal);
    }
    this.dirty = [...this.progress.values()].some(p => p.kills > p.accounted);
    this.failures = 0;
    this.retryAfter = 0;
    if (this.retry) (this.d.cancel ?? clearTimeout)(this.retry);
    this.retry = null;
    this.state_.total = Math.max(total, this.lastSubmitted);
    this.state_.status = 'synced';
    this.state_.message = this.state_.total >= MAX_TOY_SCORE ? '已同步，已达到平台积分上限' : '累计击杀已同步到 B 站';
    this.notify();
  }

  dispose() {
    if (this.retry) (this.d.cancel ?? clearTimeout)(this.retry);
    this.retry = null;
    this.listeners.clear();
  }
}
