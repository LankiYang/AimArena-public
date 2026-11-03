// protocol.ts — 对局二进制帧（DataView 手写编码，小端）。大厅消息仍走 JSON（shared/lobby.ts）
//
//   C2S 输入   [u8 MSG_INPUT][u8 n] n × { u32 seq, u16 buttons, i32 yaw×1e4, i16 pitch×1e4, u32 viewTick }
//   S2C 快照   [u8 MSG_SNAPSHOT][u32 tick][u32 ack][u8 SF_*][u32 credits][i32 spectating]
//              (SF_SELF ? 自己的完整 MoveState：22 × f64 + i32 服务器侧 yaw×1e4)
//              [u8 n] n × 实体 { i32 id, u8 flags, u8 crouch×255, f32 x y z, i16 yaw×1e4, i16 pitch×1e4,
//                                 i16 vx vy vz (mm/s), u8 hp, u8 armor, u8 armorKind, u8 rope(255=未挂绳), i16 ropeT×1e4 }
//
//   阶段9（经济）：帧头多了 u32 credits（SND 余额，TDM 恒为 0），实体多了 u8 armor（剩余护甲点，0..255）
//   与 u8 armorKind（0 无甲 / 1 light / 2 regen / 3 heavy）；帧长因此从 29 变 31 字节/实体、帧头从 10 变 14 字节。
//   阶段10（攀绳）：实体多了 u8 rope（绳索下标，255 = 未挂绳）与 i16 ropeT×1e4（0..1），
//   帧长 31 → 34 字节/实体；自己的 MoveState 多了 rope / ropeT / ropeCool / ropeIdle（18 → 22 × f64）。
//   阶段11（观战）：帧头多了 i32 spectating（观战目标的玩家 id，0 = 未观战 / 自由视角），帧头 14 → 18 字节；
//   实体格式不变（观战渲染要的**队友朝向**就是实体自带的 yaw / pitch —— decode 时另给一份 `aim` 视图，不占字节）。
//   C2S 购买命令与 S2C 购买结果定义在文件末尾（BuyCommand / BuyResult，走大厅 JSON 通道）。
//
//   阶段5：命令末尾多了 u32 viewTick（客户端渲染别人时估算的服务器 tick，用于最多 6 tick 的回溯；
//   缺省编码 0 = 「就是现在」），命令因此从 12 字节变 16 字节。快照二进制格式不变。
//
//   阶段6：实体 flags 新增 EF_TEAM1（第 4 位，表示 1 队），帧长不变；客户端据此在本地团队/敌方之间着色。
// WebSocket 基于 TCP：连接正常时字节流可靠有序，底层丢包仍可能重传并阻塞；输入不做应用层冗余重发。
import type { MoveState } from './sim/movement.ts';
import type { BuyFailReason, BuyItem } from './economy.ts';

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;

export const BTN = {
  forward: 1,
  back: 2,
  left: 4,
  right: 8,
  jump: 16,
  crouch: 32,
  walk: 64,
  fire: 128,
  aim: 256,
  reload: 512,
  use: 1024,
} as const;
export type ButtonName = keyof typeof BTN;

/** 一个 tick 的玩家输入。yaw/pitch 已量化（客户端预测和服务器用同一个值，保证结果一致） */
export interface UserCmd {
  seq: number;
  buttons: number;
  yaw: number;
  pitch: number;
  /** 发这条命令时客户端正在渲染的服务器 tick（用于命中回溯）；0 / 缺省 = 当前 tick */
  viewTick?: number;
}

export const MAX_CMDS_PER_PACKET = 32;
const CMD_BYTES = 16;
const ANG = 10000;

/** yaw 包到 [-π, π) 再量化到 1/10000 弧度 */
export function quantYaw(yaw: number) {
  const w = yaw - Math.floor((yaw + Math.PI) / (2 * Math.PI)) * 2 * Math.PI;
  return Math.round(w * ANG) / ANG;
}
export const quantPitch = (p: number) => Math.round(Math.max(-1.5, Math.min(1.5, p)) * ANG) / ANG;

