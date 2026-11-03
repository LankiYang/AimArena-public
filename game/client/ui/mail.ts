// 官方公告邮箱：已读状态仅保存在当前设备及当前服务器下。
import '../styles/mail.css';
import { h, icon, set } from './dom.ts';
import { modal } from './overlay.ts';

type Message = { id: string; title: string; body: string; publishedAt: string };

export function createMailEntry() {
  const storageKey = 'vpvp.mail.read.v1';
  const url = '/api/mail';
  let storageAvailable = true;
  let read = new Set<string>();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (Array.isArray(stored)) read = new Set(stored.filter((id): id is string => typeof id === 'string'));
  } catch { storageAvailable = false; }
  let messages: Message[] | null = null;
  let error = false;
  let loading = false;
  let disposed = false;
  let controller: AbortController | null = null;
  let closeModal: (() => void) | null = null;
  let renderModal: (() => void) | null = null;
  const badge = h('span', { class: 'mail-badge', 'aria-hidden': 'true', hidden: true });
  const button = h('button', { class: 'btn ghost mail-entry', type: 'button', 'data-testid': 'mail-open', onclick: open }, '邮箱', badge);

  function update() {
    const unread = messages?.filter(message => !read.has(message.id)).length ?? 0;
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
    button.setAttribute('aria-label', unread ? `邮箱，${unread} 封未读公告` : '邮箱');
    renderModal?.();
  }
  async function load() {
    if (disposed || loading) return;
    loading = true;
    error = false;
    controller = new AbortController();
    update();
    const timeout = setTimeout(() => controller?.abort(), 15_000);
    try {
      const response = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('mail request failed');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('messages' in data) || !Array.isArray(data.messages) ||
          !data.messages.every((m: unknown) => m && typeof m === 'object' &&
            'id' in m && typeof m.id === 'string' && 'title' in m && typeof m.title === 'string' &&
            'body' in m && typeof m.body === 'string' && 'publishedAt' in m && typeof m.publishedAt === 'string')) {
        throw new Error('invalid mail response');
      }
      if (!disposed) {
        messages = data.messages as Message[];
        const activeIds = new Set(messages.map(message => message.id));
        const retained = new Set([...read].filter(id => activeIds.has(id)));
        if (retained.size !== read.size) {
          read = retained;
          try { localStorage.setItem(storageKey, JSON.stringify([...read])); } catch { storageAvailable = false; }
        }
      }
    } catch {
      if (!disposed) error = true;
    } finally {
      clearTimeout(timeout);
      loading = false;
      controller = null;
      if (!disposed) update();
    }
  }
  function open() {
    if (closeModal || disposed) return;
    let selected: string | null = null;
    const hint = h('p', { class: 'mail-hint' });
    const status = h('div', { class: 'mail-status', role: 'status', 'aria-live': 'polite' });
    const content = h('div', { class: 'mail-content' });
    const refresh = h('button', { class: 'btn ghost', type: 'button', 'data-testid': 'mail-refresh', onclick: () => { void load(); } }, icon('refresh', 16), '刷新');
    const body = h('div', { class: 'mail-board' },
      hint,
      h('div', { class: 'mail-tools' }, refresh), status, content);
    renderModal = () => {
      hint.textContent = storageAvailable
        ? '官方全员公告 · 已读状态仅保存在本机，不跨设备同步'
        : '官方全员公告 · 本机存储不可用，已读状态仅在本次会话有效，不跨设备同步';
      refresh.disabled = loading;
      status.textContent = loading ? '正在加载邮件…' : error ? '邮件加载失败，请点击刷新重试。' : '';
      const message = messages?.find(item => item.id === selected);
      if (message) {
        const back = h('button', { class: 'btn ghost', type: 'button', onclick: () => { selected = null; renderModal?.(); content.querySelector<HTMLButtonElement>('button')?.focus(); } }, '返回邮件列表');
        set(content, back, h('article', { class: 'mail-detail' },
          h('h3', null, message.title), h('time', { datetime: message.publishedAt }, formatTime(message.publishedAt)),
          h('div', { class: 'mail-body' }, message.body)));
      } else if (messages) {
        selected = null;
        if (!messages.length) set(content, h('p', { class: 'mail-empty' }, '暂无公告邮件'));
        else set(content, h('div', { class: 'mail-list', 'aria-label': '公告邮件列表' }, messages.map(item =>
          h('button', { class: ['mail-row', !read.has(item.id) && 'unread'], type: 'button', onclick: () => {
            selected = item.id;
            read.add(item.id);
            try { localStorage.setItem(storageKey, JSON.stringify([...read])); } catch { storageAvailable = false; }
            update();
            content.querySelector<HTMLButtonElement>('button')?.focus();
          } }, h('span', { class: 'mail-row-title' }, item.title, !read.has(item.id) ? h('span', { class: 'mail-unread' }, '未读') : null),
          h('time', { datetime: item.publishedAt }, formatTime(item.publishedAt))))));
      } else set(content);
    };
    closeModal = modal({ title: '官方邮箱', sub: '全员公告', body, testid: 'mail-modal', cancelText: '关闭', onClose: () => {
      closeModal = null;
      renderModal = null;
      if (!disposed && button.isConnected) button.focus();
    } });
    const dialog = body.closest<HTMLElement>('.modal');
    dialog?.setAttribute('role', 'dialog');
    dialog?.setAttribute('aria-modal', 'true');
    dialog?.setAttribute('aria-label', '官方邮箱');
    update();
    if (!messages && !loading && !error) void load();
  }
  void load();
  return { el: button, dispose() { disposed = true; controller?.abort(); closeModal?.(); } };
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
