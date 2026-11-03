// leaderboard.ts — 累计击杀总榜：真实榜单/本人排名，头尾固定，中间单一纵向滚动。
import '../styles/leaderboard.css';
import { killLeaderboard, type KillBoardView } from '../toy-leaderboard.ts';
import { h, icon, set } from './dom.ts';
import { modal } from './overlay.ts';

export function openKillLeaderboard(onClose?: () => void): () => void {
  let closed = false;
  let busy = false;
  let view: KillBoardView | null = null;
  const me = h('div', { class: 'kill-mine', 'data-testid': 'kill-my-rank' }, '正在读取本人排名…');
  const progress = h('div', { class: 'kill-progress', role: 'status', 'aria-live': 'polite', 'data-testid': 'kill-sync-status' });
  const error = h('div', { class: 'kill-error', role: 'status', hidden: true, 'data-testid': 'kill-board-error' });
  const rows = h('div', { class: 'kill-rows', role: 'list', 'data-testid': 'kill-rank-list' });
  const refresh = h('button', {
    class: 'btn ghost', type: 'button', 'data-testid': 'kill-refresh', onclick: () => { void load(true); },
  }, icon('refresh', 16), '刷新并同步');
  const body = h('div', { class: 'kill-board' },
    h('p', { class: 'kill-rule' }, '累计敌方击杀 · 包含人机 · 同分先达成者优先'),
    h('div', { class: 'kill-board-tools' }, me, refresh),
    progress, error,
    h('div', { class: 'kill-row kill-row-head', 'aria-hidden': 'true' }, h('span', null, '排名'), h('span', null, '玩家'), h('span', null, '击杀')),
    rows,
    h('p', { class: 'kill-rule' }, '仅统计服务器确认的击杀；队友、自杀与观战不计。退出对局或页面隐藏时自动同步。未同步成功前，请保留页面并重试。'),
  );
  const renderState = () => {
    if (closed) return;
    const s = killLeaderboard.state;
    progress.textContent = `本局 ${s.sessionKills} 击杀 / ${s.sessionDeaths} 死亡 · ${s.message}`;
    progress.dataset.status = s.status;
    refresh.disabled = busy || s.status === 'syncing';
    if (view) {
      me.textContent = view.mine?.ranked
        ? `我的排名 #${view.mine.rank} · ${view.mine.score.toLocaleString()} 击杀`
        : view.mine ? '尚未上榜 · 完成击杀后同步即可上榜' : '登录 B 站后显示本人排名';
    }
  };
  async function load(force: boolean) {
    if (busy || closed) return;
    busy = true;
    refresh.disabled = true;
    if (!view) rows.textContent = '正在读取击杀榜…';
    try {
      const result = await killLeaderboard.load(force);
      if (closed) return;
      view = result;
      error.textContent = result.error;
      error.hidden = !result.error;
      if (!result.list.length) set(rows, h('div', { class: 'kill-empty' }, result.error ? '榜单暂不可用，稍后可手动刷新' : '还没有战绩，来拿下第一名吧'));
      else set(rows, result.list.map(r => {
        let avatar = '';
        try { const url = new URL(r.avatar); if (url.protocol === 'https:') avatar = url.href; } catch {}
        return h('div', { class: ['kill-row', r.rank <= 3 && 'kill-top'], role: 'listitem', 'data-rank': r.rank },
          h('b', { class: 'kill-place' }, String(r.rank).padStart(2, '0')),
          h('div', { class: 'kill-player' }, avatar ? h('img', { src: avatar, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }) : h('span', { class: 'kill-avatar' }, icon('users', 18)),
            h('b', { title: r.nickname }, r.nickname)),
          h('strong', { class: 'kill-score' }, r.score.toLocaleString()));
      }));
    } catch {
      if (!closed) { error.hidden = false; error.textContent = '榜单暂时不可用，游戏不受影响，请稍后重试'; }
    } finally {
      busy = false;
      renderState();
    }
  }
  const unsubscribe = killLeaderboard.subscribe(renderState);
  const close = modal({
    title: '击杀排行榜', sub: 'B 站累计击杀总榜', testid: 'kill-leaderboard', body,
    cancelText: '返回游戏', onClose: () => { closed = true; unsubscribe(); onClose?.(); },
  });
  renderState();
  void load(false);
  return close;
}
