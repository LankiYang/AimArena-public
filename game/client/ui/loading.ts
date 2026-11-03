// loading.ts — 进入对局前的加载画面：地图大图 + 两队阵容 + 进度条
import { AGENT_BY_ID, MAP_BY_ID, MODES } from '../../shared/catalog.ts';
import type { Member, RoomSettings } from '../../shared/lobby.ts';
import { agentArt, bg, mapCover } from './art.ts';
import { h } from './dom.ts';

export function loadingView(settings: RoomSettings, members: Member[]) {
  const map = MAP_BY_ID[settings.map];
  const bar = h('i');
  const status = h('span', null, '准备中…');
  const pct = h('span', null, '0%');
  // 服务器侧的排队提示：单独一行，不抢本地下载进度条（那是客户端自己的进度）
  const queue = h('div', { class: 'load-queue', hidden: true, role: 'status', 'aria-live': 'polite' });
  const queueText = h('span');
  const queueDots = h('i');
  queue.append(queueDots, queueText);
  const team = (t: 0 | 1) =>
    h(
      'div',
      { class: `load-team t${t}` },
      members
        .filter((m) => m.team === t)
        .map((m, i) =>
          h('div', {
            class: 'load-card',
            'data-name': m.name,
            title: AGENT_BY_ID[m.agent].name,
            style: { backgroundImage: bg(agentArt(m.agent)), animationDelay: `${i * 60}ms` },
          }),
        ),
    );
  const el = h(
    'div',
    { class: 'loading screen' },
    h('div', { class: 'backdrop' }, h('div', { class: 'img', style: { backgroundImage: bg(mapCover(map.id)) } })),
    h(
      'div',
      { class: 'load-main' },
      h('div', { class: 'load-map' }, h('h1', null, map.en), h('div', { class: 'info' }, h('b', null, map.name), h('span', null, MODES[settings.mode].en))),
      h('div', { class: 'load-teams' }, team(0), team(1)),
      h('div', { class: 'load-status' }, status, pct),
      h('div', { class: 'load-bar' }, bar),
      queue,
    ),
  );
  return {
    el,
    /** 服务器排队：position 从 1 开始；null 关闭提示 */
    setQueue(q: { position: number; total: number } | null) {
      if (!q || q.position <= 0) { queue.hidden = true; return; }
      queue.hidden = false;
      queueText.textContent = q.position === 1
        ? '正在等待地图加载 · 下一个就轮到你'
        : `正在等待地图加载 · 第 ${q.position} / ${q.total} 位`;
    },
    progress(p: number, text?: string) {
      const v = Math.max(0, Math.min(1, p));
      bar.style.width = (v * 100).toFixed(1) + '%';
      pct.textContent = Math.round(v * 100) + '%';
      if (text) status.textContent = text;
    },
  };
}
