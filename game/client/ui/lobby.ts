// lobby.ts — 大厅：以「PvP 对战」为主入口
//   顶部：快速开始（一键进人机局，旁边只有 模式 / 地图 两个紧凑选项）+ 创建房间，其余设置收进「更多设置」
//   主体：房间列表（筛选 / 整行点击加入 / 对局中显示「查看房间」，进去只是看成员，没有观战摄像机）；房间号加入降级到列表底部
import type { Difficulty, MapId, Mode } from '../../shared/catalog.ts';
import { AGENT_BY_ID, DIFFICULTIES, MAPS, MAP_BY_ID, MODES } from '../../shared/catalog.ts';
import type { RoomSettings, RoomSummary } from '../../shared/lobby.ts';
import { DEFAULT_SETTINGS, SCORE_LIMITS } from '../../shared/lobby.ts';
import { app, type Screen } from '../app.ts';
import { profile, saveProfile } from '../profile.ts';
import { isToyEnvironment } from '../toy.ts';
import { FREE_AGENT_ID, isAgentLocked } from '../toy-unlock.ts';
import { agentArt, bg, mapCover, mapSlice } from './art.ts';
import { h, icon, set } from './dom.ts';
import { agentPicker } from './landing.ts';
import { modal, seg, toast, toggle } from './overlay.ts';
import { openSettings } from './settings.ts';
import { openKillLeaderboard } from './leaderboard.ts';
import { createMailEntry } from './mail.ts';
import { checkInputSafety } from '../safety.ts';
import { openFriends } from './friends.ts';

const QP_KEY = 'vpvp.quickplay.v1';
const TEAM_SIZES = [1, 2, 3, 5];
const REFRESH_MS = 5000;

function loadQp(): RoomSettings {
  try {
    const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(QP_KEY) ?? '{}') } as RoomSettings;
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function topbar(active: string, extra?: Node, onSettings: () => void = openSettings) {
  let closeFriends: (() => void) | null = null;
  const net = h('span', { class: 'net-dot' });
  const av = h('div', { class: 'av' });
  const nm = h('b');
  const me = h('div', { class: 'me-chip', title: '修改代号 / 特工', onclick: () => editProfile() }, av, nm);
  const refresh = () => {
    const st = app.conn?.status ?? 'connecting';
    net.className = 'net-dot ' + st;
    // 掉线后正在自动重连时显示「重连中」，不要显示「已断开」—— 那会让人以为连不上了。
    net.textContent = st === 'open' ? '在线' : app.conn?.retrying ? '重连中' : st === 'replaced' ? '已断开' : '连接中';
    net.title = app.conn ? `${app.conn.endpointLabel || '未连接'} · 线路 ${app.conn.line}` : '';
    av.style.backgroundImage = bg(agentArt(profile.agent));
    nm.textContent = profile.name;
  };
  refresh();
  const el = h(
    'div',
    { class: 'topbar' },
    h('div', { class: 'logo' }, h('div', { class: 'logo-mark' }, '峰'), h('span', { class: 'logo-name' }, '尖峰对决')),
    h('nav', { class: 'nav' }, h('a', { class: 'on' }, active)),
    h('div', { class: 'spacer' }),
    extra ?? null,
    net,
    me,
    h('button', { class: 'btn icon ghost', title: '设置', 'aria-label': '设置', onclick: onSettings }, icon('gear')),
    h('button', { class: 'btn ghost', title: '好友', onclick: () => { closeFriends?.(); closeFriends = openFriends(); } }, '好友'),
  );
  return { el, refresh, dispose: () => closeFriends?.() };
}

