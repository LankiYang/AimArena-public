// room.ts — 房间：两队阵容 + 观战席，房主管人机 / 设置 / 开局，队员选队伍 / 特工 / 准备
//   · 等待中：每队标题栏：+ 添加人机 / 补满本队；顶部：一键补满双方人机（仅房主）；人机卡片可改难度 / 换队 / 移除
//   · 房主开始不再被「他人未准备」阻塞，改为开局前确认；开始被挡住时旁边写明原因（可点击直接修）
//   · 对局进行中：队伍 / 人机 / 设置的入口收起或禁用；观战的人对局里有空位时可以「加入对局」
//   · 真人队员：房主点「管理」可以转让房主或移出；掉线的人卡片变灰、写明「保留座位」，房主要等他回来（或移出）才能开局
import type { Difficulty, Team } from '../../shared/catalog.ts';
import { AGENT_BY_ID, DIFFICULTIES, MAP_BY_ID, MODES, TEAM_NAMES } from '../../shared/catalog.ts';
import { hasMatchSeat, type Member, type RoomInfo } from '../../shared/lobby.ts';
import { app, type Screen } from '../app.ts';
import { profile, saveProfile } from '../profile.ts';
import { agentArt, bg, mapCover } from './art.ts';
import { h, icon, set } from './dom.ts';
import { agentPicker } from './landing.ts';
import { settingsForm, topbar } from './lobby.ts';
import { modal, toast, toggle } from './overlay.ts';
import { openSettings } from './settings.ts';
import { linkNotice } from './link.ts';

const send = (m: Parameters<NonNullable<typeof app.conn>['send']>[0]) => app.conn?.send(m);

/** 提示条颜色：规格 §2.2 的 red / neutral / ok */
type Tone = 'red' | 'neutral' | 'ok';
/** 提示条旁边的一个可点操作（例如观战中「加入对局」） */
interface Act {
  label: string;
  run: () => void;
}
/** 开始 / 准备 / 提示条的统一状态（barState 的返回值） */
interface BarState {
  tone: Tone;
  text: string;
  btnDisabled: boolean;
  reason: string;
  fix: (() => void) | null;
  U: number;
  act: Act | null;
}

const DIFF_ORDER = Object.keys(DIFFICULTIES) as Difficulty[];
const other = (t: Team): Team => (t === 0 ? 1 : 0);
const countIn = (room: RoomInfo, t: Team) => room.members.filter((m) => m.team === t).length;

/** 人机卡片上房主的三个操作：难度（点击循环）/ 换队 / 移除 */
function botOps(m: Member, team: Team, room: RoomInfo) {
  const mode = room.settings.mode;
  const diff = m.difficulty ?? 'normal';
  const next = DIFF_ORDER[(DIFF_ORDER.indexOf(diff) + 1) % DIFF_ORDER.length];
  const to = other(team);
  return h(
    'div',
    { class: 'slot-ops' },
    h(
      'button',
      {
        class: 'btn sm ghost bot-diff',
        'data-testid': `bot-diff-${m.id}`,
        title: `点击切换难度：${DIFF_ORDER.map((d) => DIFFICULTIES[d].name).join(' → ')}（当前 ${DIFFICULTIES[diff].name}）`,
        'aria-label': `${m.name} 的难度：${DIFFICULTIES[diff].name}，点击改为 ${DIFFICULTIES[next].name}`,
        onclick: () => send({ t: 'setBot', id: m.id, difficulty: next }),
      },
      '难度',
      h('b', null, DIFFICULTIES[diff].name),
    ),
    h(
      'button',
      {
        class: 'btn icon sm ghost',
        'data-testid': `bot-swap-${m.id}`,
        title: `换到${TEAM_NAMES[mode][to]}`,
        'aria-label': `把 ${m.name} 换到${TEAM_NAMES[mode][to]}`,
        onclick: () => {
          // 对方队满员：不发送，只提示
          if (countIn(room, to) >= room.settings.teamSize) return void toast('对方队伍已满');
          send({ t: 'setBot', id: m.id, team: to });
        },
      },
      icon('swap', 14),
    ),
    h(
      'button',
      {
        class: 'btn icon sm ghost kick',
        'data-testid': `bot-remove-${m.id}`,
        title: '移除人机',
        'aria-label': `移除人机 ${m.name}`,
        onclick: () => send({ t: 'kick', id: m.id }),
      },
      icon('x', 14),
    ),
  );
}

