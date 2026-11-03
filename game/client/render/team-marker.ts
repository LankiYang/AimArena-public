// 每个角色独立的阵营材质与头顶标牌，避免同一特工分属两队时共享材质串色。
//   标牌是「小号透明阵营符号（友方青色圆形 / 敌方红色菱形）+ 只给友方的名字」，没有黑色底板整条横幅：
//   贴图在构造时画一次，之后每帧只挪位置，不重绘、不分配新对象。
import * as THREE from 'three';
import { raycast, type BVH } from '../../shared/world/bvh.ts';
export type Allegiance = 'ally' | 'enemy' | 'neutral';
export function allegianceOf(localTeam: number | undefined, team: number | undefined): Allegiance {
  if ((localTeam !== 0 && localTeam !== 1) || (team !== 0 && team !== 1)) return 'neutral';
  return localTeam === team ? 'ally' : 'enemy';
}
export const TEAM_COLORS = { ally: '#53e3c2', enemy: '#ff5365', neutral: '#d4dce5' };

/** 符号贴图边长（像素）与头顶世界尺寸（米）；一次画好，运行时不再重绘 */
const SYMBOL_PX = 96;
const SYMBOL_SIZE = .24;
/** 名字：字号 / 描边（像素）、世界高度（米）、最多字符数；画布按实测文字宽度裁，不做整条底板 */
const NAME_FONT_PX = 32;
const NAME_OUTLINE_PX = 7;
const NAME_WORLD_H = .21;
const NAME_MAX_CHARS = 12;
/** 头顶高度（米）；符号在下、名字在上，都不压到脸和身体 */
const SYMBOL_Y = 2.16;
const NAME_GAP = .05;
const OUTLINE = 'rgba(4,10,16,.92)';

/**
 * 近距封顶：相机比 NEAR_SCALE_D 更近时，符号与名字的世界尺寸按 d / NEAR_SCALE_D 线性缩小，
 * 于是 1.2 m 和 2.5 m 的投影大小相同（1280×720 下符号画布约 20 px、可见图形约 17 px，名字字号约 12.5 px），
 * 不会再出现贴脸时一大块青点糊住视野；更远才回到原世界尺寸，再远自然变小。
 * 脚圈不参与缩放。
 */
const NEAR_SCALE_D = 6;
/** 默认视野（水平 103° / 16:9 → 竖直约 70.5°）的 tan(vfov/2)：开镜时 vfov 变小，按同一比例缩回去，ADS 不会把标牌放大 */
const REF_TAN_HALF_VFOV = Math.tan((70.5 * Math.PI) / 360);

/** 视野越窄（开镜）投影越大：按 tan 比例缩回去，且只缩不放 */
function fovShrink(camera: THREE.Camera): number {
  const cam = camera as THREE.PerspectiveCamera;
  if (cam.isPerspectiveCamera !== true || !(cam.fov > 0)) return 1;
  return Math.min(1, Math.tan((cam.fov * Math.PI) / 360) / REF_TAN_HALF_VFOV);
}

/** 贴图材质的统一口径：透明、深度测试开、不写深度（与脚圈一致） */
const MATERIAL = (map: THREE.Texture): THREE.SpriteMaterial =>
  new THREE.SpriteMaterial({ map, depthTest: true, depthWrite: false, toneMapped: false, transparent: true });

