// lobby.ts — 大厅：玩家会话、房间列表、房间内的队伍/人机/设置/开局
import { randomInt } from 'node:crypto';
import type { C2S, Member, RoomInfo, RoomSettings, RoomSummary, S2C } from '../shared/lobby.ts';
import { DEFAULT_SETTINGS, SCORE_LIMITS } from '../shared/lobby.ts';
import type { AgentId, Team } from '../shared/catalog.ts';
import { AGENTS, MAX_TEAM_SIZE, isAgentId, isDifficulty, isMapId, isMode } from '../shared/catalog.ts';
import type { WeaponId } from '../shared/combat.ts';
import { isBuyItem, type BuyItem } from '../shared/economy.ts';
import { isWeaponId } from '../shared/sim/weapons.ts';
import { MAP_ROPE_REVISION } from '../shared/rope.ts';

const MAP_UPDATE_MESSAGE = '天界浮岛已更新，请刷新页面或更新客户端后再进入';
const compatibleMap = (c: Client | undefined, map: RoomSettings['map']) => map !== 'ascent' || c?.mapRopeRevision === MAP_ROPE_REVISION;

export interface Client {
  id: number;
  name: string;
  agent: AgentId;
  /** 客户端 hello 里的构建号；用于按版本下发不同的战斗同步格式 */
  build: string;
  /** Negotiated map-rope data revision; absent for legacy clients. */
  mapRopeRevision?: number;
  roomId: string | null;
  session?: string | null;
  /** 已断线、座位还在宽限期内：不再收发消息，等同一会话的新连接来接回 */
  parked?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** 最近输错房间号的时间（限速用） */
  misses?: number[];
  send(msg: S2C): void;
  sendBinary(buf: Uint8Array): void;
  /** 对局里收到的二进制帧交给谁处理 */
  onBinary: ((buf: Uint8Array) => void) | null;
  /** 关掉这条连接（同一会话被新连接接管时用；code 4000 = 已在别处继续，客户端不再自动重连） */
  close?(code?: number): void;
}

/** 房间里正在进行的对局需要实现的接口（由 match.ts 提供） */
export interface MatchHandle {
  playerLoaded(clientId: number): void;
  playerLeft(clientId: number): void;
  /** 中途加入：真人顶掉一个人机位（或直接坐到空位）。replaceBotId 是房间要移除的人机 */
  joinPlayer?(member: Member, replaceBotId: number | null): void;
  /** 掉线的真人在宽限期内接回：角色原地未动，只把输入通道接回新连接 */
  resumePlayer?(clientId: number): void;
  /** 换枪（阶段5，可选：老的对局实现 / 测试里的 mock 工厂不必实现） */
  selectWeapon?(clientId: number, weapon: WeaponId): void;
  /** 购买（阶段9 经济，SND，可选）：余额 / 购买窗 / 槽位由 match 校验并回发 buyResult */
  buy?(clientId: number, item: BuyItem): void;
  /** 观战切换目标（阶段11，可选）：dir = +1 下一个 / -1 上一个；只有阵亡后受理，
   *  存活 / 观战席 / 没有存活队友一律忽略（不报错，防刷屏） */
  spectate?(clientId: number, dir: 1 | -1): void;
  /** 测试用（createMatch 的 manual 选项）：手动推进 n 个 tick；ready() 为真表示世界与导航都已就绪 */
  advance?(ticks: number): void;
  ready?(): boolean;
  /** Synchronize lobby-owned membership and client metadata with an isolated match. */
  sync?(): void;
  dispose(): void;
}
export type MatchFactory = (room: Room, lobby: Lobby) => MatchHandle;

const BOT_NAMES = ['Kilo', 'Vex', 'Rook', 'Nyx', 'Atlas', 'Moth', 'Zed', 'Echo', 'Pike', 'Sable', 'Ivy', 'Bolt', 'Rune', 'Jinx', 'Onyx'];

/** 房间号字母表：去掉 0/O、1/I/L 这类容易看错、念错的字符 */
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ROOM_CODE_LENGTH = 6;

/** 掉线后座位保留多久（毫秒）；测试可用环境变量 ROOM_GRACE_MS 缩短 */
export const DEFAULT_GRACE_MS = 30_000;
/** 一分钟内连续输错房间号超过这个次数就暂停（防止枚举房间号） */
const JOIN_MISS_LIMIT = 10;
const JOIN_MISS_WINDOW_MS = 60_000;
/** 会话标识（客户端 sessionStorage 里生成的随机串）：同一标签页刷新 / 断网重连时用来认回原座位 */
export const isSessionToken = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);

