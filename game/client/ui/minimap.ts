import type { MapId } from '../../shared/catalog.ts';
import { MAP_BY_ID } from '../../shared/catalog.ts';
import * as THREE from 'three';
import { MINIMAP_TURNS, minimapHeading, minimapPoint, type MinimapDoc } from '../../shared/minimap.ts';
import { createPublicMap } from '../../shared/public-map.ts';
import { h } from './dom.ts';
import '../styles/match-intel.css';

export interface RadarContact { id: number; x: number; z: number; yaw: number; alive: boolean; ally: boolean; }
export interface RadarFrame {
  self: { x: number; z: number; yaw: number; alive: boolean } | null;
  contacts: RadarContact[];
  /**
   * 观战（阶段11）：非 null = 正在观战这个队友（名字），箭头画在他身上、状态文字改成「观战中」。
   * 敌人红点始终按「当前观察者的视线」算，观察者是谁由对局层决定（活着=自己，观战=被观战队友）：
   * 本组件不重算可见性，只负责画。
   */
  spectating?: string | null;
}

interface MinimapAsset {
  doc: MinimapDoc;
  image: HTMLCanvasElement;
}

/** Build the radar image and its world transform from the same geometry as the arena. */
const minimapCache = new Map<MapId, Promise<MinimapAsset>>();
function loadMinimapAsset(map: MapId): Promise<MinimapAsset> {
  const existing = minimapCache.get(map);
  if (existing) return existing;
  const p = Promise.resolve().then(() => {
    const { scene } = createPublicMap(map);
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(scene);
    const extent = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 1.08;
    const minX = (bounds.min.x + bounds.max.x - extent) / 2;
    const minZ = (bounds.min.z + bounds.max.z - extent) / 2;
    const doc: MinimapDoc = { map, image: '', transform: {
      scaleU: 1 / extent, scaleV: 1 / extent, offsetU: -minX / extent, offsetV: -minZ / extent,
    }, callouts: [] };
    const image = document.createElement('canvas');
    image.width = image.height = 512;
    const context = image.getContext('2d');
    if (!context) throw new Error('小地图画布不可用');
    context.fillStyle = '#182b31';
    context.fillRect(0, 0, image.width, image.height);
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const box = new THREE.Box3().setFromObject(object);
      const x = (box.min.x - minX) / extent * image.width;
      const z = (box.min.z - minZ) / extent * image.height;
      context.fillStyle = box.max.y <= 0.01 ? '#42585b' : '#9cafaa';
      context.fillRect(x, z, (box.max.x - box.min.x) / extent * image.width, (box.max.z - box.min.z) / extent * image.height);
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    return { doc, image };
  });
  minimapCache.set(map, p);
  p.catch(() => { if (minimapCache.get(map) === p) minimapCache.delete(map); });
  return p;
}