export function encodeInput(cmds: UserCmd[]): Uint8Array {
  const n = Math.min(cmds.length, MAX_CMDS_PER_PACKET);
  const buf = new Uint8Array(2 + n * CMD_BYTES);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, MSG_INPUT);
  dv.setUint8(1, n);
  for (let i = 0, o = 2; i < n; i++, o += CMD_BYTES) {
    const c = cmds[cmds.length - n + i];
    dv.setUint32(o, c.seq, true);
    dv.setUint16(o + 4, c.buttons, true);
    dv.setInt32(o + 6, Math.round(c.yaw * ANG), true);
    dv.setInt16(o + 10, Math.round(c.pitch * ANG), true);
    dv.setUint32(o + 12, Math.max(0, Math.floor(c.viewTick ?? 0)), true);
  }
  return buf;
}

/** 解析输入包；格式不对返回 null（服务端收的是不可信数据）：长度必须完全吻合、最多 32 条 */
export function decodeInput(buf: Uint8Array): UserCmd[] | null {
  if (buf.byteLength < 2) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint8(0) !== MSG_INPUT) return null;
  const n = dv.getUint8(1);
  if (n > MAX_CMDS_PER_PACKET || buf.byteLength !== 2 + n * CMD_BYTES) return null;
  const out: UserCmd[] = [];
  for (let i = 0, o = 2; i < n; i++, o += CMD_BYTES) {
    const yaw = dv.getInt32(o + 6, true) / ANG;
    out.push({
      seq: dv.getUint32(o, true),
      buttons: dv.getUint16(o + 4, true),
      yaw: quantYaw(yaw),
      pitch: quantPitch(dv.getInt16(o + 10, true) / ANG),
      viewTick: dv.getUint32(o + 12, true),
    });
  }
  return out;
}

/** 自己的状态整份下发（f64），客户端用它做和解（reconciliation）后重放未确认的命令 */
const MOVE_FIELDS = ['x', 'y', 'z', 'vx', 'vz', 'vy', 'grounded', 'crouch', 'stationaryTicks', 'jumpY0', 'jumpY1', 'lsT', 'lsI', 'tag', 'tagG', 'tagP', 'landT', 'landV', 'rope', 'ropeT', 'ropeCool', 'ropeIdle'] as const;
const BOOL_FIELDS = new Set<string>(['grounded', 'tagP']);
const SELF_BYTES = MOVE_FIELDS.length * 8 + 4;

export const EF_ALIVE = 1;
export const EF_GROUNDED = 2;
/** 该实体属于 1 队（蓝/防守）。0 队不带此位。客户端用它做敌我标记，不依赖本地房间名单。 */
export const EF_TEAM1 = 4;

export interface EntitySnap {
  id: number;
  flags: number;
  crouch: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /**
   * 朝向（幅度制：yaw / pitch 与实体字段同源，**不额外占字节**）。
   * 观战时客户端用它驱动摄像机（第一人称跟随被观战队友的视线），所以单列出来当合同字段；
   * 服务端 entityOf 与解码端都填，插值端（sampleRemote）按插值后的角度重建，读到的永远是当帧朝向。
   */
  aim?: { yaw: number; pitch: number };
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  /** 剩余护甲点（0..255）；0 = 无甲或甲碎 */
  armor: number;
  /** 护甲档位码：0 无甲 / 1 light / 2 regen / 3 heavy（shared/economy.ts 的 armorKindCode） */
  armorKind: number;
  /** 攀绳：绳索下标（-1 = 未挂绳）；绳索列表顺序 = 地图数据，两端一致 */
  rope: number;
  /** 攀绳：0..1（未挂绳时无意义） */
  ropeT: number;
}
/** 实体字节数：29（v1）+ 2（护甲）+ 1（绳索下标，255 = 未挂绳）+ 2（ropeT×1e4） */
const ENT_BYTES = 34;
/** 未挂绳的绳索下标（u8 编码） */
export const ROPE_NONE = 255;

/** 快照头标志：带自己的状态 / 当前处于冻结（加载中、购买阶段） */
export const SF_SELF = 1;
export const SF_FROZEN = 2;
/** 不能开枪（爆破模式的购买 / 读条 / 结算）：只锁武器，移动不受影响 */
export const SF_WEAPON_LOCK = 4;
/** 定身（爆破模式的安放 / 拆除读条） */
export const SF_ROOTED = 8;

/** encodeSnapshot 的每人附加标志（同一局快照按接收者分别编码） */
export interface SnapLock {
  weaponLock?: boolean;
  rooted?: boolean;
}

