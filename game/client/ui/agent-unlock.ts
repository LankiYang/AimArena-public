// agent-unlock（UI）— 锁定特工的解锁弹窗：关注作者 + 作品三连。
// 弹窗打开时订阅解锁状态：从 B站页面切回来（watchAgentUnlock 复查）会自动打勾。
import type { AgentId } from '../../shared/catalog.ts';
import { AGENT_BY_ID } from '../../shared/catalog.ts';
import {
  agentUnlockState,
  onAgentUnlockChange,
  openBiliPage,
  refreshAgentUnlock,
  UNLOCK_AUTHOR,
  UNLOCK_VIDEOS,
} from '../toy-unlock.ts';
import { h, icon, set } from './dom.ts';
import { modal, toast } from './overlay.ts';

export function openAgentUnlock(agentId: AgentId, onUnlocked: (id: AgentId) => void): void {
  const agent = AGENT_BY_ID[agentId];
  const body = h('div', { class: 'unlock-body' });
  let off: () => void = () => {};

  const render = () => {
    const s = agentUnlockState();
    const tripleDone = s.liked && s.coined && s.favorited;
    set(
      body,
      h(
        'div',
        { class: 'unlock-lead' },
        h('b', null, `解锁「${agent.name}」及全部特工`),
        h('span', null, `关注 B站作者「${UNLOCK_AUTHOR.name}」，并给作品三连（点赞、投币、收藏）后即可使用全部特工。`),
      ),
      h(
        'div',
        { class: 'unlock-task' },
        h(
          'div',
          { class: 'unlock-task-main' },
          h('b', null, '第一步 · 关注作者'),
          h('span', null, `B站：${UNLOCK_AUTHOR.name}`),
        ),
        h('span', { class: ['unlock-state', s.following && 'ok'] }, s.following ? '已关注' : s.checked ? '待关注' : '检查中…'),
        h(
          'button',
          { class: 'btn ghost sm', type: 'button', 'data-testid': 'unlock-follow', onclick: () => openBiliPage('space') },
          '去关注',
        ),
      ),
      h(
        'div',
        { class: 'unlock-task' },
        h(
          'div',
          { class: 'unlock-task-main' },
          h('b', null, '第二步 · 作品三连'),
          h('span', null, UNLOCK_VIDEOS[0].title),
          h(
            'div',
            { class: 'unlock-chips' },
            h('span', { class: ['unlock-chip', s.liked && 'ok'] }, s.liked ? '✓ 点赞' : '点赞'),
            h('span', { class: ['unlock-chip', s.coined && 'ok'] }, s.coined ? '✓ 投币' : '投币'),
            h('span', { class: ['unlock-chip', s.favorited && 'ok'] }, s.favorited ? '✓ 收藏' : '收藏'),
          ),
        ),
        h('span', { class: ['unlock-state', tripleDone && 'ok'] }, tripleDone ? '已完成' : s.checked ? '待三连' : '检查中…'),
        h(
          'button',
          { class: 'btn ghost sm', type: 'button', 'data-testid': 'unlock-triple', onclick: () => openBiliPage('video') },
          '去三连',
        ),
      ),
      s.error ? h('div', { class: 'unlock-note err', 'data-testid': 'unlock-error' }, s.error) : null,
      h(
        'div',
        { class: 'unlock-hint' },
        '完成后回到这里会自动检查；也可以点右下角「检查解锁」。解锁状态在本机保留 12 小时。',
      ),
      s.unlocked
        ? h('div', { class: 'unlock-note ok' }, icon('check', 14), ' 已解锁全部特工，点「检查解锁」完成切换。')
        : null,
    );
  };

  off = onAgentUnlockChange(render);
  modal({
    title: `解锁特工 · ${agent.name}`,
    sub: '关注作者 + 作品三连，解锁全部特工',
    body,
    okText: '检查解锁',
    cancelText: '返回',
    testid: 'agent-unlock',
    okTestid: 'unlock-check',
    onOk: async () => {
      const s = await refreshAgentUnlock({ force: true });
      if (s.unlocked) {
        toast('已解锁全部特工', 'ok');
        onUnlocked(agentId);
        return true;
      }
      toast(s.error ?? '还没完成关注和三连');
      return false;
    },
    onClose: () => off(),
  });
  render();
}