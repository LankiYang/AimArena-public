// overlay.ts — 提示条与弹窗
import { h } from './dom.ts';

let toastBox: HTMLElement | null = null;
export function toast(text: string, kind: 'err' | 'ok' = 'err', ms = 2600) {
  if (!toastBox) document.body.append((toastBox = h('div', { class: 'toasts' })));
  const t = h('div', { class: ['toast', kind === 'ok' && 'ok'] }, text);
  toastBox.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export interface ModalOpts {
  title: string;
  sub?: string;
  body: Node;
  okText?: string;
  cancelText?: string;
  onOk?: () => boolean | void | Promise<boolean | void>;
  wide?: boolean;
  /** 给弹窗本体挂 data-testid（验收脚本用） */
  testid?: string;
  /** 给确定按钮挂 data-testid（验收脚本用） */
  okTestid?: string;
  /** 关闭（取消 / Esc / 点自身外罩 / 确定 四条路径都算）后调用**一次**；close() 幂等，重复调用不再触发 */
  onClose?: () => void;
}

/** Tab 焦点环：只在弹窗内的可聚焦元素之间循环（Shift+Tab 反向）；焦点跑到弹窗外就拉回第一个 */
export function trapTab(e: KeyboardEvent, root: HTMLElement) {
  const items = [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
  )];
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !root.contains(cur)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && cur === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && cur === last) {
    e.preventDefault();
    first.focus();
  }
}

/** 当前打开的弹窗（后打开的在上层）；Esc / Tab 只交给最上层处理。 */
const stack: HTMLElement[] = [];

export function modal(o: ModalOpts) {
  // 弹窗可以叠加（角色解锁弹窗会盖在「个人资料 / 选择特工」之上）：
  // 只有最上层响应 Esc / Tab / Enter，否则一次 Esc 会把两层一起关掉。
  // close 幂等：退出对局那条路径上，onOk 里的 onLeave() 会同步销毁整个对局（并主动关掉本弹窗），
  // 回来后 ok() 还会再调一次 close()——第二次必须是空操作，onClose 也只能触发一次。
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.remove();
    const at = stack.indexOf(wrap);
    if (at >= 0) stack.splice(at, 1);
    document.removeEventListener('keydown', onKey, true);
    o.onClose?.();
  };
  const okLabel = o.okText ?? '确定';
  let pending = false;
  let okBtn: HTMLButtonElement | null = null;
  const ok = async () => {
    if (pending) return;
    let result: boolean | void | Promise<boolean | void>;
    try {
      result = o.onOk?.();
    } catch {
      return;
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      pending = true;
      if (okBtn) {
        okBtn.disabled = true;
        okBtn.textContent = '检测中…';
      }
      try {
        if ((await (result as Promise<boolean | void>)) !== false) close();
      } catch {
        // 保留弹窗；调用方负责 toast 提示
      } finally {
        pending = false;
        if (okBtn) {
          okBtn.disabled = false;
          okBtn.textContent = okLabel;
        }
      }
      return;
    }
    if (result !== false) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (stack[stack.length - 1] !== wrap) return; // 叠加时只让最上层处理键盘
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      trapTab(e, wrap);
    } else if (e.key === 'Enter' && !e.repeat && o.onOk && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
      // 按钮交给原生键盘点击：聚焦「取消」按 Enter 不能被全局监听误当作确认。
      e.preventDefault();
      void ok();
    }
  };
  const wrap = h(
    'div',
    { class: 'modal-wrap', onmousedown: (e: MouseEvent) => e.target === wrap && close() },
    h(
      'div',
      { class: 'modal', style: o.wide ? 'width:min(720px,calc(100vw - 32px))' : '', 'data-testid': o.testid },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, o.title, o.sub ? h('small', null, o.sub) : null)),
      h('div', { class: 'modal-body' }, o.body),
      h(
        'div',
        { class: 'modal-foot' },
        h('button', { class: 'btn ghost', onclick: close }, o.cancelText ?? '取消'),
        o.onOk
          ? (okBtn = h(
              'button',
              { class: 'btn', style: 'background:var(--red);border-color:var(--red)', 'data-testid': o.okTestid, onclick: () => void ok() },
              okLabel,
            ))
          : null,
      ),
    ),
  );
  document.body.append(wrap);
  stack.push(wrap);
  document.addEventListener('keydown', onKey, true);
  (wrap.querySelector('input,select,button') as HTMLElement | null)?.focus();
  return close;
}

/** 分段选择控件 */
export function seg<T extends string | number>(
  options: { value: T; label: string; testid?: string }[],
  value: T,
  onChange: (v: T) => void,
  opts: { disabled?: boolean; cls?: string } = {},
) {
  const el = h('div', { class: ['seg', opts.cls] });
  const render = (v: T) => {
    el.replaceChildren(
      ...options.map((o) =>
        h(
          'button',
          {
            class: o.value === v ? 'on' : '',
            'data-testid': o.testid,
            disabled: opts.disabled,
            onclick: () => {
              if (o.value === v) return;
              render(o.value);
              onChange(o.value);
            },
          },
          o.label,
        ),
      ),
    );
  };
  render(value);
  return el;
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) {
  const input = h('input', { type: 'checkbox', checked, disabled, onchange: () => onChange(input.checked) });
  return h('label', { class: 'toggle', style: disabled ? 'opacity:.5;cursor:default' : '' }, input, h('span', { class: 'knob' }), label);
}
