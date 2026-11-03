// match.ts（客户端）— 对局运行时：加载地图/武器视图/角色 → 通知服务器 → 预测自己 / 插值别人 → 渲染 + 战斗显示
//
//   自己：本地按 32 Hz 产生命令，立刻用同一份 stepPlayer 预测；收到快照后从服务器状态出发重放 seq > ack 的命令，
//         重放结果与预测的差值记为渲染偏移，按指数衰减抹平（小于 1 cm 直接忽略）。
//         自己的位置在两个预测 tick 之间按帧插值（prevPos → self，alpha = acc / TICK_DT），视角每帧立即生效。
//   别人：快照按服务器 tick 入缓冲，渲染时刻 = 估计的服务器时间 − 插值延迟，在两帧之间线性插值。
//   战斗（阶段5）：服务器每 2 tick 用 **JSON 的 combat 消息**下发自己的 CombatSelf + 对局事件（走 conn.on，不碰二进制快照）。
//         本文件只做「显示 / 输入 / 本地表现」：伤害、命中、死亡、复活全部以服务器为准，客户端不判伤。
//         死亡的自己不再预测移动（但要继续发空命令维持 ACK），复活时从权威 self 重新落地，不回放旧生命的输入。
import * as THREE from 'three';
import type { AgentId } from '../../shared/catalog.ts';
import type { CombatEvent, CombatSelf, CombatUpdate, SquadMate, V3, WeaponId } from '../../shared/combat.ts';
import type { BuyItem } from '../../shared/economy.ts';
import type { Member, RoomSettings } from '../../shared/lobby.ts';
import type { SndView } from '../../shared/snd.ts';
import { BTN, EF_ALIVE, EF_GROUNDED, EF_TEAM1, decodeSnapshot, encodeInput, quantPitch, quantYaw, type EntitySnap, type UserCmd } from '../../shared/protocol.ts';
import { copyMoveState, eyeHeight, speed2, type MoveState } from '../../shared/sim/movement.ts';
import { negotiatedRopesFor, ropeLength, ropePoint } from '../../shared/rope.ts';
import { stepPlayer } from '../../shared/sim/player.ts';
import { TICK_DT, TICK_RATE } from '../../shared/sim/tick.ts';
import { DEFAULT_SIDEARM, DEFAULT_WEAPON, firingState, WEAPON_ADS, WEAPONS, weaponSlot, type WeaponAttack } from '../../shared/sim/weapons.ts';
import { SPECTATE_FREE_LOOK, SPECTATE_KEYS_DESKTOP, SPECTATE_KEYS_TOUCH, spectateLabel } from '../../shared/spectate.ts';
import { SND_DEFAULT_SIDEARM } from '../../shared/economy.ts';
import { CombatAudio } from '../audio/combat.ts';
import { FootstepTracker } from '../audio/footsteps.ts';
import { clearDiagnostics, diagnostics, MatchNetworkMetrics } from '../diagnostics.ts';
import type { Connection } from '../net/socket.ts';
import { profile } from '../profile.ts';
import { AgentModel, preloadAgents } from '../render/agent.ts';
import { allegianceOf } from '../render/team-marker.ts';
import { CombatEffects } from '../render/combat-effects.ts';
import { RopeView } from '../render/rope.ts';
import { ADS_SIGHT_POLYGONS, ADS_SIGHT_VIEWBOX, adsSightWidthPercent, WeaponView } from '../render/weapon.ts';
import '../styles/combat.css';
import { BuyMenu } from '../ui/buy-menu.ts';
import { CombatHud } from '../ui/combat-hud.ts';
import { MatchScoreboard } from '../ui/match-scoreboard.ts';
import { RoundHud, isRoundEvent } from '../ui/round-hud.ts';
import { TdmHud, isTdmEvent } from '../ui/tdm-hud.ts';
import { Minimap, type RadarContact } from '../ui/minimap.ts';
import { radarEnemyVisible } from '../../shared/minimap.ts';
import { h } from '../ui/dom.ts';
import { MatchMenu } from '../ui/match-menu.ts';
import { InfectionHud, isInfectionState } from '../ui/infection-hud.ts';
import { loadMap, type LoadedMap } from '../world/load.ts';
import { installSky } from '../render/sky.ts';
import { Engine } from './engine.ts';
import { Input, PITCH_LIMIT, TOUCH_YAW_PER_PX, YAW_PER_COUNT_DEG, type Buttons } from './input.ts';
import { TouchUi } from './touch-ui.ts';
import { LocalWeaponPrediction, predictedHud } from './weapon-prediction.ts';
import { RemoteClock } from './remote-clock.ts';

/** 观战相机额外留 1 tick 插值缓冲：快照抖动时 sampleRemote 不会立刻停在最后一帧 */
const SPECTATE_EXTRA_DELAY = TICK_DT;
/** 观战相机跟随平滑速率（1/s）：只平滑相机，不改其他玩家模型的插值 */
const SPECTATE_CAM_SMOOTH = 30;
const SMOOTH_RATE = 12; // 渲染偏移每秒衰减到 e^-12
const SNAP_EPS = 0.01;
const TELEPORT = 2; // 误差超过 2 m 直接跳过去（复活 / 传送）
/** 相机上的后坐力偏移每秒向服务器值收敛的速率（回正靠服务器把它清 0，不写回鼠标角度） */
const RECOIL_RATE = 18;
/** shot 事件 id 去重集合的上限（服务器对局内单调递增，超了只丢最老的） */
const SHOT_ID_MAX = 128;

interface Remote {
  id: number;
  member: Member | undefined;
  model: AgentModel;
  buf: { t: number; e: EntitySnap }[];
  last: EntitySnap | null;
  /** 上一帧的 ropeT 与绳索下标：用来算远端玩家的攀爬速度（给动画） */
  prevRopeT: number;
  prevRope: number;
}

/** 本机瞄准状态，不含服务器朝向或相机后坐力。只在同局连接换代时延续。 */
export interface LocalView {
  yaw: number;
  pitch: number;
}

export interface MatchOpts {
  root: HTMLElement;
  conn: Connection;
  settings: RoomSettings;
  members: Member[];
  /** 中途加入的人不在开局的成员快照里：用这个拿实时名单（名字 / 特工 / 队伍） */
  getMembers?: () => Member[];
  myId: number;
  /** 服务器给出的本人队伍（-1 观战）；敌我标记用它，没有时才退回成员名单 */
  myTeam?: number;
  resumeView?: LocalView | null;
  onProgress: (p: number, text: string) => void;
  /** 首份服务器快照到达后显示对局；等待期间保留加载和排队提示。 */
  onFirstSnapshot?: () => void;
  onLeave: () => void;
  /** 界面被销毁 / 断线退回时 abort：加载中就不该再注册 handler、再挂画布 */
  signal?: AbortSignal;
}

export interface MatchRuntime {
  captureView(): LocalView | null;
  dispose(): void;
}

const BUTTON_BITS: [keyof Buttons, number][] = [
  ['forward', BTN.forward],
  ['back', BTN.back],
  ['left', BTN.left],
  ['right', BTN.right],
  ['jump', BTN.jump],
  ['crouch', BTN.crouch],
  ['walk', BTN.walk],
  ['fire', BTN.fire],
  ['aim', BTN.aim],
  ['reload', BTN.reload],
  ['use', BTN.use],
];

/** WeaponView 内部的 active = 当前真正挂在手里那套 rig；只读它来判定 weaponReady（不改 B 的模块） */
const activeRigOf = (v: WeaponView): boolean => (v as unknown as { active: unknown }).active != null;