/** 房主对真人队员的操作（等待中）：转让房主 / 移出房间。掉线的人不能转让，但可以移出 */
function openMemberOps(m: Member) {
  const current = app.room;
  const member = current?.members.find((item) => item.id === m.id);
  if (!current || !member || !app.isHost() || current.state !== 'waiting') return;
  const linkOff = !!linkNotice();
  const ops = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:10px' },
    h(
      'button',
      {
        class: 'btn',
        'data-testid': `transfer-host-${member.id}`,
        disabled: !!member.offline || linkOff,
        title: member.offline ? '对方掉线了，不能转让房主' : `把房主交给 ${member.name}`,
        onclick: () => send({ t: 'transferHost', id: member.id }),
      },
      icon('crown', 14),
      '设为房主',
    ),
    h(
      'button',
      {
        class: 'btn red',
        'data-testid': `kick-${member.id}`,
        disabled: linkOff,
        onclick: () => send({ t: 'kick', id: member.id }),
      },
      icon('x', 14),
      '移出房间',
    ),
  );
  const close = modal({
    title: member.name,
    sub: member.offline ? '队员管理 · 掉线中，座位保留' : '队员管理',
    testid: 'member-actions',
    body: ops,
    cancelText: '返回房间',
  });
  ops.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button:not(:disabled)')) close();
  });
}

function slotCard(m: Member, team: Team, room: RoomInfo) {
  const isMe = m.id === app.myId;
  const host = app.isHost();
  const waiting = room.state === 'waiting';
  const tags = h(
    'div',
    { class: 'tags' },
    m.id === room.hostId ? h('span', { class: 'chip gold' }, icon('crown', 12), '房主') : null,
    m.bot && !host ? h('span', { class: 'chip' }, icon('bot', 12), '人机 · ', DIFFICULTIES[m.difficulty ?? 'normal'].name) : null,
    !m.bot && m.offline ? h('span', { class: 'chip red' }, '掉线 · 保留座位') : null,
    !m.bot && !m.offline && m.id !== room.hostId
      ? m.ready
        ? h('span', { class: 'chip ok' }, icon('check', 12), '已准备')
        : h('span', { class: 'chip' }, '未准备')
      : null,
    isMe ? h('span', { class: ['chip', team === 0 ? 'red' : 'teal'] }, '你') : null,
  );
  return h(
    'div',
    { class: ['slot', isMe && 'me', m.bot && 'is-bot', m.offline && 'offline'], 'data-id': m.id, 'data-team': team },
    h('div', { class: 'portrait', style: { backgroundImage: bg(agentArt(m.agent)) } }),
    h('div', { class: 'who' }, h('b', null, m.name), tags),
    host && m.bot && waiting ? botOps(m, team, room) : null,
    host && m.bot && waiting
      ? h('button', {
          class: 'btn ghost slot-more',
          'data-testid': `member-actions-${m.id}`,
          'aria-label': `管理人机 ${m.name}，当前难度 ${DIFFICULTIES[m.difficulty ?? 'normal'].name}`,
          title: '管理人机：难度 / 换队 / 移除',
          onclick: () => {
            const current = app.room;
            const member = current?.members.find((item) => item.id === m.id);
            if (!current || !member || !app.isHost()) return;
            const ops = botOps(member, member.team as Team, current);
            const close = modal({ title: member.name, sub: '人机管理', testid: 'bot-actions', body: ops, cancelText: '返回房间' });
            ops.addEventListener('click', (e) => {
              if ((e.target as Element).closest('button:not(:disabled)')) close();
            });
          },
        }, DIFFICULTIES[m.difficulty ?? 'normal'].name)
      : null,
    host && !m.bot && !isMe && waiting
      ? h(
          'button',
          {
            class: 'btn ghost sm slot-manage',
            'data-testid': `member-actions-${m.id}`,
            'aria-label': `管理队员 ${m.name}`,
            title: '管理队员：设为房主 / 移出房间',
            onclick: () => openMemberOps(m),
          },
          '管理',
        )
      : null,
  );
}

