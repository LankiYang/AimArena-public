// landing.ts — 首页：昵称 + 选角色 → 进入大厅
import { AGENTS, AGENT_BY_ID } from '../../shared/catalog.ts';
import { CLIENT_VERSION } from '../../shared/lobby.ts';
import { app, type Screen } from '../app.ts';
import { profile, saveProfile } from '../profile.ts';
import { agentArt, bg, mapCover } from './art.ts';
import { h } from './dom.ts';
import { toast } from './overlay.ts';
import { detectTouch } from '../game/input.ts';

/** 特工九宫格；testidPrefix 非空时给每格挂 `${testidPrefix}${agentId}`（房间底栏用 `agent-`） */
export function agentPicker(selected: string, onPick: (id: (typeof AGENTS)[number]['id']) => void, cls = 'agent-pick', testidPrefix = '') {
  const el = h('div', { class: cls });
  let sel = selected;
  const pick = (id: (typeof AGENTS)[number]['id']) => {
    render(id);
    onPick(id);
  };
  const render = (next: string) => {
    sel = next;
    el.replaceChildren(
      ...AGENTS.map((a) => {
        return h(
          'div',
          {
            class: ['agent-tile', a.id === sel && 'on'],
            'data-name': a.name,
            'data-testid': testidPrefix ? `${testidPrefix}${a.id}` : undefined,
            title: `${a.name} · ${a.role}`,
            role: 'button',
            tabindex: 0,
            'aria-label': `选择特工 ${a.name}`,
            'aria-pressed': String(a.id === sel),
            onkeydown: (e: KeyboardEvent) => {
              if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                e.preventDefault();
                pick(a.id);
              }
            },
            style: { backgroundImage: bg(agentArt(a.id)) },
            onclick: () => pick(a.id),
          },
        );
      }),
    );
  };
  render(selected);
  return el;
}

export function landingScreen(): Screen {
  const hero = h('div', { class: 'agent-hero', style: { backgroundImage: bg(agentArt(profile.agent)) } });
  const word = h('div', { class: 'hero-word' }, AGENT_BY_ID[profile.agent].en);
  const name = h('input', {
    class: 'input',
    placeholder: '输入你的代号（最多 16 字）',
    maxLength: 16,
    value: profile.name,
    onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && go(),
  });
  const go = () => {
    const n = name.value.trim();
    if (!n) {
      toast('先起个代号');
      name.focus();
      return;
    }
    saveProfile({ name: n });
    app.connect();
  };
  const picker = agentPicker(profile.agent, (id) => {
    saveProfile({ agent: id });
    hero.style.backgroundImage = bg(agentArt(id));
    hero.style.animation = 'none';
    void hero.offsetWidth;
    hero.style.animation = '';
    word.textContent = AGENT_BY_ID[id].en;
  });

  const el = h(
    'div',
    { class: 'landing' },
    h('div', { class: 'backdrop' }, h('div', { class: 'img', style: { backgroundImage: bg(mapCover('ascent')) } })),
    word,
    hero,
    h(
      'div',
      { class: 'landing-main' },
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'brand-tag' }, 'PVP · 5V5'),
        h('h1', { class: 'brand-title' }, '尖峰', h('br'), '对决', h('span', { class: 'en' }, 'PEAK SHOWDOWN')),
        h('p', { class: 'brand-sub' }, '浏览器里的 5v5 对战：团队死斗、爆破和经典生化，人机队友与对手随时补位，开房间拉朋友一起打。'),
      ),
      h(
        'div',
        { class: 'panel landing-card' },
        h('div', { class: 'field' }, h('label', null, '代号'), name),
        h('div', { class: 'field' }, h('label', null, '选择特工'), picker),
        h('button', { class: 'btn primary block', onclick: go }, '进入大厅'),
      ),
      h(
        'div',
        { class: 'landing-foot' },
        h('span', null, h('i', { class: 'kbd' }, 'W'), h('i', { class: 'kbd' }, 'A'), h('i', { class: 'kbd' }, 'S'), h('i', { class: 'kbd' }, 'D'), '移动'),
        h('span', null, h('i', { class: 'kbd' }, 'SHIFT'), '静步'),
        h('span', null, h('i', { class: 'kbd' }, 'CTRL'), '蹲'),
        h('span', null, h('i', { class: 'kbd' }, 'R'), '换弹'),
        h('span', null, h('i', { class: 'kbd' }, 'TAB'), '计分板'),
      ),
    ),
    h('span', { class: 'landing-version' }, `v${CLIENT_VERSION}`),
  );
  // 触屏进入首页时不要主动弹出软键盘、遮住角色与进入按钮。
  if (!detectTouch()) setTimeout(() => name.isConnected && name.focus(), 50);
  return { el };
}