/** 阵营符号：友方实心圆、敌方菱形；同一套暗描边保证亮背景下不发糊 */
function symbolTexture(allegiance: Allegiance, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SYMBOL_PX; canvas.height = SYMBOL_PX;
  const ctx = canvas.getContext('2d')!;
  const c = SYMBOL_PX / 2, r = SYMBOL_PX * .34;
  ctx.beginPath();
  if (allegiance === 'enemy') {
    ctx.moveTo(c, c - r); ctx.lineTo(c + r, c); ctx.lineTo(c, c + r); ctx.lineTo(c - r, c); ctx.closePath();
  } else {
    ctx.arc(c, c, r, 0, Math.PI * 2);
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = SYMBOL_PX * .12; ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.fillStyle = color; ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 只有友方有名字：白色字 + 暗描边，宽度跟着文字走（最多 NAME_MAX_CHARS 字） */
function drawName(name: string): THREE.CanvasTexture {
  const chars = [...name.trim()];
  const text = chars.length > NAME_MAX_CHARS ? `${chars.slice(0, NAME_MAX_CHARS).join('')}…` : chars.join('');
  const font = `bold ${NAME_FONT_PX}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(NAME_FONT_PX, Math.ceil(measure.measureText(text).width) + NAME_OUTLINE_PX * 2 + 4);
  canvas.height = Math.ceil(NAME_FONT_PX + NAME_OUTLINE_PX * 2 + 4);
  const ctx = canvas.getContext('2d')!;
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = NAME_OUTLINE_PX; ctx.strokeStyle = OUTLINE;
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = '#eafff8'; ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class TeamMarker {
  readonly root = new THREE.Group();
  /** 头顶阵营符号（友方圆形 / 敌方菱形） */
  readonly symbol: THREE.Sprite;
  /** 友方名字；敌方 / 空名字为 null（不给敌人文字节） */
  readonly nameTag: THREE.Sprite | null;
  private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly symbolTexture: THREE.CanvasTexture;
  private readonly nameTexture: THREE.CanvasTexture | null;
  /** 名字画布的世界宽度（构造时按贴图比例算一次；每帧只乘缩放，不重算） */
  private readonly nameWorldW: number;
  private readonly nameOffset: number;
  private readonly point = new THREE.Vector3();
  readonly allegiance: Allegiance;

  constructor(allegiance: Allegiance, name: string) {
    this.allegiance = allegiance;
    this.root.name = `team:${allegiance}`;
    const color = TEAM_COLORS[allegiance];
    // —— 小号透明阵营符号 ——
    this.symbolTexture = symbolTexture(allegiance, color);
    this.symbol = new THREE.Sprite(MATERIAL(this.symbolTexture));
    this.symbol.name = `symbol:${allegiance}`;
    this.symbol.scale.set(SYMBOL_SIZE, SYMBOL_SIZE, 1);
    this.symbol.position.y = SYMBOL_Y;
    this.root.add(this.symbol);
    // —— 友方名字（窄、只有文字，没有底板）——
    const trimmed = allegiance === 'ally' ? name.trim() : '';
    this.nameTexture = trimmed ? drawName(trimmed) : null;
    this.nameTag = this.nameTexture ? new THREE.Sprite(MATERIAL(this.nameTexture)) : null;
    this.nameOffset = SYMBOL_SIZE / 2 + NAME_GAP + NAME_WORLD_H / 2;
    this.nameWorldW = NAME_WORLD_H;
    if (this.nameTag && this.nameTexture) {
      const canvas = this.nameTexture.image as HTMLCanvasElement;
      this.nameTag.name = 'name:ally';
      this.nameWorldW = NAME_WORLD_H * canvas.width / canvas.height;
      this.nameTag.scale.set(this.nameWorldW, NAME_WORLD_H, 1);
      this.nameTag.position.y = SYMBOL_Y + this.nameOffset;
      this.root.add(this.nameTag);
    }
    this.ring = new THREE.Mesh(new THREE.RingGeometry(.38, .43, 40), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: true, depthWrite: false, toneMapped: false }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = .025;
    this.root.add(this.ring);
  }

  update(camera: THREE.Camera, world: BVH, crouch: number): void {
    // 标牌即使露出墙顶也不能泄露被墙挡住的角色；按胸口视线额外剔除整组标识。
    this.root.getWorldPosition(this.point); this.point.y += 1.15 - .3 * crouch;
    const dx = this.point.x - camera.position.x, dy = this.point.y - camera.position.y, dz = this.point.z - camera.position.z;
    const d = Math.hypot(dx, dy, dz);
    this.root.visible = d > .01 && d < 55 && !raycast(world, camera.position.x, camera.position.y, camera.position.z, dx / d, dy / d, dz / d, d);
    // 近距按相机距离缩小世界尺寸（投影大小封顶），开镜再按视野比例缩回去；只改 scale / y，不重绘贴图
    const near = d < NEAR_SCALE_D ? d / NEAR_SCALE_D : 1;
    const k = near * fovShrink(camera);
    this.symbol.scale.set(SYMBOL_SIZE * k, SYMBOL_SIZE * k, 1);
    // 下蹲时整组跟着头走：只改数值，不重绘贴图；名字间距同比例缩，贴脸时不会飘到屏幕外
    const lift = SYMBOL_Y - .4 * crouch;
    this.symbol.position.y = lift;
    if (this.nameTag) {
      this.nameTag.scale.set(this.nameWorldW * k, NAME_WORLD_H * k, 1);
      this.nameTag.position.y = lift + this.nameOffset * k;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.symbolTexture.dispose(); this.symbol.material.dispose();
    if (this.nameTag && this.nameTexture) { this.nameTexture.dispose(); this.nameTag.material.dispose(); }
    this.ring.geometry.dispose(); this.ring.material.dispose();
  }
}