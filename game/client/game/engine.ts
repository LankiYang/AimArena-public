// WebGL renderer, camera and viewport sizing.
import * as THREE from 'three';
import { detectTouch } from './input.ts';

/** Horizontal field of view is fixed on wide screens and vertical on narrow screens. */
export function hfovToVfov(hdeg: number, aspect: number) {
  const halfWidth = Math.tan(THREE.MathUtils.degToRad(hdeg) / 2);
  return THREE.MathUtils.radToDeg(2 * Math.atan(halfWidth / Math.max(aspect, 16 / 9)));
}

export class Engine {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  hfov = 103;
  zoom = 1;
  private onResize = () => this.resize();
  private container: HTMLElement;
  private observer: ResizeObserver | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: devicePixelRatio < 1.5, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.autoClear = false;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'game-canvas';
    container.append(this.canvas);
    this.scene.background = new THREE.Color('#111820');
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    addEventListener('resize', this.onResize);
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.onResize);
    this.observer?.observe(container);
    this.resize();
  }

  setFov(hfov: number, zoom = 1) {
    this.hfov = hfov;
    this.zoom = zoom;
    this.updateFov();
  }

  private updateFov() {
    const aspect = this.camera.aspect;
    // Zoom scales the tangent of the half-angle.
    const h = (2 * Math.atan(Math.tan((this.hfov * Math.PI) / 360) / this.zoom) * 180) / Math.PI;
    this.camera.fov = hfovToVfov(h, aspect);
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth),
      h = Math.max(1, this.container.clientHeight);
    // 手机上限制填充率；高 DPR 不等于更好的手感。桌面保持原来的 2x 上限。
    const mobile = detectTouch();
    const ratio = Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2, mobile ? Math.sqrt(1_300_000 / (w * h)) : Infinity);
    this.renderer.setPixelRatio(Math.max(0.5, ratio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.updateFov();
  }

  dispose() {
    removeEventListener('resize', this.onResize);
    this.observer?.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