function editProfile() {
  const toy = isToyEnvironment();
  const name = h('input', {
    class: ['input', toy && 'toy-name-locked'],
    value: profile.name,
    maxLength: 16,
    readOnly: toy,
    title: toy ? 'Toy 内代号由 B站授权/游客随机生成，不可修改' : undefined,
  });
  let agent = profile.agent;
  const body = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:18px' },
    h(
      'div',
      { class: 'field' },
      h('label', null, '代号'),
      name,
      toy ? h('div', { class: 'field-hint' }, 'Toy 内代号由 B站授权/游客随机生成，不可修改') : null,
    ),
    h('div', { class: 'field' }, h('label', null, '特工'), agentPicker(agent, (id) => (agent = id))),
  );
  modal({
    title: '个人资料',
    body,
    okText: '保存',
    onOk: async () => {
      const n = toy ? profile.name : name.value.trim();
      if (!n) {
        toast('代号不能为空');
        return false;
      }
      // 只有玩家真的改了昵称才检测；Toy 里平台授权/游客随机昵称只读，不会走到这里
      if (!toy && n !== profile.name) {
        const safe = await checkInputSafety(n, 'nickname');
        if (!safe.ok) {
          toast(safe.message ?? '内容检测未通过');
          return false;
        }
      }
      saveProfile({ name: n, agent: isAgentLocked(agent) ? FREE_AGENT_ID : agent });
      app.conn?.send({ t: 'profile', name: n, agent: profile.agent });
      app.route();
    },
  });
}

/** 设置表单：创建房间弹窗和房间内的设置弹窗共用 */
export function settingsForm(s: RoomSettings, onChange: (s: RoomSettings) => void, opts: { disabled?: boolean; compact?: boolean } = {}) {
  const el = h('div', { style: 'display:flex;flex-direction:column;gap:18px' });
  const render = () => {
    const modeCards = h(
      'div',
      { class: 'mode-cards' },
      (Object.keys(MODES) as Mode[]).map((m) =>
        h(
          'div',
          {
            class: ['mode-card', s.mode === m && 'on'],
            style: opts.disabled ? 'cursor:default' : '',
            onclick: () => {
              if (opts.disabled || s.mode === m) return;
              s = { ...s, mode: m, scoreLimit: m === 'tdm' ? 50 : 7 };
              onChange(s);
              render();
            },
          },
          h('div', { class: 'mc-en' }, MODES[m].en),
          h('div', { class: 'mc-name' }, MODES[m].name),
          opts.compact ? null : h('div', { class: 'mc-desc' }, MODES[m].desc),
        ),
      ),
    );
    const maps = h(
      'div',
      { class: 'map-grid' },
      MAPS.map((m) =>
        h(
          'div',
          {
            class: ['map-card', s.map === m.id && 'on'],
            style: { backgroundImage: bg(mapSlice(m.id)), cursor: opts.disabled ? 'default' : 'pointer' },
            onclick: () => {
              if (opts.disabled || s.map === m.id) return;
              s = { ...s, map: m.id as MapId };
              onChange(s);
              render();
            },
          },
          h('div', { class: 'mn' }, h('b', null, m.name), h('i', null, m.en)),
        ),
      ),
    );
    const upd = (patch: Partial<RoomSettings>) => {
      s = { ...s, ...patch };
      onChange(s);
    };
    set(
      el,
      h('div', { class: 'field' }, h('label', null, '模式'), modeCards),
      h('div', { class: 'field' }, h('label', null, '地图'), maps),
      h(
        'div',
        { class: 'qp-row' },
        h(
          'div',
          { class: 'field' },
          h('label', null, '对阵规模'),
          seg(
            TEAM_SIZES.map((n) => ({ value: n, label: `${n}v${n}` })),
            s.teamSize,
            (v) => upd({ teamSize: v }),
            { disabled: opts.disabled },
          ),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', null, s.mode === 'tdm' ? '击杀目标' : s.mode === 'infection' ? '胜利条件' : '获胜回合'),
          s.mode === 'infection'
            ? h('span', { class: 'field-hint' }, '感染者消灭人类；人类存活至倒计时结束获胜')
            : seg(
              SCORE_LIMITS[s.mode].map((n) => ({ value: n, label: String(n) })),
              s.scoreLimit,
              (v) => upd({ scoreLimit: v }),
              { disabled: opts.disabled },
            ),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, '人机难度'),
        seg(
          (Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => ({ value: d, label: DIFFICULTIES[d].name })),
          s.botDifficulty,
          (v) => upd({ botDifficulty: v }),
          { disabled: opts.disabled, cls: 'red' },
        ),
      ),
    );
  };
  render();
  return el;
}

