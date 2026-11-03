// app.ts — 前端状态与界面切换
//   首页（填昵称/选角色） → 大厅（快速开始 / 房间列表） → 房间（队伍/人机/设置） → 加载 → 对局
import type { RoomInfo, RoomSettings, RoomSummary, S2C } from '../shared/lobby.ts';
import { CLIENT_VERSION, PROTOCOL_VERSION } from '../shared/lobby.ts';
import { MAP_ROPE_REVISION } from '../shared/rope.ts';
import { Connection } from './net/socket.ts';
import { sessionToken, setInRoom, wasInRoom } from './net/session.ts';
import { profile } from './profile.ts';
import { toast } from './ui/overlay.ts';
import { friends } from './friends.ts';
import type { LocalView } from './game/match.ts';

export interface ChatLine {
  from: number;
  name: string;
  text: string;
  sys?: boolean;
}

export interface MatchLoad {
  matchId: string;
  settings: RoomSettings;
  you: number;
  /** 服务器给出的本人队伍（-1 = 观战）；敌我标记以这份权威值为准 */
  team: number;
  generation: number;
  resumeView: LocalView | null;
  /** 地图加载排队（服务器下发）：position 从 1 开始；null = 没在排队 */
  queue: { position: number; total: number; residentBytes: number; budgetBytes: number } | null;
}

export type ScreenName = 'landing' | 'lobby' | 'room' | 'match';

export interface Screen {
  el: HTMLElement;
  /** 状态变化时调用（只更新会变的部分，别整个重建，免得输入框失焦） */
  update?(): void;
  dispose?(): void;
}

class App {
  root!: HTMLElement;
  conn: Connection | null = null;
  myId = 0;
  rooms: RoomSummary[] = [];
  room: RoomInfo | null = null;
  chat: ChatLine[] = [];
  match: MatchLoad | null = null;
  entered = false;
  /** 掉线后没能接回原座位（宽限期已过）：下一条 room 消息确认后提示一次 */
  private seatLost = false;
  private screen: Screen | null = null;
  private screenName: ScreenName | null = null;
  private factories = new Map<ScreenName, () => Screen>();
  private listeners = new Set<(msg: S2C) => void>();

  register(name: ScreenName, make: () => Screen) {
    this.factories.set(name, make);
  }

  start(root: HTMLElement) {
    this.root = root;
    // 刷新时还在房间 / 对局里：直接连回去认领原来的座位（服务器在宽限期内会保留）；认不回来就提示一次
    if (wasInRoom()) {
      this.seatLost = true;
      this.connect();
    } else this.route();
  }

  /** 首页点「进入」后才建立连接 */
  connect() {
    if (this.conn) return;
    this.entered = true;
    this.conn = new Connection(() => ({ t: 'hello', name: profile.name, agent: profile.agent, session: sessionToken(), build: CLIENT_VERSION, mapRopeRevision: MAP_ROPE_REVISION }));
    this.conn.onStatus = () => {
      if (this.conn?.status !== 'open') friends.disconnected();
      this.screen?.update?.();
    };
    this.conn.on((msg) => this.onMessage(msg));
    this.route();
  }

  /** 订阅服务器消息（对局模块用） */
  onServer(fn: (msg: S2C) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private onMessage(msg: S2C) {
    friends.onMessage(msg);
    switch (msg.t) {
      case 'welcome':
        if (msg.version !== PROTOCOL_VERSION) {
          toast(`协议版本不一致（服务器 ${msg.version} / 客户端 ${PROTOCOL_VERSION}），请刷新页面或更新 App`);
        } else if (msg.build && msg.build !== CLIENT_VERSION) {
          toast(`版本不一致（服务器 ${msg.build} / 客户端 ${CLIENT_VERSION}），请刷新页面或更新 App`);
        }
        // 掉线重连：服务器发的是新 id，上一局的房间 / 对局 / 聊天都不再属于这条连接，
        // 必须先清干净再设新 id —— 否则房间界面还停在对局里，而服务器早已不认识这局（发命令只会被拒）
        if (this.myId !== 0 && this.myId !== msg.id) {
          if (this.room) this.seatLost = true; // 换了新 id：原座位没接上，等下一条 room 消息确认
          this.room = null;
          this.match = null;
          this.chat = [];
        }
        this.myId = msg.id;
        break;
      case 'rooms':
        this.rooms = msg.rooms;
        break;
      case 'room': {
        const prevId = this.room?.id;
        this.room = msg.room;
        setInRoom(!!msg.room);
        if (msg.room) this.seatLost = false;
        else if (this.seatLost) {
          this.seatLost = false;
          toast('掉线太久，座位已释放，已回到大厅');
        }
        if (!msg.room || msg.room.id !== prevId) this.chat = [];
        // 掉线重连后服务器已不认识这局：退出对局界面
        if (this.match && (!msg.room || msg.room.state === 'waiting')) {
          this.match = null;
        }
        break;
      }
      case 'chat':
        this.chat.push({ from: msg.from, name: msg.name, text: msg.text, sys: msg.sys });
        if (this.chat.length > 100) this.chat.splice(0, this.chat.length - 100);
        break;
      case 'error':
        toast(msg.msg);
        break;
      case 'matchLoad': {
        if (msg.settings.map === 'ascent' && this.conn?.mapRopeRevision !== MAP_ROPE_REVISION) {
          if (this.screenName === 'match') this.dropScreen();
          this.match = null;
          this.conn?.send({ t: 'leaveMatch' });
          toast('天界浮岛需要更新后的服务器，请稍后重试或选择其他地图');
          break;
        }
        const previous = this.match;
        // 换代时先由旧画面保存本地瞄准，再销毁。matchId 在接回座位时会改变，不能用于连续性判断。
        const resume = this.screenName === 'match' && previous && previous.generation !== this.conn!.generation &&
          previous.you === msg.you && previous.team === msg.team &&
          previous.settings.map === msg.settings.map && previous.settings.mode === msg.settings.mode;
        if (this.screenName === 'match') this.dropScreen();
        this.match = { matchId: msg.matchId, settings: msg.settings, you: msg.you, team: msg.team,
          generation: this.conn!.generation, resumeView: resume ? previous.resumeView : null, queue: null };
        break;
      }
      case 'queue':
        if (this.match && msg.map === this.match.settings.map)
          this.match.queue = msg.position > 0
            ? { position: msg.position, total: msg.total, residentBytes: msg.residentBytes, budgetBytes: msg.budgetBytes }
            : null;
        break;
    }
    for (const l of this.listeners) l(msg);
    this.route();
    this.screen?.update?.();
  }

  private wanted(): ScreenName {
    if (!this.entered) return 'landing';
    if (this.match) return 'match';
    if (this.room) return 'room';
    return 'lobby';
  }

  /** 丢掉当前画面（下一次 route 时重建） */
  private dropScreen() {
    this.screen?.dispose?.();
    this.screen?.el.remove();
    this.screen = null;
    this.screenName = null;
  }

  route() {
    const name = this.wanted();
    if (name === this.screenName) return;
    this.screen?.dispose?.();
    this.screen?.el.remove();
    this.screenName = name;
    const make = this.factories.get(name);
    if (!make) return;
    this.screen = make();
    this.screen.el.classList.add('screen', 'screen-enter');
    this.root.append(this.screen.el);
    this.screen.update?.();
  }

  me() {
    return this.room?.members.find((m) => m.id === this.myId) ?? null;
  }
  isHost() {
    return !!this.room && this.room.hostId === this.myId;
  }
}

export const app = new App();
