// toy.ts — B站 Toy 运行时 SDK（只在 Toy 页面里生效）
//
// SDK 由 Toy 包内的 toy-sdk.js 注入为 window.toy；普通网页 / 本地服务器没有它，
// 这里必须静默降级，不能因为读取昵称失败阻塞进入游戏。

export interface ToyProfile {
  avatar?: string;
  nickname?: string;
  toyOpenId?: string;
}

export interface ToyRankItem {
  rank: number;
  score: number;
  nickname: string;
  avatar: string;
}
export interface ToyMyRank {
  ranked: boolean;
  rank: number;
  score: number;
}

/** checkInputSafety 三态：unavailable 表示检测没跑成，不等于通过 */
export type InputSafetyStatus = 'ok' | 'rejected' | 'unavailable';
export interface CheckInputSafetyReq {
  /** 待检测文本，非空且 ≤16384 UTF-8 字节 */
  text: string;
  /** 业务标记（昵称 / 房间名等），仅 [A-Za-z0-9_.:-]、≤64 字节 */
  scene?: string;
}
export interface CheckInputSafetyResp {
  passed: boolean;
  status: InputSafetyStatus;
}

/** Toy 数据接口的统一状态；`ok` 之外都可能表示没拿到数据，不能当成「未完成」以外的结论。 */
export type ToyDataStatus =
  | 'ok'
  | 'partial'
  | 'unauthorized'
  | 'denied'
  | 'unsupported'
  | 'toy_context_unavailable'
  | 'author_mismatch'
  | 'video_not_found'
  | 'video_invisible'
  | 'unavailable'
  | 'invalid_argument';

export interface ToyAuthorRelation {
  isFollowing: boolean;
  isAuthor: boolean;
  isOldFan: boolean;
  hasFanMedal: boolean;
  isCharging: boolean;
}

export interface ToyAuthorRelationResp {
  status: ToyDataStatus;
  data?: ToyAuthorRelation;
}

export interface ToyVideoActionItem {
  aid: number;
  bvid: string;
  status: ToyDataStatus;
  liked?: boolean;
  coinCount?: number;
  favorited?: boolean;
}

export interface ToyVideoUserActionsResp {
  status: ToyDataStatus;
  items: ToyVideoActionItem[];
}

export interface ToyNavigateReq {
  /** video = 视频页，space = 作者空间；其余页面类型本项目未使用 */
  type: 'video' | 'space' | 'search' | 'opus' | 'tribee' | 'toy';
  /** 视频 BV 号 / 用户 mid 等 */
  id: string;
  extra?: Record<string, string>;
}

/** 官方 SDK：submitScore 接收绝对分数、只保留最高分；累计值由击杀存档合并。 */
export interface ToyApi {
  getUserProfile?: () => Promise<ToyProfile>;
  getCloudStorage?: (keys?: string[]) => Promise<Record<string, string>>;
  setCloudStorage?: (items: Record<string, string>) => Promise<void>;
  submitScore?: (req: { board?: number; score: number }) => Promise<{ score: number }>;
  getRankList?: (req?: { board?: number; period?: 'all'; limit?: number }) => Promise<ToyRankItem[]>;
  getMyRank?: (req?: { board?: number; period?: 'all' }) => Promise<ToyMyRank>;
  /** 检测玩家输入的文本是否可以展示；需登录，返回 ok / rejected / unavailable 三态 */
  checkInputSafety?: (req: CheckInputSafetyReq) => Promise<CheckInputSafetyResp>;
  /** 当前访问者与当前 Toy 作者的关系（关注 / 老粉 / 粉丝勋章） */
  getAuthorRelation?: () => Promise<ToyAuthorRelationResp>;
  /** 当前访问者对指定作者视频的点赞 / 投币 / 收藏状态 */
  getVideoUserActions?: (req: { videos: { bvid: string }[] } | { aids: number[] }) => Promise<ToyVideoUserActionsResp>;
  /** 跳转 B站页面；必须由用户点击等手势触发 */
  navigate?: (req: ToyNavigateReq) => Promise<void>;
}
export type ToyScoreApi = Required<Pick<ToyApi, 'getCloudStorage' | 'setCloudStorage' | 'submitScore'>>;

declare global {
  interface Window {
    toy?: ToyApi;
  }
}

declare const __DEV__: boolean;

const TOY_HOST =
  typeof location !== 'undefined' &&
  (/(^|\.)bilibili(toy)?\.com$/i.test(location.hostname) ||
    // 本地模拟 Toy：只在 dev 打包里生效，方便用临时预览页 + 假 window.toy 调 UI
    (typeof __DEV__ !== 'undefined' && __DEV__ && new URLSearchParams(location.search).get('toyhost') === '1'));

/** Toy 内先按游客处理；拿到 B站昵称后才解除自定义限制 */
let toyGuest = TOY_HOST;

export function setToyGuest(v: boolean) {
  toyGuest = TOY_HOST ? v : false;
}

export function isToyGuest(): boolean {
  return toyGuest;
}

/** 未登录游客的随机默认代号：游客 + 4 位数字，同一设备会复用已保存的游客名 */
export function randomGuestName(): string {
  let n = 0;
  try {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    n = 1000 + (buf[0] % 9000);
  } catch {
    n = 1000 + Math.floor(Math.random() * 9000);
  }
  return `游客${n}`;
}

/** 当前页面是否运行在 B 站 Toy 宿主内。普通网页保持本地开发行为。 */
export function isToyEnvironment(): boolean {
  return TOY_HOST;
}

export function getToyApi(): ToyApi | null {
  return TOY_HOST ? window.toy ?? null : null;
}

/** 读取当前访问者的 B站昵称；非 Toy 环境、未登录、超时都返回 null。 */
export async function getToyProfile(timeoutMs = 4000): Promise<ToyProfile | null> {
  if (!TOY_HOST) return null;
  const api = getToyApi();
  if (typeof api?.getUserProfile !== 'function') return null;
  let timer = 0;
  try {
    return await Promise.race([
      api.getUserProfile(),
      new Promise<null>((resolve) => {
        timer = window.setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 服务端也会做同样的清洗；这里先裁到 16 字，避免输入框显示和服务端名字不一致。 */
export function cleanToyName(nickname: string | undefined): string {
  return String(nickname ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 16);
}