const isSocialCode = (code: unknown): code is string =>
  typeof code === 'string' && code.length === 16 && /^[0-9A-F]{16}$/.test(code);
const SOCIAL_LIMIT = 100;
const SOCIAL_RATE_LIMIT = 60;
const SOCIAL_RATE_WINDOW_MS = 10_000;
type SocialMessage = Extract<C2S, { t: 'socialRegister' | 'socialRequest' | 'socialAccept' | 'socialPresence' | 'socialInvite' }>;

/** 设置项在系统消息里的叫法（房主改了哪些项要说清楚） */
const SETTING_LABELS: [keyof RoomSettings, string][] = [
  ['mode', '模式'],
  ['map', '地图'],
  ['teamSize', '规模'],
  ['scoreLimit', '目标'],
  ['fillBots', '自动补人机'],
  ['botDifficulty', '人机难度'],
];

export class Room {
  id: string;
  name: string;
  hostId: number;
  priv: boolean;
  settings: RoomSettings;
  members: Member[] = [];
  state: RoomInfo['state'] = 'waiting';
  match: MatchHandle | null = null;
  /** 建房先后（只用于快速加入时「先建的优先」，不对外显示） */
  order = 0;
  private nextBotId = -1;

  constructor(id: string, name: string, hostId: number, priv: boolean, settings: RoomSettings) {
    this.id = id;
    this.name = name;
    this.hostId = hostId;
    this.priv = priv;
    this.settings = settings;
  }

  humans() {
    return this.members.filter((m) => !m.bot);
  }
  teamCount(team: Team) {
    return this.members.filter((m) => m.team === team).length;
  }
  /** 人少的那队；一样多给红方 */
  openTeam(): Team | -1 {
    const a = this.teamCount(0), b = this.teamCount(1), n = this.settings.teamSize;
    if (a >= n && b >= n) return -1;
    if (a >= n) return 1;
    if (b >= n) return 0;
    return b < a ? 1 : 0;
  }

  addBot(team: Team, difficulty = this.settings.botDifficulty): Member | null {
    if (this.teamCount(team) >= this.settings.teamSize) return null;
    const used = new Set(this.members.map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has('BOT ' + n)) ?? 'X' + -this.nextBotId;
    // 优先选本队还没人用的特工
    const usedAgents = this.members.filter((m) => m.team === team).map((m) => m.agent);
    const free = AGENTS.filter((a) => !usedAgents.includes(a.id));
    const pool = free.length ? free : AGENTS;
    const agent = pool[Math.abs(this.nextBotId * 7) % pool.length].id;
    const m: Member = { id: this.nextBotId--, name: 'BOT ' + name, bot: true, team, agent, ready: true, difficulty };
    this.members.push(m);
    return m;
  }

  /**
   * 给要加入的真人选一个位置：优先真人少的队；两队都满时踢掉这个人少的队的一个人机腾位。
   * 返回 null = 没位置（只能坐观战席）。等待中与对局中都适用。
   */
  seatFor(): { team: Team; replace: Member | null } | null {
    const n = this.settings.teamSize;
    const humansOf = (t: Team) => this.members.filter((m) => !m.bot && m.team === t).length;
    const botsOf = (t: Team) => this.members.filter((m) => m.bot && m.team === t);
    const order: Team[] = humansOf(0) <= humansOf(1) ? [0, 1] : [1, 0];
    for (const t of order) if (this.teamCount(t) < n) return { team: t, replace: null };
    for (const t of order) {
      const bot = botsOf(t)[0];
      if (bot) return { team: t, replace: bot };
    }
    return null;
  }

  /** 开局前按设置用人机补满两队（给 team 就只补那一队） */
  fillBots(team?: Team) {
    for (const t of team === undefined ? ([0, 1] as Team[]) : [team])
      while (this.teamCount(t) < this.settings.teamSize) if (!this.addBot(t)) break;
  }

  /** 人数上限变小时，把多出来的人机踢掉、玩家挪去观战 */
  trimTeams() {
    for (const t of [0, 1] as Team[]) {
      let over = this.teamCount(t) - this.settings.teamSize;
      for (let i = this.members.length - 1; i >= 0 && over > 0; i--) {
        const m = this.members[i];
        if (m.team !== t) continue;
        if (m.bot) this.members.splice(i, 1);
        else m.team = -1;
        over--;
      }
    }
  }

  info(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      priv: this.priv,
      settings: this.settings,
      members: this.members,
      state: this.state,
    };
  }

  summary(): RoomSummary {
    const host = this.members.find((m) => m.id === this.hostId);
    return {
      id: this.id,
      name: this.name,
      mode: this.settings.mode,
      map: this.settings.map,
      humans: this.humans().length,
      bots: this.members.length - this.humans().length,
      max: this.settings.teamSize * 2,
      state: this.state,
      host: host?.name ?? '',
      joinable: this.seatFor() !== null,
    };
  }
}