/** 空位：真人（非该队成员）可以「加入」，房主还能补一个人机；对局中不显示这些入口 */
function emptySlot(team: Team, room: RoomInfo) {
  const me = app.me();
  const host = app.isHost();
  const waiting = room.state === 'waiting';
  const canJoin = waiting && !!me && me.team !== team;
  return h(
    'div',
    { class: ['slot', 'empty'], 'data-empty': team },
    h('span', { class: 'lbl' }, 'EMPTY'),
    canJoin
      ? h(
          'button',
          {
            class: 'btn sm',
            'data-testid': `join-slot-${team}`,
            'aria-label': `加入${TEAM_NAMES[room.settings.mode][team]}`,
            onclick: () => send({ t: 'setTeam', team }),
          },
          '加入',
        )
      : null,
    host && waiting
      ? h(
          'button',
          {
            class: 'btn sm red',
            'data-testid': `slot-bot-${team}`,
            'aria-label': `往${TEAM_NAMES[room.settings.mode][team]}添加人机`,
            onclick: () => send({ t: 'addBot', team, difficulty: room.settings.botDifficulty }),
          },
          '+ 人机',
        )
      : null,
  );
}

function openRoomSettings(room: RoomInfo) {
  let settings = room.settings;
  modal({
    title: '房间设置',
    testid: 'room-settings',
    wide: true,
    body: h('div', { style: 'display:flex;flex-direction:column;gap:18px' },
      settingsForm(settings, (value) => (settings = value), { compact: true }),
      toggle('开局时用人机补满空位', settings.fillBots, (value) => (settings = { ...settings, fillBots: value })),
    ),
    okText: '保存',
    onOk: () => send({ t: 'settings', settings }),
  });
}