export interface Snapshot {
  tick: number;
  /** SND 余额（TDM 恒为 0）；购买窗左侧显示的余额就来自这里 */
  credits: number;
  /**
   * 服务器指定的观战目标（玩家 id）；null = 未观战（活着，或没有存活队友 → 回落死亡点自由转头）。
   * 客户端只在「自己已阵亡 + 这个字段非 null」时进观战跟随，摄像机与客户端预测不写它。
   */
  spectating: number | null;
  frozen: boolean;
  weaponLock: boolean;
  rooted: boolean;
  /** 服务器已处理的你的最后一条命令序号 */
  ack: number;
  self: MoveState | null;
  /** 服务器上你的朝向（出生 / 复活时客户端据此转向） */
  selfYaw: number;
  ents: EntitySnap[];
}

const mm = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * 1000)));

export function encodeSnapshot(tick: number, ack: number, frozen: boolean, self: MoveState | null, selfYaw: number, ents: EntitySnap[], lock: SnapLock = {}, credits = 0, spectating: number | null = null): Uint8Array {
  const n = Math.min(ents.length, 255);
  const buf = new Uint8Array(18 + (self ? SELF_BYTES : 0) + 1 + n * ENT_BYTES);
  const dv = new DataView(buf.buffer);
  let o = 0;
  dv.setUint8(o, MSG_SNAPSHOT), (o += 1);
  dv.setUint32(o, tick, true), (o += 4);
  dv.setUint32(o, ack, true), (o += 4);
  dv.setUint8(o, (self ? SF_SELF : 0) | (frozen ? SF_FROZEN : 0) | (lock.weaponLock ? SF_WEAPON_LOCK : 0) | (lock.rooted ? SF_ROOTED : 0)), (o += 1);
  dv.setUint32(o, Math.max(0, Math.min(0xffffffff, Math.floor(credits))), true), (o += 4);
  // 观战目标：i32（人机 id 是负数，不能当成无符号）；0 = 未观战
  dv.setInt32(o, spectating === null ? SPECTATE_NONE : Math.trunc(spectating), true), (o += 4);
  if (self) {
    const rec = self as unknown as Record<string, number | boolean>;
    for (const k of MOVE_FIELDS) dv.setFloat64(o, Number(rec[k]), true), (o += 8);
    dv.setInt32(o, Math.round(quantYaw(selfYaw) * ANG), true), (o += 4);
  }
  dv.setUint8(o, n), (o += 1);
  for (let i = 0; i < n; i++) {
    const e = ents[i];
    dv.setInt32(o, e.id, true);
    dv.setUint8(o + 4, e.flags);
    dv.setUint8(o + 5, Math.round(Math.max(0, Math.min(1, e.crouch)) * 255));
    dv.setFloat32(o + 6, e.x, true);
    dv.setFloat32(o + 10, e.y, true);
    dv.setFloat32(o + 14, e.z, true);
    dv.setInt16(o + 18, Math.round(quantYaw(e.yaw) * ANG), true);
    dv.setInt16(o + 20, Math.round(quantPitch(e.pitch) * ANG), true);
    dv.setInt16(o + 22, mm(e.vx), true);
    dv.setInt16(o + 24, mm(e.vy), true);
    dv.setInt16(o + 26, mm(e.vz), true);
    dv.setUint8(o + 28, Math.max(0, Math.min(255, Math.round(e.hp))));
    dv.setUint8(o + 29, Math.max(0, Math.min(255, Math.round(e.armor))));
    dv.setUint8(o + 30, Math.max(0, Math.min(255, Math.round(e.armorKind))));
    dv.setUint8(o + 31, e.rope >= 0 && e.rope < ROPE_NONE ? e.rope : ROPE_NONE);
    dv.setInt16(o + 32, Math.round(Math.max(0, Math.min(1, e.ropeT)) * ANG), true);
    o += ENT_BYTES;
  }
  return buf;
}

/** 未观战时帧头里写的观战目标 id（玩家 id 恒为正，0 不可能是任何人的 id） */
export const SPECTATE_NONE = 0;