const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const cleanName = (s: unknown, fallback: string) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 16) || fallback;

export function mergeSettings(base: RoomSettings, p: Partial<RoomSettings> | undefined): RoomSettings {
  const s = { ...base };
  if (!p || typeof p !== 'object') return s;
  if (isMode(p.mode) && p.mode !== s.mode) {
    s.mode = p.mode;
    s.scoreLimit = p.mode === 'tdm' ? 50 : p.mode === 'snd' ? 7 : 1;
  }
  if (isMapId(p.map)) s.map = p.map;
  if (p.teamSize !== undefined) s.teamSize = clampInt(p.teamSize, 1, MAX_TEAM_SIZE, s.teamSize);
  if (p.scoreLimit !== undefined) {
    const opts = SCORE_LIMITS[s.mode];
    const n = clampInt(p.scoreLimit, opts[0], opts[opts.length - 1], s.scoreLimit);
    s.scoreLimit = opts.includes(n) ? n : opts[1];
  }
  if (typeof p.fillBots === 'boolean') s.fillBots = p.fillBots;
  if (isDifficulty(p.botDifficulty)) s.botDifficulty = p.botDifficulty;
  return s;
}

export class Lobby {
  clients = new Map<number, Client>();
  rooms = new Map<string, Room>();
  /** 会话标识 → 最近一次拿着它的连接（包括掉线待回来的） */
  private sessions = new Map<string, Client>();
  /** 仅保存在线连接；好友码不证明身份，好友关系与存档均由客户端管理。 */
  private socialByCode = new Map<string, Client>();
  private socialCode = new Map<Client, string>();
  private socialIncoming = new Map<Client, Set<Client>>();
  private socialOutgoing = new Map<Client, Set<Client>>();
  private socialRate = new Map<Client, number[]>();
  private nextClientId = 1;
  private roomSeq = 1;
  private roomsDirty = false;
  private makeMatch: MatchFactory;
  private graceMs: number;

  constructor(makeMatch: MatchFactory, opts: { graceMs?: number } = {}) {
    this.makeMatch = makeMatch;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    // 房间列表变化合并成每 300ms 最多推一次
    setInterval(() => {
      if (!this.roomsDirty) return;
      this.roomsDirty = false;
      const msg: S2C = { t: 'rooms', rooms: this.publicRooms() };
      for (const c of this.clients.values()) if (!c.roomId) c.send(msg);
    }, 300).unref();
  }

  newClientId() {
    return this.nextClientId++;
  }

  publicRooms(): RoomSummary[] {
    return [...this.rooms.values()].filter((r) => !r.priv).map((r) => r.summary());
  }

  /**
   * 新连接上线。同一会话（刷新 / 断网重连 / 同一标签页又连了一次）且座位还在宽限期内：
   * 接回原来的 id、房间与座位，返回 true；之后由 resumeSeat 把房间（对局）推给它。
   */
  connect(c: Client): boolean {
    const prev = c.session ? this.sessions.get(c.session) : undefined;
    const room = prev?.roomId ? this.rooms.get(prev.roomId) : undefined;
    const seat = room?.members.find((m) => m.id === prev?.id);
    let resumed = false;
    if (prev && prev !== c && room && seat) {
      // 旧连接若还没断（重复标签页 / 刷新抢在断线之前）：让它停下，不再收发；客户端收到 4000 不会自动重连
      if (!prev.parked) {
        console.log(`[ws] takeover session=${String(c.session).slice(0, 8)} old=${prev.id} new=${c.id} room=${room.id}`);
        prev.close?.(4000);
        prev.onBinary = null;
        prev.send = () => {};
        prev.sendBinary = () => {};
      }
      this.drop(prev);
      c.id = prev.id;
      c.roomId = prev.roomId;
      seat.offline = false;
      seat.name = c.name;
      if (room.state === 'waiting') seat.agent = c.agent;
      resumed = true;
    }
    this.clients.set(c.id, c);
    if (c.session) this.sessions.set(c.session, c);
    return resumed;
  }

