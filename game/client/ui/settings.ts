// settings.ts — 设置弹窗（操作模式 / 灵敏度 / 开镜倍率 / 视野 / 音量 / 准星颜色 / 网络线路），大厅和对局 ESC 菜单共用
import { app } from '../app.ts';
import { profile, saveProfile } from '../profile.ts';
import { detectTouch } from '../game/input.ts';
import { diagnostics } from '../diagnostics.ts';
import { openTouchLayoutEditor } from './touch-layout-editor.ts';
import { h } from './dom.ts';
import { modal, seg, toast } from './overlay.ts';

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onChange: (v: number) => void) {
  const out = h('span', { style: 'font-family:var(--font-num);color:var(--text)' }, fmt(value));
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const num = h('input', {
    class: 'input',
    type: 'number',
    min,
    max,
    step,
    value: String(value),
    'aria-label': label + '（数值输入）',
    style: 'width:88px;height:32px;font-family:var(--font-num)',
    oninput: () => {
      const raw = num.value.trim();
      if (raw === '') return; // 空值忽略：不把空串当 0 存进 profile，也不改滑块与读数
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      const c = clamp(v);
      range.value = String(c);
      out.textContent = fmt(c);
      onChange(c);
    },
    // 编辑结束（回车 / 失焦）再归位数字框本身：输入中途改 value 会打断输入，
    // 但只同步滑块会留下「框里 300、存的是 110」的不一致，所以收尾时 number / range / 读数 / profile 一起对齐。
    onchange: () => {
      const raw = num.value.trim();
      const v = raw === '' ? NaN : Number(raw);
      const c = Number.isFinite(v) ? clamp(v) : clamp(Number(range.value));
      num.value = String(c);
      range.value = String(c);
      out.textContent = fmt(c);
      onChange(c);
    },
  });
  const range = h('input', {
    class: 'range',
    type: 'range',
    min,
    max,
    step,
    value: String(value),
    'aria-label': label + '（滑块）',
    oninput: () => {
      const v = Number(range.value);
      num.value = String(v);
      out.textContent = fmt(v);
      onChange(v);
    },
  });
  return h(
    'div',
    { class: 'field' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('label', null, label), out),
    h('div', { style: 'display:flex;gap:12px;align-items:center' }, range, num),
  );
}

const COLORS = ['#00ff9c', '#ffffff', '#ffe600', '#00e5ff', '#ff4fd8', '#ff4655'];

/** 网络线路：显示当前地址 / 状态 / 延迟，并可手动切到下一线路（Toy 主站与预览各有 /ws） */
function networkField() {
  const conn = app.conn;
  if (!conn) return null;
  const endpoint = h('div', { style: 'font-family:var(--font-num);font-size:12px;color:var(--text);word-break:break-all' });
  const meta = h('div', { style: 'font-size:12px;color:var(--muted);line-height:1.7' });
  const btn = h(
    'button',
    {
      class: 'btn ghost sm',
      type: 'button',
      onclick: () => {
        conn.cycleEndpoint();
        render();
      },
    },
    '切换线路',
  );
  const render = () => {
    const st =
      conn.status === 'open'
        ? '在线'
        : conn.status === 'connecting'
          ? '连接中'
          : conn.status === 'replaced'
            ? '已被另一个标签页接管'
            : '已断开';
    endpoint.textContent = conn.endpointLabel || '—';
    conn.probeLatency();
    const fps = diagnostics.fps === null ? '—' : `${Math.round(diagnostics.fps)}`;
    const snapshots = diagnostics.snapshotHz === null || conn.status !== 'open' ? '—' : `${diagnostics.snapshotHz.toFixed(1)}/s`;
    const fresh = conn.status === 'open' && diagnostics.sampledAt > 0 && performance.now() - diagnostics.sampledAt < 3000;
    const gap = !fresh || diagnostics.snapshotGapMs === null ? '—' : `${Math.round(diagnostics.snapshotGapMs)} ms`;
    const ack = !fresh || diagnostics.inputAckMs === null ? '—' : `${Math.round(diagnostics.inputAckMs)} ms`;
    const buffer = !fresh || diagnostics.sendBufferedBytes === null ? '—' : `${diagnostics.sendBufferedBytes} B`;
    const mode = conn.transport === 'webtransport' ? 'WebTransport' : 'WebSocket';
    const latency = conn.rtt === null || conn.status !== 'open' ? '—' : `${conn.rtt} ms（${mode}）`;
    meta.textContent = `线路 ${conn.line} · ${st} · 延迟 ${latency} · FPS ${fps} · 快照 ${snapshots} · 快照间隔最大 ${gap} · 输入确认 ${ack} · 发送缓冲 ${buffer} · 丢包率 不可获取${conn.lastError ? ` · ${conn.lastError}` : ''}`;
    meta.title = '延迟为应用层往返时间，括号内为当前传输（WebSocket / WebTransport）；输入确认从命令发送到收到累计 ACK，包含快照等待；快照间隔为最近一秒的最大到达间隔；发送缓冲为浏览器 WebSocket 待发送字节，不含服务器与系统网络队列。浏览器不暴露 TCP 丢包率。';
    btn.toggleAttribute('hidden', conn.endpointCount < 2);
  };
  render();
  const timer = window.setInterval(render, 1000);
  return {
    el: h('div', { class: 'field' }, h('label', null, '网络线路'), endpoint, meta, btn),
    dispose: () => clearInterval(timer),
  };
}

