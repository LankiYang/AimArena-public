import { app } from './app.ts';
import { toast } from './ui/overlay.ts';
import type { S2C } from '../shared/lobby.ts';

const LOCAL_KEY = 'aimarena.friends.v1';
const CODE = /^[0-9A-F]{16}$/;
const PENDING_LIMIT = 100;
const OPERATION_LIMIT = 16;
type Friend = { code: string; name: string };
type RecordData = { v: 1; owner: string; code: string; friends: Friend[] };
type Identity = { owner: string; cloud: boolean };

async function identity(): Promise<Identity> {
  return { owner: '', cloud: false };
}
function randomCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function parse(raw: string, id: Identity): RecordData {
  let value: RecordData;
  try { value = JSON.parse(raw); } catch { throw new Error('好友存档损坏，已停止写入，请勿覆盖原数据'); }
  if (!value || value.v !== 1 || value.owner !== id.owner || typeof value.code !== 'string' || !CODE.test(value.code) || !Array.isArray(value.friends) || value.friends.length > 100 ||
      value.friends.some(f => !f || typeof f.code !== 'string' || !CODE.test(f.code) || f.code === value.code || typeof f.name !== 'string' || f.name.length > 16) ||
      new Set(value.friends.map(f => f.code)).size !== value.friends.length) {
    throw new Error('好友存档无效或不属于当前账号，已停止写入');
  }
  return value;
}
async function readRecord(id: Identity): Promise<RecordData | null> {
  const raw = localStorage.getItem(LOCAL_KEY);
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error('好友存档无效，已停止写入');
  return parse(raw, id);
}
async function saveRecord(id: Identity, data: RecordData) {
  const raw = JSON.stringify(data);
  localStorage.setItem(LOCAL_KEY, raw);
  if (localStorage.getItem(LOCAL_KEY) !== raw) throw new Error('本机存档未确认保存');
}

