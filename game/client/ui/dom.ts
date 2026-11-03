// dom.ts — 极简 DOM 构建工具（无框架）
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & {
  class?: string | (string | false | null | undefined)[];
  style?: string | Partial<CSSStyleDeclaration>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** 用新内容替换元素的全部子节点 */
export function set(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

/** 内联 SVG 图标（线性，24 网格） */
const ICONS: Record<string, string> = {
  gear: '<rect x="5" y="5" width="14" height="14"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  back: '<path d="M19 12H5m0 0 5-5m-5 5 5 5"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  x: '<path d="M5 5l14 14M19 5 5 19"/>',
  crown: '<path d="M3 7l4 5 5-7 5 7 4-5-2 12H5Z"/>',
  bot: '<rect x="4" y="7" width="16" height="13"/><path d="M12 3v4M8 12h2m4 0h2M8 16h8"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>',
  refresh: '<path d="M19 8V4l-3 3M5 16v4l3-3M16 7H8L4 11M8 17h8l4-4"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-3l3-3h6l3 3v3M16 5l3 3-3 3M17 14l4 3v3"/>',
  lock: '<rect x="5" y="10" width="14" height="11"/><path d="M8 10V7l2-3h4l2 3v3M12 14v3"/>',
  eye: '<path d="M2 12l5-5h10l5 5-5 5H7Z"/><circle cx="12" cy="12" r="2"/>',
  play: '<path d="M6 4l14 8-14 8Z"/>',
  send: '<path d="M3 4l18 8-18 8 4-8ZM7 12h14"/>',
  swap: '<path d="M7 4v16m0-16L4 7m3-3 3 3m7 13V4m0 16-3-3m3 3 3-3"/>',
};
export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return span.firstChild as SVGSVGElement;
}
