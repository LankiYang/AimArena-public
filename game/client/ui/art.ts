// Self-contained geometric illustrations for the interface.
import type { AgentId, MapId } from '../../shared/catalog.ts';
import type { WeaponId } from '../../shared/combat.ts';

const svg = (body: string, viewBox: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`)}`;
const hue = (id: string) => Array.from(id).reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0);
const label = (id: string) => id.replace(/[^a-z0-9-]/gi, '').toUpperCase();

export const agentArt = (id: AgentId) => svg(`
  <rect width="240" height="320" fill="hsl(${hue(id)} 30% 18%)"/>
  <path d="M0 250 240 30v290H0Z" fill="hsl(${hue(id)} 45% 27%)"/>
  <path d="M83 91 120 62l37 29v50l-37 27-37-27ZM57 224l21-54 42 15 42-15 21 54 15 63H42Z" fill="#c6d3d4"/>
  <path d="M91 110h58v12H91ZM83 212l37 24 37-24" fill="none" stroke="#233842" stroke-width="8"/>
  <text x="120" y="309" fill="#fff" font-family="sans-serif" font-size="16" text-anchor="middle">${label(id)}</text>`, '0 0 240 320');

export const mapCover = (id: MapId) => svg(`
  <rect width="480" height="270" fill="hsl(${hue(id)} 25% 16%)"/>
  <path d="M0 210 105 130 181 171 286 76 480 162v108H0Z" fill="hsl(${hue(id)} 28% 29%)"/>
  <path d="M0 245 110 190 177 212 282 141 480 209v61H0Z" fill="#172c34"/>
  <path d="M72 208v-77l48-23v84m90 15v-74l55-29v75m62 20v-75l54 23v67" fill="none" stroke="#8da8a5" stroke-width="4"/>
  <text x="24" y="245" fill="#fff" font-family="sans-serif" font-size="24" font-weight="bold">${label(id)}</text>`, '0 0 480 270');
export const mapSlice = mapCover;
export const bg = (url: string) => `url("${url}")`;

export const weaponIcon = (id: WeaponId): string => svg(`
  <path d="M8 31h20l5-8h31l6 5h34v7H74l-8 8H48l-5 13H31l4-13H20l-4-6H8Z" fill="#e2e8e8"/>
  <text x="60" y="70" fill="#e2e8e8" font-family="sans-serif" font-size="10" text-anchor="middle">${label(id)}</text>`, '0 0 120 76');