export function roomScreen(): Screen {
  const tb = topbar('房间', undefined, () => openRoomMenu());
  const menuButton = tb.el.querySelector('button')!;
  menuButton.setAttribute('aria-label', '房间菜单');
  menuButton.setAttribute('data-testid', 'room-menu');
  menuButton.title = '房间菜单：设置、人机与观战';
  const bgImg = h('div', { class: 'img' });
  const title = h('div', { class: 'room-title' });
  const compactStatus = h('span', { class: 'room-compact-status', role: 'status' });
  const hintBar = h('div', { class: 'hint-bar', 'data-testid': 'hint-bar' });
  const bulk = h('div', { class: 'room-bulk' });
  const teams = h('div', { class: 'teams' });
  const specBox = h('div', { class: 'panel spec-block', 'data-testid': 'spectator-zone' });
  const side = h('div', { class: 'side' });
  const settingsBox = h('div', { class: 'panel room-settings', 'data-testid': 'room-details' });
  const foot = h('div', { class: 'room-foot' });
  const agentBar = agentPicker(
    profile.agent,
    (id) => {
      saveProfile({ agent: id });
      send({ t: 'profile', agent: id });
    },
    'agent-bar',
    'agent-',
  );

  set(side, settingsBox);

  const el = h(
    'div',
    { class: 'room' },
    h('div', { class: 'backdrop' }, bgImg),
    h('div', { class: 'room-chrome' },
      tb.el,
      h('div', { class: 'room-head' },
        h('button', { class: 'btn ghost', 'data-testid': 'leave-room', 'aria-label': '离开房间', onclick: () => send({ t: 'leaveRoom' }) }, icon('back', 16), h('span', null, '离开')),
        title,
      ),
      foot,
    ),
    h('div', { class: 'room-bar' }, hintBar, h('div', { class: 'spacer' }), bulk),
    h('div', { class: 'room-body' },
      h('div', { class: 'room-main' }, teams, h('p', { class: 'room-scroll-hint' }, '向上滑动查看观战席与地图 ↓'), specBox),
      side,
    ),
  );

  let lastRoom = '';
  let lastLink = '';

  function openRoomMenu() {
    const current = app.room;
    if (!current) return;
    const host = app.isHost();
    const me = app.me();
    const waiting = current.state === 'waiting';
    const seat = hasMatchSeat(current.members, current.settings.teamSize);
    const jump = (target: HTMLElement) => {
      close();
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
    };
    const actions = h('div', { class: 'room-menu-actions' });
    const close = modal({
      title: '房间菜单',
      testid: 'room-menu-panel',
      sub: `${MODES[current.settings.mode].name} · ${MAP_BY_ID[current.settings.map].name} · ${current.settings.teamSize}v${current.settings.teamSize}`,
      body: actions,
      cancelText: '返回房间',
    });
    const action = (label: string, run: () => void, disabled = false) => h('button', { class: 'btn', disabled, onclick: () => { close(); run(); } }, label);
    set(actions,
      h('p', { class: 'room-menu-status' }, barState(current).text),
      !waiting && me?.team === -1 ? action('加入对局', () => send({ t: 'joinMatch' }), !seat || !!linkNotice()) : null,
      host ? action('修改模式 / 地图 / 规则', () => openRoomSettings(app.room ?? current), !waiting) : null,
      host ? action('一键补满双方人机', () => send({ t: 'fillBots' }), !waiting || ([0, 1] as Team[]).every((team) => countIn(current, team) >= current.settings.teamSize)) : null,
      host ? ([0, 1] as Team[]).map((team) => h('div', { class: 'room-menu-team' },
        h('b', null, TEAM_NAMES[current.settings.mode][team]),
        action('添加人机', () => send({ t: 'addBot', team, difficulty: current.settings.botDifficulty }), !waiting || countIn(current, team) >= current.settings.teamSize),
        action('补满本队', () => send({ t: 'fillBots', team }), !waiting || countIn(current, team) >= current.settings.teamSize),
      )) : null,
      action('观战席', () => jump(specBox)),
      action('地图与规则', () => jump(settingsBox)),
      action('修改代号 / 特工', () => tb.el.querySelector<HTMLElement>('.me-chip')?.click()),
      action('个人设置', () => openSettings()),
    );
  }

  const teamCol = (room: RoomInfo, team: Team) => {
    const names = TEAM_NAMES[room.settings.mode];
    const ms = room.members.filter((m) => m.team === team);
    const full = ms.length >= room.settings.teamSize;
    const slots: Node[] = ms.map((m) => slotCard(m, team, room));
    for (let i = ms.length; i < room.settings.teamSize; i++) slots.push(emptySlot(team, room));
    const host = app.isHost();
    const waiting = room.state === 'waiting';
    return h(
      'div',
      { class: `team-col t${team}` },
      h(
        'div',
        { class: 'team-head' },
        h('b', null, names[team]),
        h('i', null, `${ms.length}/${room.settings.teamSize}`),
        host && waiting
          ? h(
              'div',
              { class: 'team-ops' },
              h(
                'button',
                {
                  class: 'btn sm ghost',
                  'data-testid': `add-bot-${team}`,
                  disabled: full,
                  title: full ? '该队已满' : `往${names[team]}添加一个人机`,
                  onclick: () => send({ t: 'addBot', team, difficulty: room.settings.botDifficulty }),
                },
                icon('plus', 14),
                '添加人机',
              ),
              h(
                'button',
                {
                  class: 'btn sm ghost',
                  'data-testid': `fill-team-${team}`,
                  disabled: full,
                  title: full ? '该队已满' : `用人机补满${names[team]}`,
                  onclick: () => send({ t: 'fillBots', team }),
                },
                '补满本队',
              ),
            )
          : null,
      ),
      h('div', { class: 'scroll team-slots' }, slots),
    );
  };

  const renderSettings = (room: RoomInfo) => {
    const host = app.isHost();
    const waiting = room.state === 'waiting';
    const map = MAP_BY_ID[room.settings.map];
    set(
      settingsBox,
      h('div', { class: 'map-preview', style: { backgroundImage: bg(mapCover(map.id)) } }, h('span', null, map.name, h('i', null, map.en))),
      host
        ? h(
            'button',
            {
              class: 'btn',
              'data-testid': 'edit-room-settings',
              disabled: !waiting,
              title: waiting ? '' : '对局进行中，结束后可以修改',
              onclick: () => openRoomSettings(room),
            },
            '修改模式 / 地图 / 规则',
          )
        : null,
      h(
        'div',
        { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;font-size:13px' },
        h('span', { class: 'label' }, '模式'),
        h('b', null, MODES[room.settings.mode].name),
        h('span', { class: 'label' }, '规模'),
        h('b', null, `${room.settings.teamSize}v${room.settings.teamSize}`),
        h('span', { class: 'label' }, room.settings.mode === 'tdm' ? '击杀目标' : room.settings.mode === 'infection' ? '胜利条件' : '获胜回合'),
        room.settings.mode === 'infection'
          ? h('b', null, '感染 / 存活倒计时')
          : h('b', null, String(room.settings.scoreLimit)),
        h('span', { class: 'label' }, '人机'),
        h('b', null, DIFFICULTIES[room.settings.botDifficulty].name, room.settings.fillBots ? ' · 自动补满' : ''),
      ),
    );
  };

  /** §2.2 状态表：hint-bar / start-reason / 按钮是否可点，按顺序判断、命中即停 */
  const barState = (room: RoomInfo): BarState => {
    const me = app.me();
    const host = app.isHost();
    const F = room.settings.fillBots;
    const E = ([0, 1] as Team[]).filter((t) => countIn(room, t) === 0).length;
    const U = room.members.filter((m) => !m.bot && m.team !== -1 && m.id !== room.hostId && !m.ready).length;
    // N：F 开启时开局会把两队补齐，这是补满会新增的人机数
    const N = F ? ([0, 1] as Team[]).reduce<number>((n, t) => n + Math.max(0, room.settings.teamSize - countIn(room, t)), 0) : 0;
    const offline = room.members.filter((m) => !m.bot && m.offline && m.team !== -1);
    const linkDown = linkNotice();

    // 连接断了：开始 / 准备都发不出去，先说这个
    if (linkDown) return { tone: 'red', text: linkDown, btnDisabled: true, reason: '网络断开', fix: null, U: 0, act: null };

    // 最高优先级：对局中服务器禁止一切队伍 / 准备变更（点空位「加入」也会被拒），所以不能显示「点击空位加入」
    // 观战的人对局里还有位子时，给一个「加入对局」
    if (room.state !== 'waiting') {
      if (me?.team === -1 && hasMatchSeat(room.members, room.settings.teamSize)) {
        return { tone: 'ok', text: '对局进行中，还有空位，可以直接加入', btnDisabled: true, reason: '', fix: null, U: 0, act: { label: '加入对局', run: () => send({ t: 'joinMatch' }) } };
      }
      return {
        tone: 'neutral',
        text: me?.team === -1 ? '对局进行中，暂时没有空位，可以先在观战席看' : '对局进行中，等待结束后可加入队伍',
        btnDisabled: true,
        reason: '',
        fix: null,
        U: 0,
        act: null,
      };
    }

    if (!host) {
      if (me?.team === -1) return { tone: 'neutral', text: '点击空位加入一支队伍，或留在观战席', btnDisabled: true, reason: '', fix: null, U: 0, act: null };
      if (!me?.ready) return { tone: 'neutral', text: '选好特工后点「准备」，等房主开始', btnDisabled: false, reason: '', fix: null, U: 0, act: null };
      return { tone: 'ok', text: '已准备，等房主开始', btnDisabled: false, reason: '', fix: null, U: 0, act: null };
    }

    // 房主在观战席、队伍里又没有任何真人：服务器会拒绝开局，这里先写明原因（不让人点了才报错）
    if (!room.members.some((m) => !m.bot && m.team !== -1)) {
      return { tone: 'red', text: '至少要有一名玩家在队伍里，房主请先回到队伍', btnDisabled: true, reason: '没有玩家在队伍里', fix: null, U: 0, act: null };
    }
    // 队伍里有人掉线：服务器也会拒绝开局（等他回来，或先把他移出）
    if (offline.length) {
      const names = offline.map((m) => m.name).join('、');
      return { tone: 'red', text: `${names} 掉线了，等待回来或先移出后再开始`, btnDisabled: true, reason: `${names} 掉线`, fix: null, U: 0, act: null };
    }

    let tone: Tone;
    let text: string;
    let btnDisabled = false;
    if (E > 0 && !F) {
      tone = 'red';
      text = '两队都至少需要 1 人。点「一键补满双方人机」';
      btnDisabled = true;
    } else if (F && N > 0) {
      tone = 'neutral';
      text = `开局时将自动补 ${N} 个人机`;
    } else if (U > 0) {
      tone = 'neutral';
      text = `${U} 名队员未准备，可以直接开始`;
    } else {
      tone = 'ok';
      text = '一切就绪，点「开始游戏」';
    }
    // start-reason：空队挡开局时就是那条；否则「未准备」优先于「自动补人机」
    let reason: string;
    let fix: (() => void) | null = null;
    if (E > 0 && !F) {
      reason = '两队都至少需要 1 人';
      fix = () => send({ t: 'fillBots' });
    } else if (U > 0) reason = `${U} 名玩家未准备`;
    else if (F && N > 0) reason = `开局时将自动补 ${N} 个人机`;
    else reason = '可以开始';
    return { tone, text, btnDisabled, reason, fix, U, act: null };
  };

  const doStart = (unready: number) => {
    if (!unready) return void send({ t: 'start' });
    modal({
      testid: 'confirm-start',
      title: '未准备的玩家',
      body: h('p', { style: 'margin:0' }, `${unready} 名玩家未准备，仍然开始？`),
      okText: '仍然开始',
      cancelText: '再等等',
      onOk: () => send({ t: 'start' }),
    });
  };

  const renderBar = (room: RoomInfo) => {
    const st = barState(room);
    hintBar.className = 'hint-bar ' + st.tone;
    compactStatus.className = 'room-compact-status ' + st.tone;
    compactStatus.textContent = st.reason || st.text;
    set(
      hintBar,
      st.fix
        ? h('button', { class: 'btn ghost hint-fix', 'data-testid': 'hint-fix', onclick: st.fix }, icon('bot', 14), st.text, ' · 点击补满')
        : [icon('users', 14), h('span', null, st.text)],
      st.act ? h('button', { class: 'btn sm red hint-act', 'data-testid': 'hint-act', onclick: st.act.run }, st.act.label) : null,
    );

    const bothFull = ([0, 1] as Team[]).every((t) => countIn(room, t) >= room.settings.teamSize);
    set(
      bulk,
      app.isHost() && room.state === 'waiting'
        ? h(
            'button',
            {
              class: 'btn red',
              'data-testid': 'fill-all',
              disabled: bothFull,
              title: '用当前难度的人机补满两队空位',
              onclick: () => send({ t: 'fillBots' }),
            },
            icon('bot', 16),
            '一键补满双方人机',
          )
        : null,
    );
  };

  const renderSpec = (room: RoomInfo) => {
    const me = app.me();
    const spectating = me?.team === -1;
    const waiting = room.state === 'waiting';
    const spect = room.members.filter((m) => m.team === -1);
    const seat = hasMatchSeat(room.members, room.settings.teamSize);
    const linkOff = !!linkNotice();
    set(
      specBox,
      h('div', { class: 'spec-head' }, icon('eye', 16), h('b', null, '观战席'), h('i', null, `${spect.length} 人`)),
      h(
        'div',
        { class: 'spec-who' },
        spect.length ? spect.map((m) => h('span', { class: ['chip', m.bot && 'bot'] }, m.name)) : h('span', { class: 'muted' }, '还没有人观战'),
      ),
      h(
        'button',
        {
          class: 'btn sm ghost',
          'data-act': 'spectate',
          'data-testid': 'spectate-toggle',
          disabled: !waiting,
          title: waiting ? '' : '对局进行中不能换',
          onclick: () => send({ t: 'setTeam', team: spectating ? 0 : -1 }),
        },
        spectating ? '回到队伍' : '去观战席',
      ),
      !waiting && spectating
        ? h(
            'button',
            {
              class: 'btn sm red',
              'data-act': 'join-match',
              'data-testid': 'join-match',
              disabled: !seat || linkOff,
              title: seat ? '直接坐进对局（有人机就顶掉一个）' : '对局里暂时没有空位',
              onclick: () => send({ t: 'joinMatch' }),
            },
            '加入对局',
          )
        : null,
    );
  };

  const renderFoot = (room: RoomInfo) => {
    const me = app.me();
    const st = barState(room);
    const nodes: Node[] = [
      h('div', { class: 'field' }, h('label', null, '我的特工'), agentBar),
      h('button', {
        class: 'btn ghost room-agent-trigger',
        'data-testid': 'room-agent-picker',
        'aria-label': `切换特工，当前 ${AGENT_BY_ID[profile.agent].name}`,
        onclick: () => {
          const close = modal({
            title: '选择特工',
            testid: 'room-agents',
            sub: '点击特工立即切换',
            body: agentPicker(profile.agent, (id) => {
              saveProfile({ agent: id });
              send({ t: 'profile', agent: id });
              close();
            }),
            cancelText: '返回房间',
          });
        },
      }, h('span', { class: 'room-agent-avatar', style: { backgroundImage: bg(agentArt(profile.agent)) } }), AGENT_BY_ID[profile.agent].name),
      h('div', { class: 'spacer' }),
    ];
    if (app.isHost()) {
      nodes.push(
        st.fix
          ? h('button', { class: 'gate-fix', 'data-testid': 'start-reason', title: '点这里补齐两队', 'aria-label': `${st.reason}，点击补齐队伍`, onclick: st.fix }, icon('bot', 14), h('span', { class: 'gate-full' }, st.reason), h('span', { class: 'gate-short' }, '补齐队伍'))
          : h('span', { class: ['gate-ok', st.tone === 'red' && 'gate-block'], 'data-testid': 'start-reason' }, st.reason),
        h('button', { class: 'btn primary', 'data-testid': 'start-btn', disabled: st.btnDisabled, onclick: () => doStart(st.U) }, icon('play', 18), '开始游戏'),
      );
    } else {
      nodes.push(
        h(
          'button',
          {
            class: ['btn primary', me?.ready && 'white'],
            'data-testid': 'ready-btn',
            disabled: st.btnDisabled,
            onclick: () => send({ t: 'setReady', ready: !me?.ready }),
          },
          me?.ready ? '取消准备' : '准备',
        ),
      );
    }
    set(foot, nodes);
  };

  const render = (room: RoomInfo) => {
    const map = MAP_BY_ID[room.settings.map];
    bgImg.style.backgroundImage = bg(mapCover(map.id));
    set(
      title,
      h(
        'div',
        { class: 'kicker' },
        h('span', { class: 'room-meta' }, MODES[room.settings.mode].name, ' · ', map.name),
        h(
          'span',
          {
            class: 'code-pill',
            'data-testid': 'copy-code',
            role: 'button',
            tabindex: 0,
            title: '复制房间号',
            onclick: () => {
              void navigator.clipboard?.writeText(room.id).then(() => toast('房间号已复制', 'ok'), () => {});
            },
          },
          room.id,
          icon('copy', 12),
        ),
        room.priv ? h('span', { class: 'chip' }, icon('lock', 11), '私密') : null,
        room.state !== 'waiting' ? h('span', { class: 'chip gold live' }, '对局中') : null,
      ),
      h('div', { class: 'room-title-text' }, h('h1', null, room.name), compactStatus),
    );
    set(teams, teamCol(room, 0), h('div', { class: 'vs' }, 'VS'), teamCol(room, 1));
    renderSettings(room);
    renderBar(room);
    renderSpec(room);
    renderFoot(room);
  };

  return {
    el,
    dispose() { tb.dispose(); },
    update() {
      tb.refresh();
      const room = app.room;
      if (!room) return;
      // 只在房间真的变了才重建（否则每次广播都会重播一遍进场动画）
      const sig = JSON.stringify(room);
      if (room && sig !== lastRoom) {
        lastRoom = sig;
        render(room);
      }
      // 连接状态变了（断线 / 重连）：提示条、开始 / 准备 / 加入对局按钮跟着变
      const link = linkNotice() ?? '';
      if (link !== lastLink) {
        lastLink = link;
        renderBar(room);
        renderSpec(room);
        renderFoot(room);
      }
    },
  };
}