export function decodeSnapshot(ab: ArrayBuffer): Snapshot | null {
  const dv = new DataView(ab);
  if (ab.byteLength < 19 || dv.getUint8(0) !== MSG_SNAPSHOT) return null;
  let o = 1;
  const tick = dv.getUint32(o, true);
  const ack = dv.getUint32(o + 4, true);
  const sf = dv.getUint8(o + 8);
  const credits = dv.getUint32(o + 9, true);
  const spectateId = dv.getInt32(o + 13, true);
  const spectating = spectateId === SPECTATE_NONE ? null : spectateId;
  const hasSelf = (sf & SF_SELF) !== 0;
  o += 17;
  let self: MoveState | null = null;
  let selfYaw = 0;
  if (hasSelf) {
    const rec: Record<string, number | boolean> = {};
    for (const k of MOVE_FIELDS) {
      const v = dv.getFloat64(o, true);
      rec[k] = BOOL_FIELDS.has(k) ? v !== 0 : v;
      o += 8;
    }
    self = rec as unknown as MoveState;
    selfYaw = dv.getInt32(o, true) / ANG;
    o += 4;
  }
  const n = dv.getUint8(o);
  o += 1;
  const ents: EntitySnap[] = [];
  for (let i = 0; i < n; i++, o += ENT_BYTES) {
    ents.push({
      id: dv.getInt32(o, true),
      flags: dv.getUint8(o + 4),
      crouch: dv.getUint8(o + 5) / 255,
      x: dv.getFloat32(o + 6, true),
      y: dv.getFloat32(o + 10, true),
      z: dv.getFloat32(o + 14, true),
      yaw: dv.getInt16(o + 18, true) / ANG,
      pitch: dv.getInt16(o + 20, true) / ANG,
      aim: { yaw: dv.getInt16(o + 18, true) / ANG, pitch: dv.getInt16(o + 20, true) / ANG },
      vx: dv.getInt16(o + 22, true) / 1000,
      vy: dv.getInt16(o + 24, true) / 1000,
      vz: dv.getInt16(o + 26, true) / 1000,
      hp: dv.getUint8(o + 28),
      armor: dv.getUint8(o + 29),
      armorKind: dv.getUint8(o + 30),
      rope: dv.getUint8(o + 31) === ROPE_NONE ? -1 : dv.getUint8(o + 31),
      ropeT: dv.getInt16(o + 32, true) / ANG,
    });
  }
  return { tick, credits, ack, spectating, frozen: (sf & SF_FROZEN) !== 0, weaponLock: (sf & SF_WEAPON_LOCK) !== 0, rooted: (sf & SF_ROOTED) !== 0, self, selfYaw, ents };
}

// ---------------------------------------------------------------------------------------------
// SND 经济：购买命令与购买结果（走大厅 JSON 文本帧，不走二进制快照）
// ---------------------------------------------------------------------------------------------

/**
 * C2S 购买命令。服务端按「模式 / 购买窗 / 存活 / 余额 / 槽位」逐条校验，客户端说什么都不算数；
 * 成功即扣款并立刻装备（武器走 selectWeapon，护甲走 CombatSystem.setArmor）。
 */
export interface BuyCommand {
  t: 'buy';
  item: BuyItem;
}

/** S2C 购买结果：成功与失败都回一份，客户端据此显示「已购买 X · 余额 Y」或「余额不足…」 */
export interface BuyResult {
  t: 'buyResult';
  ok: boolean;
  /** 回显购买的条目（失败时客户端仍能定位是哪一格） */
  item: BuyItem;
  /** 条目价格 */
  price: number;
  /** 处理之后的余额（失败 = 未变动的当前余额） */
  credits: number;
  /** 中文提示，客户端直接显示 */
  message: string;
  /** 失败原因码（成功时不带） */
  reason?: BuyFailReason;
}

/** 按键位 → 移动输入（服务器与客户端预测共用） */
export function cmdToMove(c: UserCmd) {
  const b = c.buttons;
  return {
    forward: (b & BTN.forward ? 1 : 0) - (b & BTN.back ? 1 : 0),
    strafe: (b & BTN.right ? 1 : 0) - (b & BTN.left ? 1 : 0),
    jump: (b & BTN.jump) !== 0,
    crouch: (b & BTN.crouch) !== 0,
    walk: (b & BTN.walk) !== 0,
    yaw: c.yaw,
  };
}
