import { app } from '../app.ts';
import { friends } from '../friends.ts';
import { h, set } from './dom.ts';
import { modal, toast } from './overlay.ts';

export function openFriends() {
  const content = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  const code = h('input', { class: 'input', placeholder: '输入 16 位好友码', maxLength: 16, autocomplete: 'off' });
  const status = h('div');
  const own = h('div');
  const requests = h('div');
  const invites = h('div');
  const list = h('div');
  content.append(status, own, h('div', { style: 'display:flex;gap:8px' }, code,
    h('button', { class: 'btn', onclick: () => friends.request(code.value) }, '发送申请')),
    requests, invites, h('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
      h('b', null, '好友列表'), h('button', { class: 'btn ghost', onclick: () => friends.refresh() }, '刷新在线状态')), list,
    h('small', { class: 'field-hint' }, '双方须同时在线申请和同意；在线状态需手动刷新。好友码不提供身份认证，请勿向陌生人泄露。删除仅移除自己的记录。'));
  const row = (name: string, detail: string, ...buttons: (Node | null)[]) => h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0' },
    h('span', { style: 'flex:1;min-width:150px' }, h('b', null, name), h('small', { style: 'display:block;opacity:.7' }, detail)), ...buttons);
  const render = () => {
    set(status, friends.error ? `错误：${friends.error}` : friends.data ? `${friends.source} · ${friends.registered && app.conn?.status === 'open' ? '好友服务在线' : '好友服务未连接'}` : '正在读取好友存档…');
    set(own, friends.data ? row('我的好友码', friends.data.code, h('button', { class: 'btn ghost', onclick: async () => {
      try { await navigator.clipboard.writeText(friends.data!.code); toast('好友码已复制', 'ok'); }
      catch { toast('复制失败，请手动选择好友码'); }
    } }, '复制')) : null);
    set(requests, friends.requests.length ? h('b', null, '收到的申请') : null,
      friends.requests.map(r => row(r.name, r.code, h('button', { class: 'btn', onclick: () => friends.accept(r.code) }, '同意'))));
    if (friends.unsaved.length) requests.append(h('b', null, '待保存的好友'), ...friends.unsaved.map(f =>
      row(f.name, `${f.code} · 尚未保存`, h('button', { class: 'btn', onclick: () => void friends.saveAccepted(f.code).catch(e => toast(e instanceof Error ? e.message : '保存好友失败')) }, '重试保存'),
        h('button', { class: 'btn ghost', onclick: () => friends.dismissUnsaved(f.code) }, '放弃保存'))));
    set(invites, friends.invites.length ? h('b', null, '房间邀请') : null,
      friends.invites.map(i => row(i.name, `房间 ${i.roomId}`, h('button', { class: 'btn', onclick: () => {
        if (app.conn?.status !== 'open') { toast('服务器未连接'); return; }
        app.conn.send({ t: 'joinRoom', id: i.roomId }); friends.dismissInvite(i.code);
      } }, '加入'), h('button', { class: 'btn ghost', onclick: () => friends.dismissInvite(i.code) }, '忽略'))));
    set(list, !friends.data?.friends.length ? h('small', null, '暂无好友') : friends.data.friends.map(f => row(f.name, `${f.code} · ${friends.online.has(f.code) ? '在线' : '未确认在线'}`,
      app.room ? h('button', { class: 'btn ghost', onclick: () => friends.invite(f.code) }, '邀请入房') : null,
      h('button', { class: 'btn ghost', onclick: () => void friends.remove(f.code) }, '删除'))));
  };
  const unsubscribe = friends.subscribe(render);
  const close = modal({ title: '好友', body: content, cancelText: '关闭', wide: true, onClose: unsubscribe });
  render();
  void friends.load();
  return close;
}