  /** connect 接回座位之后：把房间推给它；对局中还要让它重新进入对局画面（matchLoad 换新的 matchId，客户端会重建画面） */
  resumeSeat(c: Client) {
    const room = c.roomId ? this.rooms.get(c.roomId) : undefined;
    const me = room?.members.find((m) => m.id === c.id);
    if (!room || !me) return;
    if (room.state !== 'waiting' && !compatibleMap(c, room.settings.map)) {
      c.send({ t: 'error', msg: MAP_UPDATE_MESSAGE });
      this.leaveRoom(c);
      c.send({ t: 'room', room: null });
      return;
    }
    this.broadcastRoom(room);
    this.sys(room, `${c.name} 重新连上了`);
    if (room.state !== 'waiting' && room.match && me.team !== -1) {
      room.match.resumePlayer?.(c.id);
      c.send({ t: 'matchLoad', matchId: `${room.id}-r${Date.now().toString(36)}`, settings: room.settings, you: c.id, team: me.team });
    }
  }

  /** 连接断开：房间里的真人先保留座位（宽限期内可以接回）；不在房间里的直接离开 */
  disconnect(c: Client) {
    if (this.clients.get(c.id) !== c) return; // 已被同一会话的新连接接管
    this.clearSocial(c);
    const room = c.roomId ? this.rooms.get(c.roomId) : undefined;
    const seat = room?.members.find((m) => m.id === c.id);
    if (room && seat && c.session && this.sessions.get(c.session) === c) {
      c.parked = true;
      c.onBinary = null;
      c.send = () => {};
      c.sendBinary = () => {};
      seat.offline = true;
      c.timer = setTimeout(() => this.expire(c), this.graceMs);
      this.broadcastRoom(room);
      this.sys(room, `${c.name} 掉线了（${Math.round(this.graceMs / 1000)} 秒内回来会保留座位）`);
      return;
    }
    this.leaveRoom(c);
    this.drop(c);
  }

  /** 宽限期到了还没回来：正式离开房间（对局中角色移除） */
  private expire(c: Client) {
    if (!c.parked) return;
    c.timer = undefined;
    this.leaveRoom(c, 'lost');
  }

  /** 连接彻底结束：从在线表、会话表里去掉 */
  private drop(c: Client) {
    this.clearSocial(c);
    clearTimeout(c.timer);
    c.timer = undefined;
    c.parked = false;
    if (this.clients.get(c.id) === c) this.clients.delete(c.id);
    if (c.session && this.sessions.get(c.session) === c) this.sessions.delete(c.session);
  }

  /** 断线、会话接管或更换好友码时撤销在线索引及双方的待处理申请。 */
  private clearSocial(c: Client) {
    const code = this.socialCode.get(c);
    if (code && this.socialByCode.get(code) === c) this.socialByCode.delete(code);
    this.socialCode.delete(c);
    for (const sender of this.socialIncoming.get(c) ?? []) {
      const outgoing = this.socialOutgoing.get(sender);
      outgoing?.delete(c);
      if (!outgoing?.size) this.socialOutgoing.delete(sender);
    }
    for (const receiver of this.socialOutgoing.get(c) ?? []) {
      const incoming = this.socialIncoming.get(receiver);
      incoming?.delete(c);
      if (!incoming?.size) this.socialIncoming.delete(receiver);
      if (code) receiver.send({ t: 'socialRequestCancelled', code });
    }
    this.socialIncoming.delete(c);
    this.socialOutgoing.delete(c);
    this.socialRate.delete(c);
  }