function openCreateRoom() {
  let s = loadQp();
  let priv = false;
  const body = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:18px' },
    settingsForm(s, (v) => (s = v), { compact: true }),
    h(
      'div',
      { class: 'room-create-toggles', style: 'display:flex;gap:24px' },
      toggle('开局时用人机补满空位', s.fillBots, (v) => (s = { ...s, fillBots: v })),
      toggle('私密房间（只能用房间号加入）', priv, (v) => (priv = v)),
    ),
  );
  modal({
    title: '创建房间',
    sub: '创建后可以把房间号发给朋友',
    body,
    wide: true,
    okText: '创建',
    onOk: () => {
      app.conn?.send({ t: 'createRoom', name: '', priv, settings: s });
    },
  });
}

/** 大厅主体：顶部两个主操作 + 房间列表 */
export function lobbyScreen(): Screen {
  let rankClose: (() => void) | null = null;
  let qp = loadQp();
  let advanced = false; // 「更多设置」是否展开
  let onlyJoinable = false;
  let modeFilter: Mode | 'all' = 'all';

  const mail = createMailEntry();
  const tb = topbar('大厅', mail.el);
  const bgImg = h('div', { class: 'img', style: { backgroundImage: bg(mapCover(qp.map)) } });
  const list = h('div', { class: 'rooms-list scroll' });
  const count = h('span', { class: 'chip' });
  const qpSub = h('span', { class: 'sub' });
  const moreBtn = h('button', { class: 'btn ghost', 'data-testid': 'more-settings', 'aria-expanded': 'false', onclick: () => toggleMore() }, '更多设置');
  const moreBox = h('div', { class: 'hero-more' });
  const mapSel = h('select', {
    class: 'input map-select',
    'data-testid': 'qp-map',
    'aria-label': '快速开始的地图',
    onchange: () => save({ ...qp, map: mapSel.value as MapId }),
  });
  for (const m of MAPS) mapSel.append(h('option', { value: m.id }, `${m.name} · ${m.en}`));
  mapSel.value = qp.map;

  const code = h('input', {
    class: 'input',
    placeholder: '房间号',
    maxLength: 6,
    'data-testid': 'code-input',
    'aria-label': '房间号',
    oninput: () => {
      const up = code.value.toUpperCase();
      if (up !== code.value) code.value = up;
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') joinByCode();
    },
  });
  const joinByCode = () => {
    const id = code.value.trim().toUpperCase();
    if (!id) {
      code.focus();
      return;
    }
    if (!connected()) return;
    app.conn?.send({ t: 'joinRoom', id });
  };

  const connected = () => {
    const st = app.conn?.status;
    if (st === 'open') return true;
    // 握手期不要误报「连不上」：跨境链路首连可能要几百毫秒，玩家此时已经在连了
    toast(st === 'connecting' ? '正在连接服务器，稍等一下…' : '还没连上服务器');
    return false;
  };

  const save = (s: RoomSettings) => {
    qp = s;
    try {
      localStorage.setItem(QP_KEY, JSON.stringify(qp));
    } catch {}
    bgImg.style.backgroundImage = bg(mapCover(qp.map));
    renderHero();
  };

  const quickPlay = () => {
    if (!connected()) return;
    app.conn?.send({ t: 'quickPlay', settings: qp });
  };

  const toggleMore = (open = !advanced) => {
    advanced = open;
    moreBox.classList.toggle('open', advanced);
    moreBtn.setAttribute('aria-expanded', String(advanced));
    moreBtn.textContent = advanced ? '收起设置' : '更多设置';
  };

  // ---- 顶部：快速开始 / 创建房间 + 紧凑选项 ----
  const goBtn = h(
    'button',
    { class: 'btn primary hero-quick', 'data-testid': 'quick-start', onclick: quickPlay },
    icon('play', 18),
    '快速开始',
    qpSub,
  );
  const createBtn = h(
    'button',
    { class: 'btn ghost', 'data-testid': 'create-room', onclick: openCreateRoom },
    icon('users', 18),
    '创建房间',
  );

  const modeSeg = seg(
    (Object.keys(MODES) as Mode[]).map((m) => ({ value: m, label: MODES[m].name, testid: `qp-mode-${m}` })),
    qp.mode,
    (v) => save({ ...qp, mode: v, scoreLimit: v === 'tdm' ? 50 : 7 }),
  );

  const renderHero = () => {
    qpSub.textContent = `${MODES[qp.mode].name} · ${MAP_BY_ID[qp.map].name}`;
    if (mapSel.value !== qp.map) mapSel.value = qp.map;
    const upd = (patch: Partial<RoomSettings>) => save({ ...qp, ...patch });
    set(
      moreBox,
      h(
        'div',
        { class: 'field' },
        h('label', null, '对阵规模'),
        seg(TEAM_SIZES.map((n) => ({ value: n, label: `${n}v${n}` })), qp.teamSize, (v) => upd({ teamSize: v })),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, qp.mode === 'tdm' ? '击杀目标' : qp.mode === 'infection' ? '胜利条件' : '获胜回合'),
        qp.mode === 'infection'
          ? h('span', { class: 'field-hint' }, '感染者消灭人类；人类存活至倒计时结束获胜')
          : seg(SCORE_LIMITS[qp.mode].map((n) => ({ value: n, label: String(n) })), qp.scoreLimit, (v) => upd({ scoreLimit: v })),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, '人机难度'),
        seg(
          (Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => ({ value: d, label: DIFFICULTIES[d].name })),
          qp.botDifficulty,
          (v) => upd({ botDifficulty: v }),
          { cls: 'red' },
        ),
      ),
    );
  };

  const hero = h(
    'section',
    { class: 'panel lobby-hero' },
    h(
      'div',
      { class: 'hero-body' },
      h(
        'div',
        { class: 'hero-actions' },
        goBtn,
        createBtn,
        h('span', { class: 'hero-tip' }, '快速开始：直接加入正在进行的对局（顶掉一个人机），没有就开一局人机对战'),
      ),
      h(
        'div',
        { class: 'hero-opts' },
        h('span', { class: 'hero-label' }, '模式'),
        modeSeg,
        h('span', { class: 'hero-label' }, '地图'),
        mapSel,
        moreBtn,
      ),
      moreBox,
    ),
  );

  // ---- 房间列表 ----
  const statusFilter = seg<'all' | 'joinable'>(
    [
      { value: 'all', label: '全部', testid: 'filter-all' },
      { value: 'joinable', label: '可加入', testid: 'filter-joinable' },
    ],
    'all',
    (v) => {
      onlyJoinable = v === 'joinable';
      renderRooms();
    },
    { cls: 'sf' },
  );
  const modeFilterSeg = seg<Mode | 'all'>(
    [
      { value: 'all', label: '全部模式', testid: 'filter-mode-all' },
      ...(Object.keys(MODES) as Mode[]).map((m) => ({ value: m, label: MODES[m].name, testid: `filter-mode-${m}` })),
    ],
    'all',
    (v) => {
      modeFilter = v;
      renderRooms();
    },
    { cls: 'mf' },
  );

  const join = (r: RoomSummary) => {
    if (!connected()) return;
    app.conn?.send({ t: 'joinRoom', id: r.id });
  };

  /** 真人超过容量 4 个就连观战席也没有了 */
  const OVER_FULL = 4;

  const row = (r: RoomSummary) => {
    const playing = r.state !== 'waiting';
    const overCap = r.humans >= r.max + OVER_FULL; // 连观战都进不去
    const seatless = !r.joinable; // 还能进房间，但没有队伍位（只能观战）
    const act = () => {
      if (overCap) {
        toast('房间已满，连观战席也没有位置了');
        return;
      }
      join(r);
    };
    return h(
      'div',
      {
        class: ['room-row', playing && 'live'],
        'data-testid': 'room-row',
        'data-id': r.id,
        role: 'button',
        tabindex: 0,
          'aria-label': `${r.name}，${MODES[r.mode].name}，${MAP_BY_ID[r.map].name}，${r.humans}/${r.max} 人，房主 ${r.host}`,
          onclick: act,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          act();
        },
      },
      h('div', { class: 'thumb', style: { backgroundImage: bg(mapSlice(r.map)) } }, h('span', null, MAP_BY_ID[r.map].en)),
      h(
        'div',
        { class: 'rn' },
        h('b', null, r.name),
        h(
          'div',
          { class: 'meta' },
          h('span', { class: 'chip red' }, MODES[r.mode].name),
          h('span', { class: 'chip' }, MAP_BY_ID[r.map].name),
          h('span', { class: 'chip' }, '房主 ', r.host),
          h('span', { class: 'chip' }, '#', r.id),
        ),
      ),
      h('div', { class: 'cnt' }, `${r.humans}/${r.max}`, h('small', null, r.bots ? `+${r.bots} 人机` : '玩家')),
      h(
        'div',
        { class: 'row-actions' },
        h(
          'button',
          {
            class: 'btn sm',
            disabled: overCap,
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              act();
            },
          },
          overCap ? '已满' : playing ? (seatless ? '查看房间' : '加入对局') : seatless ? '观战' : '加入',
        ),
      ),
    );
  };

  const renderRooms = () => {
    const all = app.rooms;
    const shown = all.filter((r) => (modeFilter === 'all' || r.mode === modeFilter) && (!onlyJoinable || r.joinable));
    count.textContent = `${shown.length} 个`;
    if (!all.length) {
      set(
        list,
        h(
          'div',
          { class: 'empty', 'data-testid': 'empty-state' },
          h(
            'div',
            { class: 'empty-in' },
            h('div', { class: 'big' }, '还没有房间'),
            h('p', null, '点「快速开始」直接加入正在进行的对局（可顶掉人机位），或创建房间邀请朋友'),
            h(
              'div',
              { class: 'empty-actions' },
              h('button', { class: 'btn red', 'data-testid': 'empty-quick', onclick: quickPlay }, icon('play', 16), '快速开始'),
              h('button', { class: 'btn', 'data-testid': 'empty-create', onclick: openCreateRoom }, icon('plus', 16), '创建房间'),
            ),
          ),
        ),
      );
      return;
    }
    if (!shown.length) {
      set(
        list,
        h(
          'div',
          { class: 'empty', 'data-testid': 'empty-state' },
          h('div', { class: 'empty-in' }, h('div', { class: 'big' }, '没有符合条件的房间')),
        ),
      );
      return;
    }
    set(list, shown.map(row));
  };

  const el = h(
    'div',
    { class: 'lobby' },
    h('div', { class: 'backdrop' }, bgImg),
    tb.el,
    hero,
    h(
      'div',
      { class: 'lobby-body' },
      h(
        'section',
        { class: 'panel rooms' },
        h(
          'div',
          { class: 'panel-head' },
          h('div', { class: 'panel-title' }, '房间列表'),
          count,
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn ghost kill-entry', 'data-testid': 'kill-leaderboard-open', onclick: () => {
            rankClose?.();
            rankClose = openKillLeaderboard(() => { rankClose = null; });
          } }, icon('crown', 16), '击杀榜'),
          h('button', { class: 'btn icon ghost', 'data-testid': 'refresh-rooms', title: '刷新房间列表', 'aria-label': '刷新房间列表', onclick: () => app.conn?.send({ t: 'listRooms' }) }, icon('refresh')),
        ),
        h(
          'div',
          { class: 'rooms-filters' },
          statusFilter,
          modeFilterSeg,
          h('div', { class: 'spacer' }),
          h('span', { class: 'auto-note' }, '列表自动刷新'),
        ),
        list,
        h(
          'div',
          { class: 'rooms-foot' },
          h('span', { class: 'label' }, '有房间号？'),
          code,
          h('button', { class: 'btn sm', 'data-testid': 'code-join', onclick: joinByCode }, '加入'),
        ),
      ),
    ),
  );

  renderHero();
  toggleMore(false);

  // 除了服务器的变化推送，再定时拉一次，保证列表不陈旧
  const timer = setInterval(() => app.conn?.send({ t: 'listRooms' }), REFRESH_MS);

  // 只在列表真的变了才重建行（否则每 5 秒一次的刷新会让行重新播进场动画）
  let lastRooms = '';
  return {
    el,
    dispose() {
      clearInterval(timer);
      tb.dispose();
      rankClose?.();
      mail.dispose();
    },
    update() {
      tb.refresh();
      const sig = JSON.stringify(app.rooms);
      if (lastRooms !== sig) {
        lastRooms = sig;
        renderRooms();
      }
    },
  };
}

export { AGENT_BY_ID };