/** 操作模式：自动识别经常会被触屏笔记本 / 桌面触屏误判，允许手动强制键鼠或触屏 */
function controlField(changed: () => void) {
  const detected = detectTouch() ? '触屏' : '键鼠';
  const refresh = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => location.reload() }, '刷新页面');
  const control = seg(
    [
      { value: 'auto', label: '自动', testid: 'control-auto' },
      { value: 'touch', label: '触屏', testid: 'control-touch' },
      { value: 'mouse', label: '键鼠', testid: 'control-mouse' },
    ],
    profile.controlMode,
    (v) => {
      saveProfile({ controlMode: v });
      toast('操作模式已保存，刷新页面后生效', 'ok');
      changed();
    },
    {},
  );
  return h(
    'div',
    { class: 'field' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' }, h('label', null, '操作模式'), refresh),
    control,
    h('div', { class: 'field-hint' }, `自动检测：${detected} · 识别错时手动选择，刷新后生效`),
  );
}

/** onClose：弹窗以任何方式关闭（完成 / Esc / 点自身外罩）后回调一次；对局内菜单靠它把焦点还给「设置」按钮 */
export function openSettings(onChange?: () => void, onClose?: () => void) {
  const changed = () => onChange?.();
  const colors = h('div', { class: 'settings-colors', style: 'display:flex;gap:8px' });
  const renderColors = () =>
    colors.replaceChildren(
      ...COLORS.map((c) =>
        h('button', {
          class: 'btn icon sm',
          type: 'button',
          title: c,
          'aria-label': `准星颜色 ${c}${c === profile.crosshairColor ? '（当前使用）' : ''}`,
          'aria-pressed': c === profile.crosshairColor ? 'true' : 'false',
          style: `background:${c};border:2px solid ${c === profile.crosshairColor ? '#fff' : 'transparent'};box-shadow:${c === profile.crosshairColor ? '0 0 0 2px var(--red)' : 'none'}`,
          onclick: () => {
            saveProfile({ crosshairColor: c });
            renderColors();
            changed();
          },
        }),
      ),
    );
  renderColors();
  const net = networkField();
  const touchLayout = h('div', { class: 'field' },
    h('label', null, '触控键位布局'),
    h('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' },
      h('button', { class: 'btn ghost sm', type: 'button', 'data-testid': 'touch-layout-open', onclick: (e: MouseEvent) => openTouchLayoutEditor(e.currentTarget as HTMLElement, changed) }, '自定义布局'),
      h('span', { class: 'field-hint' }, 'Toy 玩家跨设备云同步；普通网页只存本机'),
    ),
  );
  const body = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:18px' },
    touchLayout,
    slider('鼠标灵敏度', 0.05, 3, 0.01, profile.sensitivity, (v) => v.toFixed(3), (v) => {
      saveProfile({ sensitivity: v });
      changed();
    }),
    slider('开镜灵敏度倍率', 0.2, 2, 0.05, profile.adsMultiplier, (v) => v.toFixed(2) + '×', (v) => {
      saveProfile({ adsMultiplier: v });
      changed();
    }),
    slider('视野（水平 FOV）', 80, 110, 1, profile.fov, (v) => v + '°', (v) => {
      saveProfile({ fov: v });
      changed();
    }),
    slider('总音量', 0, 1, 0.01, profile.volume, (v) => Math.round(v * 100) + '%', (v) => {
      saveProfile({ volume: v });
      changed();
    }),
    h('div', { class: 'field' }, h('label', null, '准星颜色'), colors),
    controlField(changed),
    net ? net.el : null,
  );
  return modal({ title: '设置', sub: '修改立即生效；触控布局可保存到玩家云存档', body, cancelText: '完成', testid: 'game-settings', onClose: () => {
    net?.dispose();
    onClose?.();
  } });
}