/** 纯显示，不创建输入/网络计分入口；外部只传入队友及真正可见的敌人。 */
export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly label: HTMLElement;
  private readonly status: HTMLElement;
  private image: HTMLCanvasElement | null = null;
  private readonly resize: ResizeObserver;
  private doc: MinimapDoc | null = null;
  private disposed = false;
  private frame: RadarFrame = { self: null, contacts: [] };
  private drawn = { self: false, allies: 0, enemies: 0 };
  constructor(root: HTMLElement, map: MapId) {
    this.canvas = h('canvas', { class: 'minimap-canvas', 'data-testid': 'minimap-canvas', 'aria-hidden': 'true' });
    this.label = h('span', { class: 'minimap-location' }, MAP_BY_ID[map].name);
    this.status = h('span', { class: 'minimap-status' }, '加载中');
    this.el = h('section', { class: 'match-minimap', 'data-testid': 'match-minimap', role: 'img',
      'aria-label': '小地图：蓝箭头是自己，青点是队友，红菱形仅显示当前视线内的敌人；观战时箭头与红点跟随被观战队友' },
      this.canvas, h('div', { class: 'minimap-caption' }, this.label, this.status),
      h('div', { class: 'minimap-legend' }, h('span', { class: 'self' }, '▲ 自己'), h('span', { class: 'ally' }, '● 队友'), h('span', { class: 'enemy' }, '◆ 可见敌人')));
    root.append(this.el);
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(this.canvas);
    void this.load(map);
  }

  private async load(map: MapId) {
    try {
      const asset = await loadMinimapAsset(map);
      if (this.disposed) return;
      this.doc = asset.doc;
      this.image = asset.image;
      this.el.dataset.ready = 'true';
      this.status.textContent = '固定朝向';
      this.draw();
    } catch (e) {
      if (this.disposed) return;
      this.el.dataset.error = 'true';
      this.status.textContent = '暂不可用';
      this.el.title = e instanceof Error ? e.message : String(e);
    }
  }

  update(frame: RadarFrame) {
    if (this.disposed) return;
    this.frame = frame;
    if (frame.self && this.doc) {
      let nearest = '', distance = 14;
      for (const c of this.doc.callouts) {
        const d = Math.hypot(c.x - frame.self.x, c.z - frame.self.z);
        if (d < distance) { distance = d; nearest = c.name; }
      }
      this.label.textContent = nearest || MAP_BY_ID[this.doc.map].name;
      // 观战（阶段11）：状态文字写「观战中 · 名字」——箭头与敌人红点就是被观战队友的位置与视线；
      // 死亡但没有存活队友时才是原来的「等待复活」（自由转头）。
      this.status.textContent = frame.spectating ? `观战中 · ${frame.spectating}` : frame.self.alive ? '固定朝向' : '等待复活';
      this.el.classList.toggle('is-spectating', !!frame.spectating);
    }
    this.draw();
  }

  private draw() {
    if (this.disposed) return;
    const size = this.canvas.clientWidth;
    if (!size) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), pixels = Math.round(size * dpr);
    if (this.canvas.width !== pixels || this.canvas.height !== pixels) this.canvas.width = this.canvas.height = pixels;
    const c = this.canvas.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, size, size);
    c.fillStyle = 'rgba(8,16,23,.82)'; c.fillRect(0, 0, size, size);
    const doc = this.doc;
    this.drawn = { self: false, allies: 0, enemies: 0 };
    if (!doc || !this.image) return;
    c.save(); c.translate(size / 2, size / 2); c.rotate(MINIMAP_TURNS[doc.map] * Math.PI / 2);
    c.globalAlpha = .9; c.drawImage(this.image, -size / 2, -size / 2, size, size); c.restore();
    const scale = Math.max(.8, size / 160);
    const point = (x: number, z: number) => {
      const p = minimapPoint(doc, x, z);
      // 悬空/地图外坐标不钉在边缘伪装成有效位置。
      return Number.isFinite(p.u) && Number.isFinite(p.v) && p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1
        ? { x: p.u * size, y: p.v * size } : null;
    };
    for (const contact of this.frame.contacts) {
      if (!contact.ally && !contact.alive) continue;
      const p = point(contact.x, contact.z); if (!p) continue;
      c.save(); c.translate(p.x, p.y); c.lineWidth = 1.5 * scale; c.strokeStyle = '#071017';
      if (!contact.alive) {
        c.strokeStyle = '#97a7ad'; c.beginPath(); c.moveTo(-3 * scale, -3 * scale); c.lineTo(3 * scale, 3 * scale);
        c.moveTo(3 * scale, -3 * scale); c.lineTo(-3 * scale, 3 * scale); c.stroke();
      } else if (contact.ally) {
        c.fillStyle = '#53e3c2'; c.beginPath(); c.arc(0, 0, 3.6 * scale, 0, Math.PI * 2); c.fill(); c.stroke();
      } else {
        c.rotate(Math.PI / 4); c.fillStyle = '#ff5365'; c.fillRect(-3.3 * scale, -3.3 * scale, 6.6 * scale, 6.6 * scale); c.strokeRect(-3.3 * scale, -3.3 * scale, 6.6 * scale, 6.6 * scale);
      }
      c.restore();
      if (contact.ally) this.drawn.allies++; else this.drawn.enemies++;
    }
    const self = this.frame.self, p = self && point(self.x, self.z);
    if (self && p) {
      c.save(); c.translate(p.x, p.y); c.rotate(minimapHeading(doc, self.yaw));
      c.globalAlpha = self.alive ? 1 : .5;
      c.fillStyle = '#88d9ff'; c.strokeStyle = '#fff'; c.lineWidth = 1.1 * scale;
      c.beginPath(); c.moveTo(0, -6 * scale); c.lineTo(4.1 * scale, 4.5 * scale); c.lineTo(0, 2 * scale); c.lineTo(-4.1 * scale, 4.5 * scale); c.closePath(); c.fill(); c.stroke(); c.restore();
      this.drawn.self = true;
    }
  }

  /** 只读验收信息，不提供改坐标/伪造可见性的入口。 */
  stats() { return { ready: !!this.doc, spectating: this.frame.spectating ?? null, ...this.drawn }; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.resize.disconnect();
    this.image = null;
    this.el.remove();
  }
}