class Friends {
  data: RecordData | null = null;
  source = '';
  error = '';
  requests: Friend[] = [];
  unsaved: Friend[] = [];
  invites: (Friend & { roomId: string })[] = [];
  online = new Set<string>();
  registered = false;
  private registration = '';
  private id: Identity | null = null;
  private listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private saving = new Set<string>();
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const fn of this.listeners) fn(); }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queued >= OPERATION_LIMIT) return Promise.reject(new Error('好友操作排队已满，请等待当前操作完成后重试'));
    this.queued++;
    const result = this.queue.then(() => navigator.locks ? navigator.locks.request('aimarena-friends-storage', fn) : fn());
    this.queue = result.then(() => { this.queued--; }, () => { this.queued--; });
    return result;
  }
  private fail(e: unknown) {
    this.error = e instanceof Error ? e.message : '好友服务请求失败';
    this.emit();
    toast(this.error);
  }
  async load() {
    return this.enqueue(async () => {
      try {
        const id = await identity();
        if (this.id && (this.id.owner !== id.owner || this.id.cloud !== id.cloud)) {
          this.data = null; this.registered = false; this.registration = ''; this.requests = []; this.invites = []; this.unsaved = []; this.online.clear();
        }
        this.id = id;
        let data = await readRecord(id);
        if (!data) {
          data = { v: 1, owner: id.owner, code: randomCode(), friends: [] };
          await saveRecord(id, data);
        }
        const check = await identity();
        if (check.owner !== id.owner || check.cloud !== id.cloud) throw new Error('账号已切换，请重新打开好友面板');
        this.data = data;
        this.source = id.cloud ? 'B站玩家云存档' : '本机存档（换设备不共享）';
        this.error = '';
        if (app.conn?.status === 'open' && this.registration !== data.code) {
          this.registration = data.code;
          app.conn.send({ t: 'socialRegister', code: data.code });
        }
        this.emit();
      } catch (e) { this.data = null; this.registered = false; this.registration = ''; this.fail(e); }
    }).catch(e => { this.fail(e); });
  }
  private async mutate(change: (data: RecordData) => void) {
    return this.enqueue(async () => {
      try {
        const id = await identity();
        if (!this.id || !this.data || id.owner !== this.id.owner || id.cloud !== this.id.cloud) throw new Error('账号已切换，请重新打开好友面板');
        const data = await readRecord(id);
        if (!data || data.code !== this.data.code) throw new Error('好友存档已变化，请重新打开好友面板');
        change(data);
        await saveRecord(id, data);
        this.data = data; this.error = ''; this.emit();
        return true;
      } catch (e) { this.fail(e); return false; }
    }).catch(e => { this.fail(e); return false; });
  }
  remove(code: string) { return this.mutate(data => { data.friends = data.friends.filter(f => f.code !== code); }); }
  private send(msg: { t: 'socialRequest' | 'socialAccept' | 'socialInvite'; code: string } | { t: 'socialPresence'; codes: string[] }) {
    void this.enqueue(async () => {
      try {
        const id = await identity();
        if (!this.id || id.owner !== this.id.owner || id.cloud !== this.id.cloud) throw new Error('账号已切换，请重新打开好友面板');
        if (!this.registered || app.conn?.status !== 'open') throw new Error('好友服务未连接，请稍后重试');
        if (msg.t === 'socialInvite' && !app.room) throw new Error('请先进入房间');
        app.conn.send(msg);
      } catch (e) { this.fail(e); }
    }).catch(e => { this.fail(e); });
  }
  request(code: string) {
    code = code.trim().toUpperCase();
    if (!CODE.test(code) || code === this.data?.code) { toast('请输入对方的 16 位好友码'); return; }
    if (this.data?.friends.some(f => f.code === code)) { toast('该玩家已在好友列表中'); return; }
    this.send({ t: 'socialRequest', code });
  }
  accept(code: string) {
    if (this.unsaved.length >= PENDING_LIMIT && !this.unsaved.some(f => f.code === code)) {
      toast('待保存好友已满，请先处理后再同意申请'); return;
    }
    this.send({ t: 'socialAccept', code });
  }
  invite(code: string) { if (!app.room) { toast('请先进入房间'); return; } this.send({ t: 'socialInvite', code }); }
  refresh() {
    if (!this.data) { toast('好友存档未就绪'); return; }
    this.send({ t: 'socialPresence', codes: this.data.friends.map(f => f.code) });
  }
  disconnected() {
    this.registered = false; this.registration = ''; this.requests = []; this.invites = []; this.online.clear(); this.emit();
  }
  onMessage(msg: S2C) {
    switch (msg.t) {
      case 'welcome':
        this.registered = false; this.registration = ''; this.requests = []; this.invites = []; this.online.clear();
        void this.load(); break;
      case 'socialRegistered':
        if (msg.code === this.data?.code) { this.registered = true; this.emit(); }
        break;
      case 'socialError': if (!this.registered) this.registration = ''; this.error = msg.message; this.emit(); toast(msg.message); break;
      case 'socialRequest':
        if (!this.requests.some(r => r.code === msg.code) && this.requests.length >= PENDING_LIMIT) {
          toast('待处理好友申请已满，无法显示新申请'); break;
        }
        this.requests = [...this.requests.filter(r => r.code !== msg.code), { code: msg.code, name: msg.name }];
        this.emit(); toast(`收到 ${msg.name} 的好友申请`); break;
      case 'socialRequestCancelled':
        this.requests = this.requests.filter(r => r.code !== msg.code);
        this.emit(); break;
      case 'socialAccepted':
        this.requests = this.requests.filter(r => r.code !== msg.code);
        if (!this.unsaved.some(f => f.code === msg.code) && this.unsaved.length >= PENDING_LIMIT) {
          this.emit(); toast('待保存好友已满，此好友未保存，请清理后重新申请'); break;
        }
        this.unsaved = [...this.unsaved.filter(f => f.code !== msg.code), { code: msg.code, name: msg.name }];
        this.emit();
        void this.saveAccepted(msg.code).catch(e => this.fail(e));
        break;
      case 'socialPresence': this.online = new Set(msg.online); this.emit(); break;
      case 'socialInvite':
        if (!this.invites.some(i => i.code === msg.code) && this.invites.length >= PENDING_LIMIT) {
          toast('房间邀请已满，无法显示新邀请'); break;
        }
        this.invites = [...this.invites.filter(i => i.code !== msg.code), { code: msg.code, name: msg.name, roomId: msg.roomId }];
        this.emit(); toast(`收到 ${msg.name} 的房间邀请`); break;
    }
  }
  async saveAccepted(code: string) {
    if (this.saving.has(code)) return;
    const friend = this.unsaved.find(f => f.code === code);
    if (!friend) return;
    this.saving.add(code);
    try {
      const ok = await this.mutate(data => {
        if (!CODE.test(friend.code) || friend.code === data.code || typeof friend.name !== 'string' || friend.name.length > 16) throw new Error('收到无效好友资料');
        const existing = data.friends.find(f => f.code === friend.code);
        if (existing) existing.name = friend.name;
        else { if (data.friends.length >= 100) throw new Error('好友列表已满'); data.friends.push(friend); }
      });
      if (ok) {
        if (this.unsaved.includes(friend)) this.unsaved = this.unsaved.filter(f => f !== friend);
        this.emit();
        toast('已保存好友；对方存档结果需由对方确认', 'ok');
      }
    } finally {
      this.saving.delete(code);
    }
  }
  dismissUnsaved(code: string) {
    if (this.saving.has(code)) { toast('该好友正在保存，请等待保存结束'); return; }
    this.unsaved = this.unsaved.filter(f => f.code !== code); this.emit();
  }
  dismissInvite(code: string) { this.invites = this.invites.filter(i => i.code !== code); this.emit(); }
}
export const friends = new Friends();