  private handleSocial(c: Client, msg: SocialMessage) {
    const error = (message: string) => c.send({ t: 'socialError', message });
    const now = Date.now();
    const times = (this.socialRate.get(c) ?? []).filter((time) => now - time < SOCIAL_RATE_WINDOW_MS);
    this.socialRate.set(c, times);
    if (times.length >= SOCIAL_RATE_LIMIT) return error('社交操作过于频繁，请稍后再试');
    times.push(now);

    if (msg.t === 'socialRegister') {
      if (!isSocialCode(msg.code)) return error('好友码无效');
      const owner = this.socialByCode.get(msg.code);
      if (owner && owner !== c) return error('好友码已在线使用');
      if (this.socialCode.get(c) !== msg.code) {
        // 清除旧码的申请，但保留当前连接的限速记录。
        this.clearSocial(c);
        this.socialRate.set(c, times);
        this.socialCode.set(c, msg.code);
        this.socialByCode.set(msg.code, c);
      }
      return c.send({ t: 'socialRegistered', code: msg.code });
    }

    const ownCode = this.socialCode.get(c);
    if (!ownCode) return error('请先注册好友码');
    if (msg.t === 'socialPresence') {
      if (!Array.isArray(msg.codes) || msg.codes.length > SOCIAL_LIMIT ||
          !msg.codes.every(isSocialCode)) return error('好友码列表无效');
      const online = [...new Set(msg.codes)].filter((code) => this.socialByCode.has(code));
      return c.send({ t: 'socialPresence', online });
    }
    if (!isSocialCode(msg.code) || msg.code === ownCode) return error('好友码无效');
    const target = this.socialByCode.get(msg.code);
    if (!target) return error('对方不在线');

    if (msg.t === 'socialRequest') {
      let incoming = this.socialIncoming.get(target);
      let outgoing = this.socialOutgoing.get(c);
      if (incoming?.has(c)) return error('好友申请已发送');
      if ((incoming?.size ?? 0) >= SOCIAL_LIMIT || (outgoing?.size ?? 0) >= SOCIAL_LIMIT) return error('待处理好友申请过多');
      if (!incoming) this.socialIncoming.set(target, incoming = new Set());
      if (!outgoing) this.socialOutgoing.set(c, outgoing = new Set());
      incoming.add(c);
      outgoing.add(target);
      return target.send({ t: 'socialRequest', code: ownCode, name: c.name });
    }
    if (msg.t === 'socialAccept') {
      const incoming = this.socialIncoming.get(c);
      if (!incoming?.has(target)) return error('没有来自对方的待处理申请');
      incoming.delete(target);
      if (!incoming.size) this.socialIncoming.delete(c);
      const outgoing = this.socialOutgoing.get(target);
      outgoing?.delete(c);
      if (!outgoing?.size) this.socialOutgoing.delete(target);
      target.send({ t: 'socialAccepted', code: ownCode, name: c.name });
      return c.send({ t: 'socialAccepted', code: msg.code, name: target.name });
    }
    // 房间号（包括私密房间）只在玩家明确发送邀请时单播给目标。
    const room = c.roomId ? this.rooms.get(c.roomId) : undefined;
    if (!room || !room.members.some((member) => !member.bot && member.id === c.id)) return error('你当前不在房间中');
    return target.send({ t: 'socialInvite', code: ownCode, name: c.name, roomId: room.id });
  }

  broadcastRoom(room: Room) {
    room.match?.sync?.();
    const msg: S2C = { t: 'room', room: room.info() };
    for (const m of room.members) if (!m.bot) this.clients.get(m.id)?.send(msg);
    if (!room.priv) this.roomsDirty = true;
  }

  sendToRoom(room: Room, msg: S2C) {
    for (const m of room.members) if (!m.bot) this.clients.get(m.id)?.send(msg);
  }

  private sys(room: Room, text: string) {
    this.sendToRoom(room, { t: 'chat', from: 0, name: '', text, sys: true });
  }