export async function startMatch(o: MatchOpts): Promise<MatchRuntime> {
  const signal = o.signal;
  const connectionGeneration = o.conn.generation;
  const noop: MatchRuntime = { captureView: () => null, dispose() {} };
  /** 本次对局建出来的所有资源，按「后建先清」退出 */
  const teardown: (() => void)[] = [];
  let disposed = false;
  let raf = 0;
  const runTeardown = () => {
    for (const fn of teardown.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.warn('[match] 清理资源时出错', e);
      }
    }
  };
  /** 加载中被 abort / 断线：清掉已建资源，并且**不再往下走**（不注册 handler、不挂画布、不起循环） */
  const bail = (): MatchRuntime => {
    disposed = true;
    runTeardown();
    return noop;
  };
  if (signal?.aborted) return noop;

  const wrap = h('div', { class: 'game-root' });
  wrap.style.visibility = 'hidden';
  o.root.append(wrap);
  teardown.push(() => wrap.remove());
  const engine = new Engine(wrap);
  teardown.push(() => engine.dispose());
  engine.setFov(profile.fov);
  // 取消清理从 engine 建好就开始生效：加载中途 abort / 断线退回也能立刻收掉 WebGL 与画布
  const abortNow = () => {
    disposed = true;
    runTeardown();
  };
  signal?.addEventListener('abort', abortNow);
  teardown.push(() => signal?.removeEventListener('abort', abortNow));
  /** 调试：固定机位（测试截图用） */
  let debugCam: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;

  const agents = o.members.filter((m) => m.team !== -1 && m.id !== o.myId).map((m) => m.agent as AgentId);
  const members = o.members;
  // 敌我关系优先用服务器给的本人队伍；成员名单只用于“谁叫什么、用哪个特工”。
  const initialTeam = o.myTeam ?? members.find((m) => m.id === o.myId)?.team;
  const myAgent = members.find((m) => m.id === o.myId)!.agent;
  const names = new Map<number, string>(members.map((m) => [m.id, m.name]));
  /** 中途加入的人：房间一变就刷新名字表，击杀信息才认得到 */
  const liveMembers = () => o.getMembers?.() ?? members;
  const refreshMembers = () => {
    const list = liveMembers();
    names.clear();
    for (const m of list) names.set(m.id, m.name);
    byId.clear();
    for (const m of list) byId.set(m.id, m);
  };
  // 地图 / 武器视图 / 角色模型 三件事并行加载。
  // 三路都「先登记资源、再看 disposed」：这一局已经退出就自己释放，绝不往已清理的 scene 里挂东西。
  const mapP = loadMap(o.settings.map, engine.renderer, (p, t) => o.onProgress(p * 0.9, t)).then((m) => {
    if (disposed) {
      // 加载中被 abort / 断线退回：engine（含 GL 上下文）已经释放，这份地图直接丢弃，不挂进已 dispose 的 scene
      console.warn('[match] 地图在退出之后才加载完，直接丢弃（未挂场景；GL 上下文已随 engine 释放）');
      return m;
    }
    teardown.push(() => m.render.root.removeFromParent());
    return m;
  });
  const agentsP = preloadAgents(agents).catch((e) => console.warn('[match] 角色模型加载失败', e));
  // 第一人称枪械是这一阶段的核心交付：加载失败**不能**空手进对局——抛出去，由 match-screen 走进入对局失败的提示并清资源
  let weaponError: unknown = null;
  const weaponP = WeaponView.create(engine.renderer, myAgent).then(
    (v) => {
      if (disposed) {
        // 晚到的结果自己收尾，不留到 bail 之后
        v.dispose();
        return null;
      }
      teardown.push(() => v.dispose());
      return v;
    },
    (e) => {
      weaponError = e;
      throw new Error('枪械资源加载失败：' + (e && typeof e === 'object' && 'message' in e ? String((e as Error).message) : String(e)));
    },
  );
  let loaded: LoadedMap;
  let weaponView: WeaponView | null = null;
  try {
    // allSettled：三路各自失败时已经清过自己的资源，这里等它们**全部落定**再统一判失败并跑 teardown，
    // 不会出现「地图先 reject，武器那一路还在飞」的悬挂资源
    const [mapR, , weaponR] = await Promise.allSettled([mapP, agentsP, weaponP]);
    if (mapR.status === 'rejected') throw mapR.reason;
    if (weaponR.status === 'rejected') throw weaponR.reason;
    loaded = mapR.value;
    weaponView = weaponR.value;
  } catch (e) {
    bail();
    throw e;
  }
  if (disposed || signal?.aborted || o.conn.generation !== connectionGeneration) return bail();
  engine.scene.add(loaded.render.root);
  installSky(engine.scene, o.settings.map);
  // 攀绳：绳索点位（与服务端 / 物理同一份数据）+ 简单可视化（靠近时高亮作为吸附提示）
  const ropes = negotiatedRopesFor(o.settings.map, o.conn.mapRopeRevision);
  const ropeView = new RopeView(ropes);
  engine.scene.add(ropeView.root);
  teardown.push(() => ropeView.dispose());
  // 角色用 Lambert：给一点环境光 + 主光
  engine.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3226, 1.6));
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.4);
  sun.position.set(0.4, 1, 0.3);
  engine.scene.add(sun);
  o.onProgress(0.95, '编译着色器…');
  try {
    await engine.renderer.compileAsync(engine.scene, engine.camera);
  } catch (e) {
    bail();
    throw e;
  }
  if (disposed || signal?.aborted || o.conn.generation !== connectionGeneration) return bail();

  // —— 状态 ——
  let infectionHud: InfectionHud | null = null;
  let currentTeam = initialTeam;
  const byId = new Map(members.map((m) => [m.id, m]));
  teardown.push(
    o.conn.on((msg) => {
      if (msg.t === 'room') refreshMembers();
    }),
  );
  let self: MoveState | null = null;
  /** 上一个预测 tick 的位置与蹲伏量：渲染时在 prevPos → self 之间插值（32 Hz 不再一跳一跳） */
  const prevPos = { x: 0, y: 0, z: 0, crouch: 0 };
  let frozen = true;
  /** 服务器快照的锁定标志：购买 / 读条 / 结算期间不能开枪（weaponLock）；安放 / 拆除读条期间定身（rooted） */
  let weaponLock = false;
  let rooted = false;
  let yaw = o.resumeView?.yaw ?? 0, pitch = o.resumeView?.pitch ?? 0;
  let seq = 0;
  let acked = 0;
  const pending: UserCmd[] = [];
  const err = new THREE.Vector3();
  let gotFirst = false;
  const remotes = new Map<number, Remote>();
  const footsteps = new FootstepTracker();
  teardown.push(() => footsteps.clear());
  const remoteClock = new RemoteClock();
  const networkMetrics = new MatchNetworkMetrics();
  let lastSnapTick = 0;
  let latestAuthority: { state: MoveState; yaw: number; ack: number; tick: number } | null = null;
  let snapCount = 0, snapRateT = performance.now(), snapRate = 0;
  let frameCount = 0;
  /** 累计收到且 decode 成功的快照条数（snapCount 每秒清零，测速率时不能用它） */
  let totalSnapshots = 0;
  /** 最近一帧的 performance.now()：给外部测试判断渲染是否真的推进过 */
  let lastRenderMs = 0;
  /** 鼠标诊断：上一帧消费的事件数 */
  let mouseEventsPerFrame = 0;
  /** 鼠标诊断：上一帧最大单次 movementX */
  let mouseMaxDx = 0;

  // —— 战斗状态（服务器 16 Hz 一份，覆盖式更新）——
  /** 最新一份自己的战斗状态；null = 还没收到（此时按阶段4的老路子「等 self 加载」，不预测战斗） */
  let combatSelf: CombatSelf | null = null;
  /** 爆破回合视图（阶段 / 倒计时 / 包）；TDM 为 null。购买窗是否能开看它 */
  let roundView: SndView | null = null;
  /** 它对应的服务器 tick 与收到的本地时刻：HUD 的倒计时按 32 Hz 从这两者往前估 */
  let combatTick = 0;
  let combatAt = performance.now() / 1000;
  /** 死亡时冻住的镜头（脚底坐标 + 当时眼高）；复活落地时清掉。有观战目标时不用它 */
  let deadCam: { x: number; y: number; z: number; eye: number } | null = null;
  /** 观战（阶段11）：服务器指定的观战目标（队友 pid）；null = 不跟随（活着，或没有存活队友） */
  let spectatePid: number | null = null;
  /** TDM 不做观战：阵亡镜头留在死亡点；爆破保留阶段11观战 */
  const spectateEnabled = o.settings.mode === 'snd' || String(o.settings.mode) === 'infection';
  /** 观战相机平滑状态：目标切换 / 复活时直接吸附，避免跨图滑行 */
  const specCam = {
    pos: new THREE.Vector3(), target: new THREE.Vector3(),
    yaw: 0, pitch: 0, id: null as number | null, init: false,
  };
  /** 观战 HUD 的队友状态（CombatUpdate.squad，只含队友）；没有阵亡时为空数组 */
  let squadMates: SquadMate[] = [];
  /** 已经收到「复活」但还没等到下一份二进制 self：等到了再从权威状态落地 */
  let pendingReset = false;
  /** 渲染资源就绪前不播积压枪声 / 不画弹道：这个标志之前只存状态，不处理事件 */
  let fxReady = false;
  let shotsSeen = 0;
  const visualShots: (Extract<CombatEvent, { kind: 'shot' }> & { atTick: number; feedbackPredicted: boolean })[] = [];
  const localShots: { attack: WeaponAttack; tick: number }[] = [];
  const meleeStarts: { player: number; heavy: boolean; tick: number }[] = [];
  const seenMeleeStarts = new Set<string>();
  const seenMeleeStartOrder: string[] = [];
  let localFeedbacks = 0;
  let lastLocalFeedbackMs = 0;
  let equipStartedSec: number | null = null;
  const prediction = new LocalWeaponPrediction(presentLocalAttack);
  teardown.push(() => { visualShots.length = 0; localShots.length = 0; meleeStarts.length = 0; });
  const muzzleWorld = new THREE.Vector3();
  const seenShots = new Set<number>();
  const seenShotOrder: number[] = [];
  /** 相机上的后坐力偏移（平滑跟随服务器的 recoilYaw/Pitch；鼠标角度 yaw/pitch 保持原样） */
  const recoil = { yaw: 0, pitch: 0 };
  /** 最近一帧渲染用的脚底位置（死亡时把镜头冻在这里） */
  const lastView = { x: 0, y: 0, z: 0, eye: 1.75 };
  let zoom = 1;
  let zoomTarget = 1;
  let zoomFrom = 1;
  let zoomStartedAtMs = 0;
  let zoomDurationMs = 0;
  let adsBlend = 0;
  let adsBlendFrom = 0;
  let adsBlendTarget = 0;
  let adsWeapon: WeaponId = 'vandal';
  let adsLevel = 0;
  /** 装备/准备音频期间的点击先留一次，就绪后补上；菜单、死亡、无 ADS 武器则丢弃 */
  let pendingAimPresses = 0;
  let adsBlockedUntilMs = 0;
  let primaryWeapon: WeaponId = DEFAULT_WEAPON;
  let secondaryWeapon: WeaponId = DEFAULT_SIDEARM;
  let selectingWeapon: WeaponId | null = null;
  let selectionVersion = 0;
  let audioWeapon: WeaponId | null = null;
  let audioPreparing: WeaponId | null = null;
  let audioPreparation: Promise<void> | null = null;

  const input = new Input(engine.canvas);
  let touchUi: TouchUi | null = null;
  const audio = new CombatAudio();
  teardown.push(() => audio.dispose());
  const effects = new CombatEffects(engine.renderer);
  teardown.push(() => effects.dispose());
  const devHud = h('div', { class: 'dev-hud' });
  // 开发信息只在 ?debug=1 时显示；元素一直留在 DOM 里（旧测试读 .dev-hud 的 textContent）
  if (new URLSearchParams(location.search).get('debug') !== '1') devHud.style.display = 'none';
  const crosshair = h('div', { class: 'crosshair', style: { color: profile.crosshairColor } });
  const hint = h('div', { class: 'click-hint' }, '点击画面开始（Esc 打开菜单）');
  hint.style.pointerEvents = 'auto';
  hint.style.cursor = 'pointer';
  const waitBanner = h('div', { class: 'match-banner' }, '等待其他玩家加载…');
  // 右上「菜单」按钮：未锁定时才显示（初次进局、或菜单被关掉的间隙）；锁定后收起
  const menuBtn = h(
    'button',
    {
      class: 'btn ghost sm',
      type: 'button',
      'data-testid': 'match-menu-open',
      onclick: () => {
        if (!input.locked || input.touch) matchMenu.open(); // 触摸模式：没有锁定状态，菜单按钮始终可用
      },
    },
    '菜单',
  );
  const equipmentBtn = h(
    'button',
    {
      class: 'btn ghost sm equipment-button',
      type: 'button',
      'data-testid': 'buy-menu-open',
      onclick: openBuyMenu,
    },
    h('kbd', { class: 'kbd' }, 'B'),
    ' 装备',
  );
  const menuBar = h('div', { class: 'match-menu' }, equipmentBtn, menuBtn);
  const hudRoot = h('div', { class: 'combat-hud-root' });
  const infectionMode = String(o.settings.mode) === 'infection';
  if (infectionMode) {
    infectionHud = new InfectionHud(wrap, o.myId);
    teardown.push(() => infectionHud?.dispose());
  }
  const hud = new CombatHud(hudRoot, (w) => selectWeapon(w), { touch: input.touch, bomb: o.settings.mode === 'snd', infection: infectionMode });
  const roundHud = new RoundHud(wrap, { myId: o.myId, myTeam: initialTeam, names });
  teardown.push(() => roundHud.dispose());
  teardown.push(() => hud.dispose());
  wrap.classList.add('has-match-intel');
  const minimap = new Minimap(wrap, o.settings.map);
  teardown.push(() => minimap.dispose());
  const adsSight = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  adsSight.setAttribute('class', 'ads-sight');
  adsSight.setAttribute('data-testid', 'ads-sight');
  adsSight.setAttribute('aria-hidden', 'true');
  adsSight.setAttribute('viewBox', ADS_SIGHT_VIEWBOX);
  adsSight.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  adsSight.innerHTML = ADS_SIGHT_POLYGONS.map((points) => `<polygon points="${points}" fill="#ffc451"/>`).join('');
  wrap.append(adsSight);
  const scope = h('div', { class: 'scope-overlay', 'data-testid': 'scope-overlay', 'aria-hidden': 'true' });
  scope.innerHTML = '<i class="scope-mask"></i><svg class="scope-glass" viewBox="-100 -100 200 200"><circle r="98" fill="none" stroke="#c4d4d6" stroke-width="1"/><path d="M-98 0H-8 M8 0H98 M0-98V-8 M0 8V98" fill="none" stroke="#c4d4d6" stroke-width="1"/></svg><i class="scope-dot"></i>';
  wrap.append(scope);
  // 攀绳吸附提示（有绳索的地图才可能显示）：靠近绳索 / 挂在绳上时给出中文提示
  const ropeHint = h('div', { class: 'rope-hint', 'data-testid': 'rope-hint' });
  ropeHint.style.cssText =
    'position:absolute;left:50%;bottom:16%;transform:translateX(-50%);padding:6px 12px;border-radius:6px;' +
    'background:rgba(12,16,20,.62);color:#ffe08a;font-size:14px;letter-spacing:.5px;display:none;pointer-events:none;z-index:6';
  wrap.append(ropeHint);
  wrap.append(devHud, hudRoot, crosshair, hint, waitBanner, menuBar);
  // Esc 菜单：DOM / 子弹窗 / 焦点 / 清理都封在 match-menu.ts 里，主循环不掺和
  const matchMenu = new MatchMenu({
    root: wrap,
    isLocked: () => input.locked,
    isTouch: () => input.touch,
    requestLock: () => input.lock(),
    // Esc 主动解锁（无头 / 浏览器都能确定退出），并立刻开菜单：不依赖 pointerlockchange
    // （无头环境里那个事件可能永远不来）。真浏览器稍后的事件走 onLockChange，重复打开是安全的。
    requestUnlock: () => {
      input.unlock();
      // 立刻松开移动 / fire / aim / reload 与累积鼠标位移：不等 pointerlockchange 也保证「Esc 这一刻就停手」
      input.releaseAll();
      matchMenu.open();
    },
    onLeave: () => o.onLeave(),
    // 设置改动立刻作用到对局：FOV 之前只在开镜倍率变化时 setFov，所以改视野没反应；准星颜色同理是静态的
    onSettingsChange: () => {
      engine.setFov(profile.fov, zoom);
      crosshair.style.color = profile.crosshairColor;
      touchUi?.setLayout(profile.touchLayout);
    },
    onVisibilityChange: (open) => { if (open) scoreboard?.close(false); syncUi(); },
  });
  teardown.push(() => matchMenu.dispose());
  const buyMenu = new BuyMenu({
    root: wrap,
    mode: o.settings.mode,
    onSelect: selectWeapon,
    onBuy: buyItem,
    onResume: input.lock.bind(input),
    onPause: () => matchMenu.open(),
    onVisibilityChange: syncUi,
  });
  teardown.push(() => buyMenu.dispose());
  // 购买结果（SND）：成功/失败的中文提示直接交给装备菜单的状态条显示，客户端不自己算扣款。
  teardown.push(o.conn.on((msg) => { if (msg.t === 'buyResult') buyMenu.notify(msg); }));
  const scoreboard = new MatchScoreboard(wrap, {
    myId: o.myId, myTeam: initialTeam, touch: input.touch, mode: o.settings.mode, conn: o.conn,
    onOpenDialog: () => {
      if (matchMenu.isOpen || buyMenu.isOpen) return false;
      input.releaseAll();
      return true;
    },
    onCloseDialog: () => input.releaseAll(),
    onVisibilityChange: syncUi,
  });
  teardown.push(() => scoreboard?.dispose());
  // TDM：整场的阶段文案 / 击杀目标写进上面那一条比分行（顶部只有一个比分行，不再另开 round-bar）
  const tdmHud = String(o.settings.mode) === 'tdm' ? new TdmHud(wrap, { myTeam: initialTeam, header: scoreboard }) : null;
  if (tdmHud) teardown.push(() => tdmHud.dispose());
  const offBoard = o.conn.on(msg => { if (msg.t === 'matchBoard') scoreboard?.update(msg); });
  const offInfection = o.conn.on((msg) => {
    const raw = msg as unknown as Record<string, unknown>;
    if (!infectionMode || raw.t !== 'infectionState' || !isInfectionState(raw)) return;
    infectionHud?.setState(raw, combatTick);
    scoreboard.setInfectionState(raw);
    if (infectionHud?.currentTeam === 1 && buyMenu.isOpen) {
      input.releaseAll();
      buyMenu.close(false);
    }
  });
  teardown.push(offInfection);
  teardown.push(offBoard);
  // 触摸层：左摇杆移动、右半屏拖动转向、右下动作按钮（手机/平板，或 ?touch=1 强制）
  if (input.touch) {
    wrap.classList.add('touch');
    touchUi = new TouchUi(wrap, input, { use: o.settings.mode === 'snd', layout: profile.touchLayout });
    teardown.push(() => touchUi?.dispose());
  }
  // 整个画面（含提示框）都能点回来；按钮上的点击不抢（HUD 的 1/2/3 按钮在解锁后要能点）
  wrap.addEventListener('mousedown', (e) => {
    if (input.touch) return; // 触摸模式没有「点画面锁鼠标」这一步
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    if (matchMenu.isOpen || buyMenu.isOpen || scoreboard?.isOpen) return; // 弹层空白/原生滑动不能抢回指针锁定
    input.lock();
  });
  // 音频解锁必须在用户手势里：wrapper 上任意 pointerdown + 锁定回调各来一次（重复调用是幂等的）
  wrap.addEventListener('pointerdown', () => { void prepareAudio(combatSelf?.weapon ?? 'vandal'); });
  // 切标签页 / 切窗口导致的解锁不要自动弹菜单：否则回来点画面会被菜单挡住，感觉像“鼠标锁不上”。
  let away = false;
  const markAway = () => { away = true; };
  const markHidden = () => { if (document.hidden) away = true; };
  window.addEventListener('blur', markAway);
  document.addEventListener('visibilitychange', markHidden);
  teardown.push(() => {
    window.removeEventListener('blur', markAway);
    document.removeEventListener('visibilitychange', markHidden);
  });
  input.onLockChange = (l) => {
    if (l) {
      away = false;
      void prepareAudio(combatSelf?.weapon ?? 'vandal');
      matchMenu.notifyLocked(); // 锁定成功才隐藏菜单
      if (scoreboard?.isModal) scoreboard.close(false);
    } else if (!buyMenu.isOpen && !scoreboard?.isModal) {
      if (away || document.hidden || !document.hasFocus()) {
        away = true;
        hint.textContent = '点击画面继续（恢复鼠标控制）';
      } else {
        matchMenu.open();
      }
    }
    syncUi();
  };
  input.onLockError = () => {
    // 菜单开着：保留菜单并给重试提示（可再点「继续游戏」）；还没开过菜单：中心提示自己带重试文案
    if (matchMenu.isOpen) matchMenu.notifyLockFailed();
    else {
      hint.textContent = '浏览器暂时拒绝锁定鼠标，再点一下画面';
      syncUi();
    }
  };

  /**
   * 观战切换目标（阶段11，产品决策 10）：桌面 `[` / `]` 与触屏左右按钮走同一条路径。
   * 只有「已阵亡 + 不在弹窗里」才发命令；服务端还会再判一次存活 / 队伍 / 有没有队友，
   * 所以这里就算发早了也只是被忽略，不产生任何本地状态。
   */
  input.onSpectateKey = (dir) => {
    if (disposed || !spectateEnabled || alive() || buyMenu.isOpen || matchMenu.isOpen || scoreboard?.isModal) return;
    o.conn.send(dir > 0 ? { t: 'spectateNext' } : { t: 'spectatePrev' });
  };

  /** 中心提示与右上「菜单」按钮的显隐：锁定后都收起；菜单一开，旧的中心提示也不再出现 */
  function syncUi() {
    const locked = input.locked;
    hint.style.display = locked || matchMenu.isOpen || buyMenu.isOpen || scoreboard?.isOpen ? 'none' : '';
    // 触摸模式没有指针锁定，菜单按钮要一直留着（它就是手机上的 Esc）
    menuBar.style.display = locked && !input.touch ? 'none' : '';
  }
  syncUi();
  // 1 主武器、2 副武器、3 刀；B 选择只替换对应分类的槽位。
  input.onKey = (code, down) => {
    if (code === 'Tab') {
      // 桌面按住查看不解锁、不 releaseAll，因此正在按住的 WASD 不会因看表停下。
      if (!down) scoreboard?.peek(false);
      else if (!input.touch && input.locked && !matchMenu.isOpen && !buyMenu.isOpen) scoreboard?.peek(true);
      return;
    }
    if (!down || scoreboard?.isModal) return;
    if (code === 'KeyB') {
      openBuyMenu();
      return;
    }
    if (!input.locked || !alive() || buyMenu.isOpen) return;
    if (code === 'Digit1' || code === 'Numpad1') selectWeapon(primaryWeapon);
    else if (code === 'Digit2' || code === 'Numpad2') selectWeapon(secondaryWeapon);
    else if (code === 'Digit3' || code === 'Numpad3') selectWeapon('melee');
    else if (code === 'KeyY' && combatSelf?.weapon === 'melee') weaponView?.inspect();
  };

  /** 当前武器的声音在锁定/选枪手势中准备，第一发不能以触发解码而被丢弃。 */
  function prepareAudio(w: WeaponId): Promise<void> {
    audio.unlock();
    audio.prepareSteps();
    if (audioWeapon === w) return Promise.resolve();
    if (audioPreparing === w && audioPreparation) return audioPreparation;
    audioPreparing = w;
    const preparation = audio.prepare(w).then(() => {
      if (disposed || audioPreparation !== preparation) return;
      audioWeapon = w;
      audioPreparing = null;
      audioPreparation = null;
    });
    audioPreparation = preparation;
    return preparation;
  }

  /** 先准备真实模型和枪声，再请求权威切换；过期加载不能覆盖较新的选择。 */
  function selectWeapon(w: WeaponId): void {
    if (disposed || !alive() || (infectionMode && infectionHud?.currentTeam === 1 && w !== 'melee') || (combatSelf?.weapon === w && selectingWeapon === null)) return;
    const version = ++selectionVersion;
    selectingWeapon = w;
    // 切枪只取消旧武器动作，不能清掉仍按住的 WASD / 蹲 / 静步或触摸摇杆。
    input.releaseWeaponActions();
    hud.setEquipmentStatus(`正在加载${WEAPONS[w].name}…`);
    void Promise.all([weaponView!.prepare(w), prepareAudio(w)]).then(() => {
      if (disposed || version !== selectionVersion || !alive() || (infectionMode && infectionHud?.currentTeam === 1 && w !== 'melee')) return;
      if (combatSelf?.weapon === w) {
        selectingWeapon = null;
        hud.setEquipmentStatus('');
      } else {
        hud.setEquipmentStatus(`正在装备${WEAPONS[w].name}…`);
        o.conn.send({ t: 'selectWeapon', weapon: w });
      }
    }).catch((error: unknown) => {
      if (disposed || version !== selectionVersion) return;
      selectingWeapon = null;
      const message = error instanceof Error ? error.message : String(error);
      hud.setEquipmentStatus(`${WEAPONS[w].name}加载失败：${message}；按 B 重新选择`);
    });
  }

  /** 本人是否活着；还没收到战斗状态时按「活着」处理（沿用阶段4的老路径） */
  const alive = () => (combatSelf ? combatSelf.alive : true);

  /** SND：现在是不是购买窗（回合准备阶段 + 活着）；TDM 永远为假（免费切换不需要购买） */
  const buyWindowOpen = () => o.settings.mode === 'snd' && alive() && roundView?.phase === 'buy';

  /**
   * SND 购买：先把第一人称模型与枪声准备好，再发 buy 命令（钱与装备都以服务器为准）。
   * 护甲不需要模型，直接发；武器复用 selectWeapon 那套 prepare 流程，避免买完手中是空的。
   */
  function buyItem(item: BuyItem): void {
    if (disposed) return;
    if (item.type === 'armor') {
      o.conn.send({ t: 'buy', item });
      return;
    }
    const w = item.id;
    const version = ++selectionVersion;
    selectingWeapon = w;
    hud.setEquipmentStatus(`正在购买${WEAPONS[w].name}…`);
    void Promise.all([weaponView!.prepare(w), prepareAudio(w)]).then(() => {
      if (disposed || version !== selectionVersion || !alive()) return;
      o.conn.send({ t: 'buy', item });
    }).catch((error: unknown) => {
      if (disposed || version !== selectionVersion) return;
      const message = error instanceof Error ? error.message : String(error);
      hud.setEquipmentStatus(`${WEAPONS[w].name}加载失败：${message}；按 B 重新选择`);
    });
  }

  function openBuyMenu() {
    if (matchMenu.isOpen || scoreboard?.isOpen || !alive() || (infectionMode && infectionHud?.currentTeam !== 0)) return;
    // SND 只在购买窗内能开（不在窗口内时给一句中文提示，不静默无反应）
    if (o.settings.mode === 'snd' && !buyWindowOpen()) {
      hud.setEquipmentStatus('购买窗已关闭：装备只在回合准备阶段购买，阵亡后等下一回合');
      return;
    }
    if (!buyMenu.open()) return;
    if (!input.touch && input.locked) input.unlock();
    input.releaseAll();
  }

  /** 这条命令「看到」的服务器 tick：衰减到 0 以下就夹到 0（等待首快照时就是 0） */
  function viewTickNow() {
    const t = remoteClock.time;
    return Number.isFinite(t) ? Math.max(0, Math.floor(t / TICK_DT)) : 0;
  }

  /** HUD / 换弹进度用的当前服务器时间：最近一份 combat 的 tick + 本地流逝时间按 32 Hz 连续预估。 */
  function estTickFloat() {
    const dt = performance.now() / 1000 - combatAt;
    return combatTick + Math.max(0, dt) * TICK_RATE;
  }

  /** 换弹进度 0→1；不在换弹时是 0（时长取 WEAPONS[武器].reload 秒，不另立数值） */
  function reloadProgressOf(cs: CombatSelf, tick: number) {
    if (cs.reloadUntil <= tick) return 0;
    const total = Math.max(1, WEAPONS[cs.weapon].reload * TICK_RATE);
    return Math.max(0, Math.min(1, 1 - (cs.reloadUntil - tick) / total));
  }

  /** 音效要的听者位置：就是相机（眼睛）当前位置 */
  const listenerPos = (): V3 => ({ x: engine.camera.position.x, y: engine.camera.position.y, z: engine.camera.position.z });

  function presentLocalAttack(attack: WeaponAttack, tick: number): boolean {
    if (!fxReady || disposed || !combatSelf?.alive || attack.weapon !== combatSelf.weapon || selectingWeapon !== null) return false;
    localShots.push({ attack, tick });
    localFeedbacks++;
    lastLocalFeedbackMs = performance.now();
    equipStartedSec = null;
    audio.playLocal(attack.weapon, listenerPos(), attack.heavy);
    const ads = WEAPON_ADS[attack.weapon];
    if (ads?.unscopeAfterShot) {
      adsLevel = 0;
      adsBlockedUntilMs = performance.now() + ads.zoomLockAfterShotSeconds * 1000;
    }
    return true;
  }

  /** 一条服务器事件：按数组顺序处理；display 层（HUD / 音效 / 弹道）只认服务器给的结果 */
  function handleEvent(e: CombatEvent) {
    if (isRoundEvent(e)) {
      roundHud.event(e);
      return;
    }
    if (isTdmEvent(e)) {
      tdmHud?.event(e);
      return;
    }
    if (e.kind === 'meleeStart') {
      const key = `${e.player}:${e.attackSerial}`;
      if (seenMeleeStarts.has(key)) return;
      seenMeleeStarts.add(key);
      seenMeleeStartOrder.push(key);
      if (seenMeleeStartOrder.length > SHOT_ID_MAX) seenMeleeStarts.delete(seenMeleeStartOrder.shift()!);
      const predicted = e.player === o.myId && prediction.meleeStarted(e.commandSeq);
      if (e.player !== o.myId) {
        remoteWeapons.set(e.player, 'melee');
        if (infectionMode && infectionHud?.teamOf(e.player) === 1) remotes.get(e.player)?.model.infectedAttack();
        setRemoteWeapon(e.player, 'melee');
      }
      if (!predicted) {
        audio.playMelee(e.player, e.origin, listenerPos(), o.myId, e.heavy);
        meleeStarts.push({ player: e.player, heavy: e.heavy, tick: combatTick });
      }
      return;
    }
    if (e.kind === 'shot') {
      // 每个事件服务器只送一次，客户端仍按 id 去重（重连 / 重复下发都不会打两次枪口动画）
      if (seenShots.has(e.id)) return;
      seenShots.add(e.id);
      seenShotOrder.push(e.id);
      if (seenShotOrder.length > SHOT_ID_MAX) seenShots.delete(seenShotOrder.shift() as number);
      shotsSeen++;
      if (e.weapon === 'melee') {
        hud.event(e, o.myId, names);
        return;
      }
      const feedbackPredicted = e.shooter === o.myId && prediction.confirmed(e.attackSerial, e.weapon);
      if (e.shooter === o.myId && !feedbackPredicted) {
        const ads = WEAPON_ADS[e.weapon];
        if (ads?.unscopeAfterShot) {
          adsLevel = 0;
          adsBlockedUntilMs = performance.now() + ads.zoomLockAfterShotSeconds * 1000;
        }
      }
      if (e.shooter !== o.myId) {
        remoteWeapons.set(e.shooter, e.weapon); // 别人手里的枪跟着事件走（模型没建好就先记下来）
        setRemoteWeapon(e.shooter, e.weapon);
      }
      if (!feedbackPredicted) audio.play(e, listenerPos(), o.myId);
      hud.event(e, o.myId, names);
      visualShots.push({ ...e, atTick: combatTick, feedbackPredicted });
      if (visualShots.length > 32) visualShots.shift();
      return;
    }
    if (e.kind === 'equip' && e.player !== o.myId) {
      remoteWeapons.set(e.player, e.weapon);
      setRemoteWeapon(e.player, e.weapon);
    }
    audio.play(e, listenerPos(), o.myId);
    hud.event(e, o.myId, names);
  }

  /** 一份 CombatUpdate：先落状态（loading 期间也接），再按顺序处理事件（资源就绪前不放积压枪声） */
  function applyCombat(u: CombatUpdate) {
    const wasAlive = combatSelf ? combatSelf.alive : true; // 还没收到状态时按「活着」推：首份就是死亡也要走一次死亡流程
    const changedWeapon = combatSelf?.weapon !== u.self.weapon;
    combatSelf = u.self;
    combatTick = u.tick;
    combatAt = performance.now() / 1000;
    if (u.round) { roundView = u.round; roundHud.setView(u.round); }
    if (u.tdm && tdmHud) tdmHud.setView(u.tdm);
    // 观战（阶段11）：活着时服务器不下发 squad（这里也主动清掉，免得复活后 HUD 还挂着上一轮的队友数字）
    squadMates = u.self.alive ? [] : u.squad ?? [];
    if (changedWeapon && u.self.equipUntil > 0) equipStartedSec = u.self.equipUntil / TICK_RATE - WEAPONS[u.self.weapon].equip;
    if (u.self.reloadUntil > u.tick || !u.self.alive) equipStartedSec = null;
    prediction.reconcile(u.self, u.tick, frozen || weaponLock);
    const slot = weaponSlot(u.self.weapon);
    if (slot === 1) primaryWeapon = u.self.weapon;
    else if (slot === 2) secondaryWeapon = u.self.weapon;
    // SND：1 / 2 槽位每次都跟本回合真正拥有的枪对齐（死了或换回合后不能还记着上回合买的枪）
    if (u.self.owned.length > 0) {
      primaryWeapon = u.self.owned.find((w) => weaponSlot(w) === 1) ?? SND_DEFAULT_SIDEARM;
      secondaryWeapon = u.self.owned.find((w) => weaponSlot(w) === 2) ?? SND_DEFAULT_SIDEARM;
    }
    if (selectingWeapon === u.self.weapon || !u.self.alive) {
      selectingWeapon = null;
      hud.setEquipmentStatus('');
      if (!u.self.alive) selectionVersion++;
    }
    if (wasAlive === true && !u.self.alive) {
      // 刚死亡：松开所有按键，镜头冻在死亡点，等 HUD 的 3 秒倒计时
      input.releaseAll();
      deadCam = { ...lastView };
    } else if (wasAlive === false && u.self.alive) {
      // 刚复活：本地不猜位置，等下一份二进制 self 再从权威状态落地（pendingReset）
      input.releaseAll();
      pendingReset = true;
      // 同一轮服务端先发二进制快照，再发 combat。优先用那份出生快照恢复视角，
      // 避免等待下一份快照时，死亡期间已发出的旧视角又把出生朝向覆盖掉。
      if (latestAuthority && latestAuthority.tick >= u.tick) {
        resetAuthority(latestAuthority.state, latestAuthority.yaw, latestAuthority.ack, true);
      }
    }
    if (!fxReady) {
      // 加载期间仍记住远端持有的武器；首次渲染后不补播旧攻击，但不能丢掉换刀状态。
      for (const e of u.events) {
        if (e.kind === 'meleeStart' && e.player !== o.myId) {
          remoteWeapons.set(e.player, 'melee');
          setRemoteWeapon(e.player, 'melee');
        } else if (e.kind === 'equip' && e.player !== o.myId) {
          remoteWeapons.set(e.player, e.weapon);
          setRemoteWeapon(e.player, e.weapon);
        } else if (e.kind === 'shot' && e.weapon !== 'melee' && e.shooter !== o.myId) {
          remoteWeapons.set(e.shooter, e.weapon);
          setRemoteWeapon(e.shooter, e.weapon);
        }
      }
      return;
    }
    for (const e of u.events) handleEvent(e);
  }

  const offCombat = o.conn.on((msg) => {
    if (msg.t === 'combat') applyCombat(msg as CombatUpdate);
  });
  teardown.push(() => offCombat());
  const offRoundEnd = o.conn.on((msg) => {
    if (msg.t !== 'matchEnd') return;
    if (tdmHud) tdmHud.matchEnded(msg.winner, msg.summary && 'reason' in msg.summary ? msg.summary : null);
    else roundHud.matchEnded(msg.winner, msg.summary && 'rounds' in msg.summary ? msg.summary : null);
  });
  teardown.push(() => offRoundEnd());

  /** 远程玩家手上拿的枪：事件（shot / equip）可能比模型先到，所以先记在这里，模型建好时再补上 */
  const remoteWeapons = new Map<number, WeaponId>();
  teardown.push(() => remoteWeapons.clear());

  /** 把某个远程玩家的选枪告诉他的第三人称模型（D 的 AgentModel.setWeapon：骨架还没建好时它自己会先记住，建好时装的就是这把） */
  function setRemoteWeapon(id: number, w: WeaponId) {
    remotes.get(id)?.model.setWeapon(w);
  }

  function ensureRemote(id: number, team: number): Remote {
    let r = remotes.get(id);
    if (!r) {
      const member = byId.get(id);
      const model = new AgentModel((member?.agent ?? 'jett') as AgentId, allegianceOf(currentTeam, team), member?.name ?? '玩家');
      r = { id, member, model, buf: [], last: null, prevRopeT: 0, prevRope: -1 };
      remotes.set(id, r);
      engine.scene.add(model.root);
      // 默认狂徒；如果这个人的 shot / equip 事件先到过，就按记下来的枪（复活不重置武器：服务器只重置弹药）
      setRemoteWeapon(id, remoteWeapons.get(id) ?? 'vandal');
    }
    return r;
  }

  function resetAuthority(state: MoveState, serverYaw: number, ack: number, resetView: boolean) {
    const s = copyMoveState(state);
    self = s;
    prevPos.x = s.x;
    prevPos.y = s.y;
    prevPos.z = s.z;
    prevPos.crouch = s.crouch;
    err.set(0, 0, 0);
    acked = ack;
    seq = Math.max(seq, acked);
    pending.length = 0;
    if (resetView) {
      yaw = serverYaw;
      pitch = 0;
      deadCam = null;
      pendingReset = false;
    }
  }

  const offBinary = o.conn.onBinary((ab) => {
    const snap = decodeSnapshot(ab);
    if (!snap) return;
    // WT 数据报可能乱序或重复；只接受更新的 tick（TCP/WS 上等价于恒真）。
    if (snap.tick <= lastSnapTick) return;
    const now = performance.now() / 1000;
    const st = snap.tick * TICK_DT;
    remoteClock.observe(snap.tick, now);
    networkMetrics.snapshot(snap.ack, now * 1000);
    lastSnapTick = snap.tick;
    snapCount++;
    totalSnapshots++;
    frozen = snap.frozen;
    weaponLock = snap.weaponLock;
    rooted = snap.rooted;
    // 观战（阶段11）：服务器指定「跟随哪个队友」。活着 / 没有存活队友时是 null（自由转头）。
    spectatePid = spectateEnabled ? snap.spectating : null;
    waitBanner.style.display = frozen ? '' : 'none';
    // 自己：和解
    if (snap.self) {
      latestAuthority = { state: snap.self, yaw: snap.selfYaw, ack: snap.ack, tick: snap.tick };
      const first = !self;
      // 首次 / 死亡期间 / 复活落地：直接吃权威状态，不重放（死亡时本地不预测移动，旧生命的命令也不能再放）
      if (first || (combatSelf !== null && !combatSelf.alive) || pendingReset) {
        resetAuthority(snap.self, snap.selfYaw, snap.ack, pendingReset || (first && !o.resumeView));
      } else if (self) {
        acked = snap.ack;
        // 后续快照也可能确认到高于本地计数的命令；下一条输入必须始终大于权威 ACK。
        seq = Math.max(seq, acked);
        while (pending.length && pending[0].seq <= acked) pending.shift();
        const before = { x: self.x, y: self.y, z: self.z };
        const s = copyMoveState(snap.self);
        for (const c of pending) stepPlayer(s, c, frozen || rooted, loaded.bvh, combatSelf?.weapon ?? 'vandal', (c.buttons & BTN.aim) !== 0, ropes, combatSelf?.moveSpeedMultiplier ?? 1);
        const dx = before.x - s.x, dy = before.y - s.y, dz = before.z - s.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > TELEPORT) {
          err.set(0, 0, 0);
          prevPos.x = s.x;
          prevPos.y = s.y;
          prevPos.z = s.z;
          prevPos.crouch = s.crouch;
        } else if (d > SNAP_EPS) {
          err.add(new THREE.Vector3(dx, dy, dz));
          // 插值路径整体平移：prevPos 跟着 self 走同样的位移，渲染位置在 alpha 的两端都连续
          prevPos.x -= dx;
          prevPos.y -= dy;
          prevPos.z -= dz;
          prevPos.crouch += s.crouch - self.crouch;
        }
        self = d > SNAP_EPS ? s : self;
      }
    }
    // 别人：入插值缓冲
    const seen = new Set<number>();
    for (const e of snap.ents) {
      seen.add(e.id);
      // 阵营来自服务器快照的阵营位，不再依赖本地房间名单（名单可能过期或缺少人机）。
      const r = ensureRemote(e.id, (e.flags & EF_TEAM1) !== 0 ? 1 : 0);
      r.buf.push({ t: st, e });
      if (r.buf.length > 32) r.buf.shift();
    }
    for (const [id, r] of remotes)
      if (!seen.has(id)) {
        footsteps.remove(id);
        r.model.dispose();
        remotes.delete(id);
      }
    if (!gotFirst) {
      gotFirst = true;
      wrap.style.visibility = '';
      fxReady = true; // 画面已经能出图：从这里开始才处理战斗事件（loading 期间积压的枪声不补播）
      o.onFirstSnapshot?.();
    }
  }, connectionGeneration);
  teardown.push(offBinary);

  o.conn.send({ t: 'loaded' });
  o.onProgress(1, '等待服务器…');

  // —— 主循环 ——
  let acc = 0, last = performance.now(), lastFrameDt = 0;
  const tmp = new THREE.Vector3();
  const radarFrustum = new THREE.Frustum(), radarMatrix = new THREE.Matrix4(), radarPoint = new THREE.Vector3();
  let nextRadarAt = 0;

  function sampleRemote(r: Remote, t: number): EntitySnap | null {
    const b = r.buf;
    if (!b.length) return null;
    if (t <= b[0].t) return b[0].e;
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].t <= t) {
        const a = b[i], n = b[i + 1];
        if (!n) return a.e; // 无更新帧时保持权威位置，不跨墙猜测轨迹。
        const k = (t - a.t) / (n.t - a.t);
        let dyaw = n.e.yaw - a.e.yaw;
        dyaw -= Math.round(dyaw / (2 * Math.PI)) * 2 * Math.PI;
        const big = Math.hypot(n.e.x - a.e.x, n.e.z - a.e.z) > TELEPORT;
        // 攀绳：两帧挂在同一条绳上时按 ropeT 插值，位置直接从绳索数据算（比插 x/y/z 更准）
        const sameRope = a.e.rope >= 0 && a.e.rope === n.e.rope && a.e.rope < ropes.length;
        const ropeT = sameRope ? a.e.ropeT + (n.e.ropeT - a.e.ropeT) * k : n.e.ropeT;
        const rp = sameRope ? ropePoint(ropes[a.e.rope], ropeT) : null;
        return {
          ...n.e,
          x: rp ? rp[0] : big ? n.e.x : a.e.x + (n.e.x - a.e.x) * k,
          y: rp ? rp[1] : big ? n.e.y : a.e.y + (n.e.y - a.e.y) * k,
          z: rp ? rp[2] : big ? n.e.z : a.e.z + (n.e.z - a.e.z) * k,
          yaw: a.e.yaw + dyaw * k,
          pitch: a.e.pitch + (n.e.pitch - a.e.pitch) * k,
          // 观战摄像机读的是这一份：按**插值后**的角度重建，不拿上一帧的旧朝向
          aim: { yaw: a.e.yaw + dyaw * k, pitch: a.e.pitch + (n.e.pitch - a.e.pitch) * k },
          crouch: a.e.crouch + (n.e.crouch - a.e.crouch) * k,
          vx: a.e.vx + (n.e.vx - a.e.vx) * k,
          vz: a.e.vz + (n.e.vz - a.e.vz) * k,
          ropeT,
        };
      }
    }
    return b[b.length - 1].e;
  }

  /**
   * 观战视图数据（只读）：被观战队友的名字 / 血量 / 弹药 / 手上的枪。
   * 数据全部来自服务器下发的 CombatUpdate.squad（**只含队友，绝不含敌人**），客户端不自己算；
   * 还没收到 squad（或目标已不在队里）时返回 null，调用方按「只有摄像机、没有 HUD 数字」降级。
   */
  function spectateViewFor(pid: number | null): { id: number; name: string; hp: number; mag: number; reserve: number; weapon: WeaponId } | null {
    if (pid === null) return null;
    const s = squadMates.find((m) => m.id === pid);
    if (!s) return null;
    return { id: pid, name: names.get(pid) ?? '队友', hp: s.hp, mag: s.mag, reserve: s.reserve, weapon: s.weapon };
  }

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const nowMs = performance.now();
    lastRenderMs = nowMs;
    frameCount++;
    const dtFrame = Math.min(0.25, (nowMs - last) / 1000);
    last = nowMs;
    lastFrameDt = dtFrame;
    const renderT = remoteClock.advance(nowMs / 1000);

    const cs = combatSelf;
    const myAlive = cs ? cs.alive : true;
    const tickFloat = estTickFloat();
    const weapon = cs?.weapon ?? 'vandal';
    const localTeam = currentTeam = infectionHud?.currentTeam ?? initialTeam;
    infectionHud?.update(Math.floor(tickFloat));
    const infectedNow = infectionHud?.currentTeam === 1;
    equipmentBtn.hidden = infectionMode && infectionHud?.currentTeam !== 0;
    hud.setInfectedOnly(infectedNow);
    scoreboard.setMyTeam(localTeam);
    if (infectedNow && myAlive && cs?.weapon !== 'melee' && selectingWeapon !== 'melee') selectWeapon('melee');
    const ads = WEAPON_ADS[weapon];
    const economy: BuyEconomyView | null = o.settings.mode === 'snd'
      ? {
        credits: cs?.credits ?? 0,
        owned: cs?.owned ?? [],
        armorKind: cs?.armorKind ?? null,
        armor: cs?.armor ?? 0,
        buying: buyWindowOpen(),
      }
      : null;
    // SND：只有购买窗内能开菜单；TDM：活着就能（免费切换）
    buyMenu.update(weapon, o.settings.mode === 'snd' ? buyWindowOpen() : cs?.alive === true && (!infectionMode || infectionHud?.currentTeam === 0), economy);
    if (weapon !== adsWeapon) {
      adsWeapon = weapon;
      adsLevel = 0;
      adsBlockedUntilMs = 0;
    }
    const aimPresses = input.consumeAimPresses();
    const readyToAct = selectingWeapon === null && audioWeapon === weapon && !!weaponView?.ready(weapon);
    const canAim = input.locked && myAlive && readyToAct && !buyMenu.isOpen && !matchMenu.isOpen && !scoreboard?.isModal && !!ads && !(cs && (cs.reloadUntil > tickFloat || cs.equipUntil > tickFloat));
    if (!canAim) {
      adsLevel = 0;
      // 装备 / 音频准备期间的点击留一次，就绪后补上；菜单、死亡、无 ADS 武器直接丢弃。
      if (!input.locked || !myAlive || buyMenu.isOpen || matchMenu.isOpen || scoreboard?.isModal || !ads) pendingAimPresses = 0;
      else pendingAimPresses = Math.min(1, pendingAimPresses + aimPresses);
    } else if (input.touch && weapon === 'melee') {
      adsLevel = input.buttons.aim ? 1 : 0;
      pendingAimPresses = 0;
    } else if (nowMs >= adsBlockedUntilMs) {
      // 触屏与桌面同一套逐档切换：点一次开镜，再点进下一档，最后一档后回腰射。
      const levels = ads!.zoomMultipliers.length;
      const presses = aimPresses + pendingAimPresses;
      pendingAimPresses = 0;
      for (let i = 0; i < presses; i++) adsLevel = (adsLevel + 1) % (levels + 1);
    }
    const aiming = adsLevel > 0;
    touchUi?.setState(weapon, aiming, infectedNow);
    const wantZoom = aiming ? ads!.zoomMultipliers[adsLevel - 1] : 1;
    if (wantZoom !== zoomTarget) {
      zoomFrom = zoom;
      zoomTarget = wantZoom;
      adsBlendFrom = adsBlend;
      adsBlendTarget = aiming ? 1 : 0;
      zoomStartedAtMs = nowMs;
      zoomDurationMs = (aiming ? ads!.transitionSeconds : ads?.zoomOutSeconds ?? 0) * 1000;
      if (zoomDurationMs === 0) {
        zoom = zoomTarget;
        adsBlend = adsBlendTarget;
        engine.setFov(profile.fov, zoom);
      }
    }
    if (zoom !== zoomTarget) {
      const progress = zoomDurationMs > 0 ? Math.min(1, (nowMs - zoomStartedAtMs) / zoomDurationMs) : 1;
      adsBlend = adsBlendFrom + (adsBlendTarget - adsBlendFrom) * progress;
      const nextZoom = zoomFrom + (zoomTarget - zoomFrom) * progress;
      if (nextZoom !== zoom) {
        zoom = nextZoom;
        engine.setFov(profile.fov, zoom);
      }
    }
    // 开镜时灵敏度乘 profile.adsMultiplier；触摸拖拽按像素算，系数比鼠标点数大得多。
    const m = input.consumeMouse();
    mouseEventsPerFrame = m.events;
    mouseMaxDx = m.maxDx;
    const k = ((input.touch ? TOUCH_YAW_PER_PX : YAW_PER_COUNT_DEG) * profile.sensitivity * (aiming ? profile.adsMultiplier : 1) * Math.PI) / 180;
    if (!scoreboard?.isModal) {
      yaw -= m.dx * k;
      pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - m.dy * k));
    }

    if (self) {
      acc += dtFrame;
      let buttons = 0;
      // 死亡：按钮全 0（服务器也不受理死者的开火 / 移动），但命令照发，维持 ack 与 seq 单调
      if (input.locked && myAlive && !buyMenu.isOpen && !matchMenu.isOpen && !scoreboard?.isModal) {
        for (const [name, bit] of BUTTON_BITS) if (input.buttons[name]) buttons |= bit;
        buttons &= ~BTN.aim;
        if (weapon === 'melee' ? input.buttons.aim : aiming) buttons |= BTN.aim;
        if (!readyToAct) buttons &= ~(BTN.fire | BTN.aim | BTN.reload);
      }
      const qy = quantYaw(yaw), qp = quantPitch(pitch);
      const vt = viewTickNow();
      const fresh: UserCmd[] = [];
      while (acc >= TICK_DT && fresh.length < 8) {
        acc -= TICK_DT;
        const c: UserCmd = { seq: ++seq, buttons, yaw: qy, pitch: qp, viewTick: vt };
        if (myAlive) {
          // 插值起点 = 这一步之前的位置（每步都记，所以一条命令都没产生时也保留着上一 tick 的起点）
          prevPos.x = self.x;
          prevPos.y = self.y;
          prevPos.z = self.z;
          prevPos.crouch = self.crouch;
          stepPlayer(self, c, frozen || rooted, loaded.bvh, weapon, (c.buttons & BTN.aim) !== 0, ropes, combatSelf?.moveSpeedMultiplier ?? 1);
        }
        const predictionNow = (prediction.tick + 1) / TICK_RATE;
        prediction.command(c, myAlive, frozen || weaponLock, {
          speed: speed2(self), grounded: self.grounded, crouch: self.crouch,
          crouchHeld: (buttons & BTN.crouch) !== 0, walking: (buttons & BTN.walk) !== 0,
          landT: self.landT < 0 ? undefined : predictionNow - (c.seq / TICK_RATE - self.landT),
          landV: self.landV, tagged: self.tag >= 0, tagSpeed: speed2(self),
          tagState: !self.grounded ? 2 : self.crouch >= 1 ? 3 : (buttons & BTN.walk) !== 0 ? 0 : 1,
        });
        pending.push(c);
        fresh.push(c);
      }
      if (acc >= TICK_DT) acc = 0; // 卡顿太久：丢掉补不完的时间，不一次性狂发
      if (pending.length > 128) pending.splice(0, pending.length - 128);
      if (fresh.length) {
        if (o.conn.status === 'open' && o.conn.generation === connectionGeneration) {
          for (const command of fresh) networkMetrics.sent(command.seq, nowMs);
        }
        o.conn.sendBinary(encodeInput(fresh), connectionGeneration);
      }
    }

    // 渲染偏移衰减
    err.multiplyScalar(Math.exp(-SMOOTH_RATE * dtFrame));
    if (err.lengthSq() < 1e-6) err.set(0, 0, 0);

    // 观战（阶段11，产品决策 2/4）：服务器指定了目标、且自己确实已阵亡 → 第一人称跟随被观战队友的
    // 位置 + 朝向（aim 已按插值重建）。目标还没进插值缓冲 / 已离场时不跟随（退回死亡点自由转头），
    // 不让画面闪一下。renderT 就是远程实体插值用的服务器时刻。
    const specRemote = !myAlive && spectatePid !== null ? remotes.get(spectatePid) ?? null : null;
    const specView = specRemote ? sampleRemote(specRemote, renderT - SPECTATE_EXTRA_DELAY) : null;

    if (debugCam) {
      engine.camera.position.copy(debugCam.pos);
      engine.camera.lookAt(debugCam.look);
    } else if (self) {
      // 本地插值：两个预测 tick 之间按帧平滑（alpha = 这一步已经走了多少），视角不插值
      const alpha = Math.min(1, Math.max(0, acc / TICK_DT));
      const view = {
        ...self,
        x: prevPos.x + (self.x - prevPos.x) * alpha,
        y: prevPos.y + (self.y - prevPos.y) * alpha,
        z: prevPos.z + (self.z - prevPos.z) * alpha,
        crouch: prevPos.crouch + (self.crouch - prevPos.crouch) * alpha,
      };
      if (myAlive) {
        specCam.init = false;
        const eye = eyeHeight(view);
        lastView.x = view.x;
        lastView.y = view.y;
        lastView.z = view.z;
        lastView.eye = eye;
        engine.camera.position.set(view.x + err.x, view.y + err.y + eye, view.z + err.z);
      } else if (specView) {
        // 观战：摄像机贴在被观战队友的眼睛上，朝向直接读他的 aim（不掺本地鼠标角度与后坐力）。
        // 相机单独平滑：网络抖动 / 目标换人时不硬跳；目标切换直接吸附，避免跨图滑行。
        const eye = eyeHeight({ crouch: specView.crouch } as MoveState);
        const tx = specView.x, ty = specView.y + eye, tz = specView.z;
        if (specCam.id !== spectatePid || !specCam.init) {
          specCam.pos.set(tx, ty, tz);
          specCam.yaw = specView.yaw;
          specCam.pitch = specView.pitch;
          specCam.id = spectatePid; specCam.init = true;
        } else {
          const k = 1 - Math.exp(-SPECTATE_CAM_SMOOTH * dtFrame);
          specCam.pos.lerp(specCam.target.set(tx, ty, tz), k);
          let dyaw = specView.yaw - specCam.yaw;
          dyaw -= Math.round(dyaw / (2 * Math.PI)) * 2 * Math.PI;
          specCam.yaw += dyaw * k;
          specCam.pitch += (specView.pitch - specCam.pitch) * k;
        }
        engine.camera.position.copy(specCam.pos);
        engine.camera.rotation.set(specCam.pitch, specCam.yaw, 0);
      } else {
        // 死亡且没有存活队友：镜头留在死亡点（只能转头看），位置不再跟着尸体走；倒计时由 HUD 显示
        specCam.init = false;
        if (!deadCam) deadCam = { x: view.x, y: view.y, z: view.z, eye: eyeHeight(view) };
        engine.camera.position.set(deadCam.x, deadCam.y + deadCam.eye, deadCam.z);
      }
      // 本地相机立即跟随共享预测；真实命中/伤害仍只读权威事件。
      const localRecoil = myAlive && prediction.state?.weapon === weapon ? firingState(prediction.state, prediction.tick + acc / TICK_DT) : null;
      const targetYaw = localRecoil?.cameraYaw ?? cs?.recoilYaw ?? 0;
      const targetPitch = localRecoil?.cameraPitch ?? cs?.recoilPitch ?? 0;
      const ease = 1 - Math.exp(-RECOIL_RATE * dtFrame);
      recoil.yaw += (targetYaw - recoil.yaw) * ease;
      recoil.pitch += (targetPitch - recoil.pitch) * ease;
      if (myAlive) engine.camera.rotation.set(pitch + recoil.pitch, yaw + recoil.yaw, 0);
    }

    /** 当前画面朝向：活着 / 自由转头用本地角度，观战用被观战队友的朝向（小地图箭头、声音朝向都跟它） */
    const spectating = specView !== null;
    const viewYaw = specView ? specView.yaw : yaw + recoil.yaw;
    audio.setVolume(profile.volume);
    audio.setListenerYaw(viewYaw);
    // Reuse predicted movement and received snapshots: no footstep network messages.
    if (self && footsteps.update(o.myId, self.x, self.z, speed2(self),
      myAlive && !frozen && !rooted && self.grounded && self.rope < 0 &&
        !input.buttons.walk && !input.buttons.crouch && self.crouch < 0.1, nowMs / 1000)) {
      audio.playStep(self, engine.camera.position, true);
    }
    // HUD / 第一人称换弹用本地预测时间线：开火扣弹与按 R 换弹当帧生效，不等 16 Hz combat 包。
    // 伤害、命中、死亡仍然只认权威事件。
    const hudState = cs
      ? predictedHud(cs, prediction.state, selectingWeapon, tickFloat, prediction.tick + Math.max(0, Math.min(1, acc / TICK_DT)))
      : null;

    // 别人
    // 观察者视野门控：活着时观察者是自己，观战时是被观战队友（摄像机就在他眼睛上）；
    // 敌人的模型与小地图红点用同一个视锥 + 同一份雷达口径。
    const hasObserver = myAlive || spectating;
    engine.camera.updateMatrixWorld(true);
    radarMatrix.multiplyMatrices(engine.camera.projectionMatrix, engine.camera.matrixWorldInverse);
    radarFrustum.setFromProjectionMatrix(radarMatrix);
    for (const r of remotes.values()) {
      const e = sampleRemote(r, renderT);
      if (!e) continue;
      const aliveFlag = (e.flags & EF_ALIVE) !== 0;
      const onRope = e.rope >= 0 && e.rope < ropes.length;
      const stepSpeed = Math.hypot(e.vx, e.vz);
      // Snapshots do not carry the walk key. Even the fastest quiet walk is
      // at most 4.05 m/s, so stay silent below this conservative threshold.
      if (footsteps.update(r.id, e.x, e.z, stepSpeed,
        hasObserver && !frozen && aliveFlag && !onRope && (e.flags & EF_GROUNDED) !== 0 &&
          e.crouch < 0.1 && stepSpeed > 4.1, nowMs / 1000)) {
        audio.playStep(e, engine.camera.position, r.id === spectatePid);
      }
      // 攀爬速度（米/秒，正 = 向上）：由两帧 ropeT 差算出，喂给动画（复用 locomotion，步频跟着爬速）
      let climb = 0;
      if (onRope) {
        if (r.prevRope === e.rope && dtFrame > 1e-4) climb = ((e.ropeT - r.prevRopeT) / dtFrame) * ropeLength(ropes[e.rope]);
        r.prevRope = e.rope;
        r.prevRopeT = e.ropeT;
      } else r.prevRope = -1;
      r.model.root.position.set(e.x, e.y, e.z);
      r.model.setInfected(infectionMode && (e.flags & EF_TEAM1) !== 0);
      // 可见性交给模型自己判（产品决策 7）：敌人只在观察者视野内渲染（超视距 / 墙后不上场），
      // 队友不受门控；观战目标本人不渲染（第一人称摄像机正贴在他眼睛上，画出来只会糊住画面）。
      r.model.updateVisibility(loaded.bvh, engine.camera, radarFrustum, e.crouch, aliveFlag && r.id !== spectatePid, hasObserver);
      r.model.update({ vx: e.vx, vz: e.vz, yaw: e.yaw, crouch: e.crouch, grounded: (e.flags & EF_GROUNDED) !== 0, onRope, climb }, dtFrame);
      r.model.updateTeamMarker(engine.camera, loaded.bvh, e.crouch);
      r.last = e;
      while (r.buf.length > 2 && r.buf[1].t < renderT - 0.5) r.buf.shift();
    }

    // 攀绳：绳索高亮 + 本地吸附提示（挂在绳上时显示「前进=上 / 后退=下」）
    ropeView.update(self, self?.rope ?? -1);
    const ropeText = ropeView.hint(self, self?.rope ?? -1);
    ropeHint.textContent = ropeText ?? '';
    ropeHint.style.display = ropeText ? '' : 'none';

    // 小地图以 10Hz 更新，最多为五名敌人测一次胸口视线；不每帧遍历地图/重建 Canvas。
    if (nowMs >= nextRadarAt) {
      nextRadarAt = nowMs + 100;
      const contacts: RadarContact[] = [];
      for (const r of remotes.values()) {
        const e = r.last; if (!e) continue;
        const team = (e.flags & EF_TEAM1) !== 0 ? 1 : 0, ally = team === localTeam;
        const living = (e.flags & EF_ALIVE) !== 0;
        if (!ally) {
          // 敌人红点（产品决策 6）：观察者是「自己（活着）或正在观战的队友」——摄像机已经贴在被观战
          // 队友的眼睛上，所以这里仍只靠一个镜头 + 一份 inView 逻辑，不另开一套。
          if (!hasObserver || !living || debugCam || (localTeam !== 0 && localTeam !== 1)) continue;
          radarPoint.set(e.x, e.y + 1.15 - .3 * e.crouch, e.z);
          if (!radarEnemyVisible(loaded.bvh, engine.camera.position, radarPoint, radarFrustum.containsPoint(radarPoint))) continue;
        }
        contacts.push({ id: r.id, x: e.x, z: e.z, yaw: e.yaw, alive: living, ally });
      }
      // 观战时箭头跟着被观战队友（摄像机所在位置），状态文字写「观战中·名字」，不再写「等待复活」
      minimap.update({
        self: { x: engine.camera.position.x, z: engine.camera.position.z, yaw: viewYaw, alive: myAlive || spectating },
        contacts,
        spectating: spectating ? names.get(spectatePid as number) ?? '队友' : null,
      });
    }

    // 战斗显示层：弹道 / 弹孔 → 世界 → 第一人称武器（最后画，清 depth 所以不会被墙挡住）
    effects.update(dtFrame);
    const scoped = myAlive && aiming && (weapon === 'marshal' || weapon === 'outlaw' || weapon === 'operator');
    scope.style.display = scoped && adsBlend > 0 ? 'block' : 'none';
    scope.style.opacity = String(adsBlend);
    // 观战时画面不是自己在瞄：准星收起来（只展示被观战队友的枪与他的朝向）
    crosshair.style.display = scoped || spectating ? 'none' : '';
    // 原站默认 adsUsePrimary 沿用主准星；只有狙击镜替换为镜内白点。
    // 全息刻线在 ADS 姿态超过 .45 后渐显，换弹/切枪/死亡立刻清掉，正常收镜则随姿态淡出。
    const sightWidth = adsSightWidthPercent(weapon, zoom);
    const sightOpacity = canAim && !scoped && sightWidth > 0 ? Math.max(0, Math.min(1, (adsBlend - 0.45) / 0.55)) : 0;
    adsSight.style.display = sightOpacity > 0 ? '' : 'none';
    adsSight.style.opacity = String(sightOpacity);
    adsSight.style.setProperty('--ads-sight-width', `${sightWidth}vw`);
    // 第一人称枪：观战时画的是**被观战队友手里那把枪**（产品决策 3/2），自己活着时照旧画自己的枪。
    const spectator = spectating ? spectateViewFor(spectatePid) : null;
    const shownWeapon = spectator ? spectator.weapon : cs?.weapon ?? 'vandal';
    // 只有预测武器和画面里的枪一致时才用预测换弹时长；切枪等待服务器确认期间仍按权威状态。
    const localReload = !spectating && hudState && hudState.self.weapon === shownWeapon ? hudState : null;
    const weaponState = {
      weapon: shownWeapon,
      agent: spectating ? byId.get(spectatePid)?.agent ?? myAgent : myAgent,
      alive: myAlive || spectating,
      infected: infectionMode && (spectating ? infectionHud?.teamOf(spectatePid!) === 1 : infectedNow),
      moving: self ? speed2(self) : 0,
      adsProgress: spectating ? 0 : adsBlend,
      zoom: spectating ? 1 : zoom,
      hidden: (scoped && adsBlend > 0.9) || (spectating && !spectator),
      walking: input.buttons.walk || input.buttons.crouch,
      reloadElapsed: localReload && localReload.self.reloadUntil > localReload.tick
        ? Math.max(0, WEAPONS[shownWeapon].reload - (localReload.self.reloadUntil - localReload.tick) / TICK_RATE)
        : null,
      equipElapsed: spectating || equipStartedSec === null ? null : Math.max(0, tickFloat / TICK_RATE - equipStartedSec),
      // HUD 使用整数tick；第一人称动画使用连续估计，避免32Hz阶梯采样。
      reloadProgress: localReload ? reloadProgressOf(localReload.self, localReload.tick) : 0,
    };
    weaponView?.update(dtFrame, weaponState);
    // 消息可能在两帧之间到达：先推进旧特效、更新相机和枪姿态，再创建本帧待呈现的特效。
    engine.camera.updateMatrixWorld(true);
    for (const { attack, tick } of localShots.splice(0)) {
      if (!myAlive || debugCam || attack.weapon !== weaponState.weapon) continue;
      weaponView?.fire(attack.heavy, tick / TICK_RATE);
      weaponView?.update(0, weaponState);
    }
    for (const event of meleeStarts.splice(0)) {
      if (debugCam || weaponState.weapon !== 'melee') continue;
      if (!(event.player === o.myId && myAlive) && !(spectating && event.player === spectatePid)) continue;
      equipStartedSec = null;
      weaponView?.fire(event.heavy, event.tick / TICK_RATE);
      weaponView?.update(0, weaponState);
    }
    for (const event of visualShots.splice(0)) {
      let hasMuzzle = false;
      if (event.shooter === o.myId && myAlive && !debugCam && event.weapon === weaponState.weapon) {
        if (!event.feedbackPredicted) {
          equipStartedSec = null;
          weaponView?.fire(event.heavy === true, event.atTick / TICK_RATE);
          weaponView?.update(0, weaponState);
        }
        hasMuzzle = weaponView?.getMuzzleWorld(engine.camera, muzzleWorld) ?? false;
      } else if (event.shooter !== o.myId) {
        hasMuzzle = remotes.get(event.shooter)?.model.getMuzzleWorld(muzzleWorld) ?? false;
      }
      effects.shot(event, hasMuzzle ? muzzleWorld : undefined);
    }
    if (hudState) hud.update(hudState.self, hudState.tick);
    for (const remote of remotes.values()) {
      const last = remote.last;
      if (!last) continue;
      const team = (last.flags & EF_TEAM1) !== 0 ? 1 : 0;
      remote.model.setAllegiance(allegianceOf(localTeam, team), remote.member?.name ?? '玩家');
    }
    // 没图可跟（活着）时传 null，HUD 把观战面板整块收起来。
    hud.setSpectate(spectateEnabled && (spectating || !myAlive) ? {
      target: spectator,
      mates: squadMates.map((s) => ({ id: s.id, name: names.get(s.id) ?? '队友', hp: s.hp, alive: s.alive })),
      freeLook: !spectating,
      touch: input.touch,
    } : null);
    touchUi?.setSpectate(spectateEnabled && !myAlive, spectator ? spectateLabel(spectator.name) : SPECTATE_FREE_LOOK);
    roundHud.update(tickFloat);
    tdmHud?.update(tickFloat);
    hud.setMenu(!input.locked);

    loaded.render.update(engine.camera);
    engine.renderer.clear();
    engine.renderer.render(engine.scene, engine.camera);
    effects.render(engine.camera);
    // 观战时也要画第一人称枪（画的是被观战队友那把）
    if ((myAlive || spectating) && !debugCam) weaponView?.render();

    if (nowMs - snapRateT > 1000) {
      diagnostics.fps = frameCount * 1000 / (nowMs - snapRateT);
      diagnostics.snapshotHz = snapCount * 1000 / (nowMs - snapRateT);
      networkMetrics.publish(nowMs, o.conn.buffered);
      frameCount = 0;
      snapRate = (snapCount * 1000) / (nowMs - snapRateT);
      snapCount = 0;
      snapRateT = nowMs;
    }
    if (self) {
      tmp.set(self.x, self.y, self.z);
      devHud.textContent =
        `${o.settings.map}  pos ${tmp.x.toFixed(2)} ${tmp.y.toFixed(2)} ${tmp.z.toFixed(2)}  speed ${speed2(self).toFixed(2)}  ` +
        `tick ${lastSnapTick}  快照 ${snapRate.toFixed(0)}/s  未确认 ${pending.length}  误差 ${(err.length() * 100).toFixed(1)}cm  玩家 ${remotes.size + 1}` +
        `  插值${(remoteClock.delay * 1000).toFixed(0)}ms  断档${remoteClock.underrunFrames}  鼠标${mouseEventsPerFrame}e/f maxDx${mouseMaxDx}` +
        (self.rope >= 0 ? `  绳 ${ropes[self.rope]?.id ?? self.rope} t=${self.ropeT.toFixed(2)}` : '') +
        (cs ? `  hp ${cs.hp}  ${cs.weapon} ${cs.mag}/${cs.reserve}  战斗tick ${combatTick}  事件 ${shotsSeen}` : '  战斗：等待状态');
    }
  };
  raf = requestAnimationFrame(frame);

  const rt: MatchRuntime = {
    // 已认领的新运行时可能尚未收到 self/combat，再次断线时不能丢掉接回的本地朝向。
    captureView: () => (self || o.resumeView) && combatSelf?.alive !== false ? { yaw, pitch } : null,
    dispose() {
      if (disposed) return;
      disposed = true;
      runTeardown();
    },
  };
  teardown.push(() => cancelAnimationFrame(raf));
  teardown.push(clearDiagnostics);
  teardown.push(() => input.dispose());
  teardown.push(() => {
    for (const r of remotes.values()) r.model.dispose();
    remotes.clear();
  });

  const api = {
    engine,
    get self() {
      return self;
    },
    get remotes() {
      return remotes;
    },
    get pending() {
      return pending.length;
    },
    get err() {
      return err.length();
    },
    /** 最新一份自己的战斗状态（只读验收用；没收到时是 null） */
    get combat() {
      return combatSelf;
    },
    /** 攀绳（只读验收用）：自己是否挂在绳上 / 绳索下标 / t / 绳索名字，没挂绳时 null */
    get onRope() {
      if (!self || self.rope < 0) return null;
      return { id: ropes[self.rope]?.id ?? String(self.rope), index: self.rope, t: self.ropeT };
    },
    /** 攀绳吸附提示文案（没有返回 null）；验收脚本用它判断「是否出现吸附提示」 */
    ropeHint: () => ropeView.hint(self, self?.rope ?? -1),
    /**
     * 观战（阶段11）只读验收数据：服务器指定的目标 pid + 名字 / 血量 / 弹药 / 枪 + 队友列表。
     * 没有观战（活着 / 没有存活队友）时 target 为 null；不提供写目标 / 伪造可见性的入口。
     */
    get spectate() {
      return {
        pid: spectatePid,
        target: spectateViewFor(spectatePid),
        mates: squadMates.map((s) => ({ id: s.id, name: names.get(s.id) ?? '队友', hp: s.hp, alive: s.alive, weapon: s.weapon, mag: s.mag, reserve: s.reserve })),
        camera: { x: engine.camera.position.x, y: engine.camera.position.y, z: engine.camera.position.z },
      };
    },
    /** 本图绳索清单（只读） */
    ropeList: () => ropes.map((r) => ({ id: r.id, top: [...r.top], bottom: [...r.bottom] })),
    get score() { return scoreboard?.snapshot ?? null; },
    radarStats: () => minimap.stats(),
    /** 只读验收（阶段9 经济）：每个远程实体此刻的护甲与手上的枪，给「人机按余额分层购买」的截图用 */
    remoteLoadout: () => [...remotes.values()].map((r) => ({
      id: r.id,
      armor: r.last?.armor ?? 0,
      armorKind: r.last?.armorKind ?? 0,
      weapon: remoteWeapons.get(r.id) ?? null,
    })),
    /** 第一人称枪械是否真的就位：create() 里 await 完素材并 attachActive() 才 resolve，
     *  所以这里除了非空还读一次内部的 active——true 代表「有挂上去的枪」，不是「promise 建过了」 */
    get weaponReady() {
      return !!weaponView && activeRigOf(weaponView);
    },
    /** 只读特效验收数据；不提供改时间或伪造命中的接口。 */
    effectsStats: () => effects.stats(),
    weaponFxStats: () => weaponView?.stats() ?? null,
    weaponError: weaponError ? String((weaponError as Error)?.message ?? weaponError) : null,
    setView: (y: number, p: number) => ((yaw = y), (pitch = p)),
    setDebugCam: (pos: number[] | null, look?: number[]) =>
      (debugCam = pos && look ? { pos: new THREE.Vector3(...pos), look: new THREE.Vector3(...look) } : null),
    // fps/seq/acked 给旧断言用；snapshots/tick/lastRenderMs/frozen 给独立测量用（协议不变）
    // combatTick/shotsSeen：只读验收（战斗状态对应的服务器 tick / 处理过多少条 shot 事件）
    stats: () => ({ fps: 1 / Math.max(1e-3, lastFrameDt), seq, acked, snapshots: totalSnapshots, tick: lastSnapTick, lastRenderMs, frozen, combatTick, shotsSeen, localFeedbacks, lastLocalFeedbackMs, interpDelayMs: remoteClock.delay * 1000, interpStalls: remoteClock.underrunFrames, snapJitter: remoteClock.jitter * 1000, snapshotMaxGapMs: remoteClock.maxGap * 1000, renderTickFloat: remoteClock.time / TICK_DT, mouseEventsPerFrame, mouseMaxDx }),
    input,
  };
  Object.assign(window, { __MATCH: api });
  teardown.push(() => {
    // 只清自己这一局挂上去的对象：下一局可能已经把它自己的 __MATCH 换上了，不能顺手清掉别人的
    const w = window as unknown as { __MATCH?: unknown };
    if (w.__MATCH === api) w.__MATCH = null;
  });
  return rt;
}