  /** 随机房间号并避开已有房间。不用自增序号：否则看见一间公开房的号，就能猜出紧挨着的私密房间号 */
  private newRoomId(): string {
    for (;;) {
      let id = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) id += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(id)) return id;
    }
  }

  private createRoom(c: Client, name: string, priv: boolean, settings: Partial<RoomSettings>): Room {
    this.leaveRoom(c);
    const id = this.newRoomId();
    const room = new Room(id, cleanName(name, c.name + ' 的房间'), c.id, priv, mergeSettings(DEFAULT_SETTINGS, settings));
    room.order = this.roomSeq++;
    this.rooms.set(id, room);
    this.joinRoom(c, room);
    return room;
  }

  private joinRoom(c: Client, room: Room) {
    if (c.roomId === room.id) return;
    this.leaveRoom(c);
    const playing = room.state === 'loading' || room.state === 'playing';
    // 等待中就按人少的队坐；对局中优先空位，两队都满则顶掉一个人机
    const seat = room.seatFor();
    const member: Member = { id: c.id, name: c.name, bot: false, team: seat ? seat.team : -1, agent: c.agent, ready: false };
    if (seat?.replace) room.members = room.members.filter((m) => m !== seat.replace); // 腾位：先摘掉人机
    room.members.push(member);
    c.roomId = room.id;
    // 先广播房间（其他人拿到新成员与风格），再把新玩家接进对局：快照一定在房间消息之后
    this.broadcastRoom(room);
    const where = seat ? (seat.replace ? `（顶替 ${seat.replace.name}）` : '') : '（观战）';
    this.sys(room, playing ? `${c.name} 加入了对局${where}` : `${c.name} 加入了房间${where}`);
    if (playing && seat && room.match) {
      room.match.joinPlayer?.(member, seat.replace ? seat.replace.id : null);
      c.send({ t: 'matchLoad', matchId: `${room.id}-join`, settings: room.settings, you: c.id, team: member.team });
    }
  }

  /**
   * 快速开始只接「已经在打、还有位子」的公开对局：能立刻坐进去（有人机就顶掉一个），不用等房主开局。
   * 等待中的房间不接（房主什么时候开局没人知道，快速开始会变成干等）。真人多的优先，其次先建的。
   */
  private quickJoinTarget(c: Client): Room | null {
    const candidates = [...this.rooms.values()].filter(
      (r) => !r.priv && r.id !== c.roomId && r.state !== 'waiting' && compatibleMap(c, r.settings.map) && r.humans().length < r.settings.teamSize * 2 + 4 && r.seatFor() !== null,
    );
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.humans().length - a.humans().length || a.order - b.order);
    return candidates[0];
  }

  /** 观战中的真人在对局里找到位子后坐进去（顶替人机或直接入队）：先推房间，再接进对局，和中途加入一样 */
  private enterMatch(room: Room, member: Member, seat: { team: Team; replace: Member | null }, c: Client) {
    if (seat.replace) room.members = room.members.filter((m) => m !== seat.replace);
    member.team = seat.team;
    member.ready = false;
    this.broadcastRoom(room);
    this.sys(room, `${c.name} 加入了对局${seat.replace ? `（顶替 ${seat.replace.name}）` : ''}`);
    room.match?.joinPlayer?.(member, seat.replace ? seat.replace.id : null);
    c.send({ t: 'matchLoad', matchId: `${room.id}-join`, settings: room.settings, you: c.id, team: member.team });
  }

  /**
   * how：leave 主动离开；kick 被房主移出（聊天里写「被房主移出了房间」）；lost 掉线超过宽限期。
   */
  leaveRoom(c: Client, how: 'leave' | 'kick' | 'lost' = 'leave') {
    const room = c.roomId ? this.rooms.get(c.roomId) : null;
    c.roomId = null;
    if (c.parked) this.drop(c);
    if (!room) return;
    room.members = room.members.filter((m) => m.id !== c.id);
    room.match?.playerLeft(c.id);
    if (room.humans().length === 0) {
      room.match?.dispose();
      this.rooms.delete(room.id);
      this.roomsDirty = true;
      return;
    }
    // 房主离开：顺延给在线的第一个真人（掉线的不当房主），并在聊天里说清楚（否则大家只看到皇冠换了人）
    const heir = room.hostId === c.id ? room.humans().find((m) => !m.offline) ?? room.humans()[0] : null;
    if (heir) room.hostId = heir.id;
    this.broadcastRoom(room);
    const secs = Math.round(this.graceMs / 1000);
    this.sys(room, how === 'kick' ? `${c.name} 被房主移出了房间` : how === 'lost' ? `${c.name} 掉线超过 ${secs} 秒，已离开房间` : `${c.name} 离开了房间`);
    if (heir) this.sys(room, `${heir.name} 成为新房主`);
  }

  /** 对局结束后回到房间等待状态（由 match 调用）。准备状态保留：下一局房主能直接开，不用大家再点一遍准备 */
  endMatch(room: Room) {
    room.match?.dispose();
    room.match = null;
    room.state = 'waiting';
    this.broadcastRoom(room);
  }

  private startMatch(room: Room) {
    if (room.members.some(m => !m.bot && m.team !== -1 && !compatibleMap(this.clients.get(m.id), room.settings.map))) return 'needsUpdate';
    if (room.settings.fillBots) room.fillBots();
    const requiredPlayers = room.members.filter((m) => m.team !== -1).length;
    if (room.settings.mode === 'infection' && requiredPlayers < 2) return 'need';
    if (room.teamCount(0) === 0 || room.teamCount(1) === 0) return 'need';
    room.state = 'loading';
    const matchId = room.id + '-' + Date.now().toString(36);
    // 先推房间（含补上的人机），客户端进入对局界面时成员表才是全的
    this.broadcastRoom(room);
    for (const m of room.members)
      if (!m.bot && m.team !== -1)
        this.clients.get(m.id)?.send({ t: 'matchLoad', matchId, settings: room.settings, you: m.id, team: m.team });
    try {
      room.match = this.makeMatch(room, this);
      return 'ok';
    } catch (e) {
      room.state = 'waiting';
      this.broadcastRoom(room);
      return e instanceof Error ? e.message : '房间执行资源不可用，请稍后重试';
    }
  }

  handle(c: Client, msg: C2S) {
    if (this.clients.get(c.id) !== c) return; // 已被同一会话的新连接接管：旧连接还没断时的消息不再处理
    const room = c.roomId ? this.rooms.get(c.roomId) ?? null : null;
    const me = room?.members.find((m) => m.id === c.id);
    const isHost = !!room && room.hostId === c.id;
    const err = (m: string) => c.send({ t: 'error', msg: m });

    switch (msg.t) {
      case 'socialRegister':
      case 'socialRequest':
      case 'socialAccept':
      case 'socialPresence':
      case 'socialInvite':
        return this.handleSocial(c, msg);
      case 'profile': {
        if (msg.name !== undefined) c.name = cleanName(msg.name, c.name);
        if (isAgentId(msg.agent)) c.agent = msg.agent;
        if (me && room) {
          me.name = c.name;
          if (room.state === 'waiting') me.agent = c.agent;
          this.broadcastRoom(room);
        }
        return;
      }
      case 'listRooms':
        return c.send({ t: 'rooms', rooms: this.publicRooms() });
      case 'createRoom':
        this.createRoom(c, `${c.name} 的房间`, !!msg.priv, msg.settings);
        return;
      case 'quickPlay': {
        // 优先坐进一场正在进行、还有空位的对局（顶掉一个人机）；没有合适的就新开一局人机对战
        const target = this.quickJoinTarget(c);
        if (target) return this.joinRoom(c, target);
        if (!compatibleMap(c, mergeSettings(DEFAULT_SETTINGS, msg.settings).map)) return err(MAP_UPDATE_MESSAGE);
        const r = this.createRoom(c, `${c.name} 的快速局`, false, { ...msg.settings, fillBots: true });
        const started = this.startMatch(r);
        if (started !== 'ok') err(started);
        return;
      }
      case 'joinRoom': {
        // 房间号是随机 6 位码，乱猜没有意义；一分钟内连输太多次就暂停，防止枚举
        const now = Date.now();
        c.misses = (c.misses ?? []).filter((t) => now - t < JOIN_MISS_WINDOW_MS);
        if (c.misses.length >= JOIN_MISS_LIMIT) return err('房间号输错太多次了，一分钟后再试');
        const r = this.rooms.get(String(msg.id).toUpperCase());
        if (!r) {
          c.misses.push(now);
          return err('房间不存在或已解散');
        }
        if (r.humans().length >= r.settings.teamSize * 2 + 4) return err('房间已满');
        if (r.state !== 'waiting' && !compatibleMap(c, r.settings.map)) return err(MAP_UPDATE_MESSAGE);
        this.joinRoom(c, r);
        return;
      }
      case 'leaveRoom':
        this.leaveRoom(c);
        c.send({ t: 'room', room: null });
        c.send({ t: 'rooms', rooms: this.publicRooms() });
        return;
      case 'chat': {
        if (!room) return;
        c.send({ t: 'error', msg: '房间聊天已禁用' });
        return;
      }
    }

    if (!room || !me) return;
    if (msg.t === 'loaded') return room.match?.playerLoaded(c.id);
    if (msg.t === 'selectWeapon') {
      // 只有「对局进行中 + 在队（非观战）」才转进 match，武器名严格校验；其余一律忽略
      // （存活与否由 match 侧判断：这里的 me 只是房间成员表，不知道 hp）
      if (room.state !== 'playing' || me.team === -1) return;
      if (!isWeaponId(msg.weapon)) return;
      room.match?.selectWeapon?.(c.id, msg.weapon);
      return;
    }
    if (msg.t === 'buy') {
      // 购买（SND）：形状先严格校验，其余（模式 / 购买窗 / 存活 / 余额 / 槽位）全由 match 判，并回发 buyResult
      if (room.state !== 'playing' || me.team === -1) return;
      if (!isBuyItem(msg.item)) return;
      room.match?.buy?.(c.id, msg.item);
      return;
    }
    if (msg.t === 'spectateNext' || msg.t === 'spectatePrev' || msg.t === 'spectate-next' || msg.t === 'spectate-prev') {
      // 观战切换（阶段11）：对局进行中、在队才转进 match；是否阵亡 / 有没有存活队友由 match 判
      if (room.state !== 'playing' || me.team === -1) return;
      room.match?.spectate?.(c.id, msg.t === 'spectateNext' || msg.t === 'spectate-next' ? 1 : -1);
      return;
    }
    if (msg.t === 'leaveMatch') {
      room.match?.playerLeft(c.id);
      me.team = -1;
      this.broadcastRoom(room);
      return;
    }
    if (msg.t === 'joinMatch') {
      // 观战中的真人：对局里还有位子（某队没满，或能顶掉一个人机）就坐进去；等待中的房间没有对局可进
      if (room.state === 'waiting' || !room.match) return err('对局还没开始');
      if (!compatibleMap(c, room.settings.map)) return err(MAP_UPDATE_MESSAGE);
      if (me.team !== -1) return;
      const seat = room.seatFor();
      if (!seat) return err('对局里没有空位了');
      this.enterMatch(room, me, seat, c);
      return;
    }
    if (room.state !== 'waiting') return err('对局进行中，不能修改');

    switch (msg.t) {
      case 'setTeam': {
        const t = msg.team === 0 || msg.team === 1 ? msg.team : -1;
        if (t !== -1 && me.team !== t && room.teamCount(t) >= room.settings.teamSize) return err('该队已满');
        me.team = t;
        me.ready = false;
        break;
      }
      case 'setReady':
        me.ready = !!msg.ready;
        break;
      case 'addBot': {
        if (!isHost) return err('只有房主可以添加人机');
        const t = msg.team === 1 ? 1 : 0;
        if (!room.addBot(t, isDifficulty(msg.difficulty) ? msg.difficulty : undefined)) return err('该队已满');
        break;
      }
      case 'setBot': {
        if (!isHost) return err('只有房主可以修改人机');
        const target = room.members.find((m) => m.id === msg.id);
        if (!target?.bot) return err('找不到这个人机');
        if (msg.team === undefined && msg.difficulty === undefined) return err('没有要修改的内容');
        // 先全部校验、再统一赋值：否则难度非法时会留下「已经换了队」的半次修改
        if (msg.team !== undefined) {
          if (msg.team !== 0 && msg.team !== 1) return err('队伍不合法');
          if (msg.team !== target.team && room.teamCount(msg.team) >= room.settings.teamSize) return err('该队已满');
        }
        if (msg.difficulty !== undefined && !isDifficulty(msg.difficulty)) return err('难度不合法');
        if (msg.team !== undefined) target.team = msg.team;
        if (msg.difficulty !== undefined) target.difficulty = msg.difficulty;
        break;
      }
      case 'fillBots': {
        if (!isHost) return err('只有房主可以补满人机');
        if (msg.team !== undefined && msg.team !== 0 && msg.team !== 1) return err('队伍不合法');
        room.fillBots(msg.team);
        break;
      }
      case 'kick': {
        if (!isHost) return err('只有房主可以移除');
        const target = room.members.find((m) => m.id === msg.id);
        if (!target || target.id === c.id) return;
        if (target.bot) room.members = room.members.filter((m) => m !== target);
        else {
          const tc = this.clients.get(target.id);
          if (tc) {
            this.leaveRoom(tc, 'kick');
            tc.send({ t: 'room', room: null });
            tc.send({ t: 'error', msg: '你被房主移出了房间' });
          }
          return;
        }
        break;
      }
      case 'settings': {
        if (!isHost) return err('只有房主可以修改设置');
        const before = room.settings;
        const next = mergeSettings(before, msg.settings);
        const changed = SETTING_LABELS.filter(([k]) => next[k] !== before[k]).map(([, label]) => label);
        // 只点了「保存」、其实没改：不取消大家的准备（以前每次保存都会清空准备）
        if (!changed.length) break;
        room.settings = next;
        const onTeam = room.members.filter((m) => !m.bot && m.team !== -1).map((m) => m.id);
        room.trimTeams();
        const moved = onTeam.filter((id) => room.members.some((m) => m.id === id && m.team === -1)).length;
        const anyReady = room.members.some((m) => !m.bot && m.id !== c.id && m.ready);
        for (const m of room.members) if (!m.bot && m.id !== c.id) m.ready = false;
        const notes = [`${c.name} 修改了${changed.join('、')}`];
        if (anyReady) notes.push('已取消准备，请重新准备');
        if (moved) notes.push(`${moved} 人因人数上限被移到了观战席`);
        this.sys(room, notes.join('，'));
        break;
      }
      case 'transferHost': {
        if (!isHost) return err('只有房主可以转让房主');
        const target = room.members.find((m) => m.id === msg.id);
        if (!target || target.bot || target.id === c.id) return;
        if (target.offline) return err('对方已掉线，不能转让房主');
        room.hostId = target.id;
        this.sys(room, `${c.name} 把房主交给了 ${target.name}`);
        break;
      }
      case 'start': {
        if (!isHost) return err('只有房主可以开始');
        // 有人在队里掉线：等他回来（或房主先把他移出）再开，免得开局就缺人
        if (room.members.some((m) => !m.bot && m.offline && m.team !== -1)) return err('有玩家掉线了，等他回来或请房主移出后再开始');
        // 房主不再被「他人未准备」阻塞：未准备只由客户端提示确认，服务器只校验人数
        if (me.team === -1 && room.members.every((m) => m.bot || m.team === -1)) return err('至少要有一名玩家在队伍里');
        const started = this.startMatch(room);
        if (started !== 'ok') return err(started === 'needsUpdate'
          ? MAP_UPDATE_MESSAGE
          : started === 'need'
            ? room.settings.mode === 'infection' ? '经典生化至少需要 2 名参与者（真人或人机）' : '两边队伍都至少需要 1 人（可以添加人机）'
            : started);
        return;
      }
      default:
        return;
    }
    this.broadcastRoom(room);
  }
}
