// Self-contained procedural combat sounds. No samples or network requests are used.
import type { CombatEvent, V3, WeaponId } from '../../shared/combat.ts';

type ShotEvent = Extract<CombatEvent, { kind: 'shot' }>;
type ShotSound = Pick<ShotEvent, 'weapon' | 'shooter' | 'origin' | 'heavy'>;
type Voice = { source: AudioBufferSourceNode; nodes: AudioNode[] };

const MASTER_GAIN = 0.9;
const MAX_SOURCES = 16;
const SHOT_DISTANCE = 60;
const STEP_DISTANCE = 20;
const KILL_WINDOW_MS = 3500;

// Duration, low-frequency body, and noise brightness give each weapon its own voice.
const SHOTS: Record<Exclude<WeaponId, 'melee'>, readonly [number, number, number]> = {
  classic: [0.17, 155, 0.62], shorty: [0.25, 105, 0.85],
  frenzy: [0.12, 180, 0.7], ghost: [0.13, 190, 0.38],
  sheriff: [0.25, 105, 0.75], stinger: [0.11, 185, 0.72],
  spectre: [0.13, 150, 0.42], bucky: [0.3, 90, 0.9],
  judge: [0.23, 110, 0.88], bulldog: [0.2, 125, 0.7],
  guardian: [0.24, 105, 0.74], phantom: [0.16, 140, 0.45],
  vandal: [0.21, 120, 0.76], marshal: [0.28, 100, 0.65],
  outlaw: [0.3, 85, 0.8], operator: [0.37, 75, 0.85],
  ares: [0.18, 125, 0.73], odin: [0.2, 105, 0.8],
};

export class CombatAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private disposed = false;
  private volume = 1;
  private yaw = 0;
  private stepsRequested = false;
  private nextStep = 0;
  private killStreak = 0;
  private lastKillAt = 0;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly voices = new Set<Voice>();

  setVolume(volume: number): void {
    if (this.disposed) return;
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
    if (this.master) this.master.gain.value = MASTER_GAIN * this.volume;
  }

  setListenerYaw(yaw: number): void {
    if (this.disposed) return;
    this.yaw = Number.isFinite(yaw) ? yaw : 0;
    if (this.ctx) setOrientation(this.ctx, this.yaw);
  }

  // AudioContext creation and resume must happen in a user gesture.
  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      const w = typeof window === 'undefined' ? undefined : window as unknown as {
        AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = w?.AudioContext ?? w?.webkitAudioContext;
      if (!Ctor) return;
      try {
        const ctx = new Ctor();
        const master = ctx.createGain();
        master.gain.value = MASTER_GAIN * this.volume;
        master.connect(ctx.destination);
        this.ctx = ctx;
        this.master = master;
      } catch {
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    setOrientation(this.ctx, this.yaw);
    if (this.stepsRequested) this.prepareSteps();
  }

  async prepare(weapon: WeaponId): Promise<void> {
    this.unlock();
    if (weapon !== 'melee') this.sound(`shot:${weapon}`);
  }

  prepareSteps(): void {
    if (this.disposed) return;
    this.stepsRequested = true;
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) this.sound(`step:${i}`);
  }

  playStep(origin: V3, listener: V3, local: boolean): void {
    const index = this.nextStep;
    this.nextStep = (index + 1) % 3;
    this.playSound(`step:${index}`, local ? 0.32 : 0.4, origin, listener, local, STEP_DISTANCE);
  }

  playLocal(weapon: WeaponId, listener: V3, heavy: boolean): void {
    this.playShot({ weapon, shooter: 0, origin: listener, heavy }, listener, 0);
  }

  playMelee(player: number, origin: V3, listener: V3, localId: number, heavy: boolean): void {
    this.playShot({ weapon: 'melee', shooter: player, origin, heavy }, listener, localId);
  }

  play(event: CombatEvent, listener: V3, localId: number): void {
    if (this.disposed) return;
    if (event.kind === 'shot') this.playShot(event, listener, localId);
    else if (event.kind === 'reload' && event.player === localId) this.playSound('reload', 0.45);
    else if (event.kind === 'death') {
      if (event.player === localId) {
        this.killStreak = 0;
        this.lastKillAt = 0;
      } else if (event.killer === localId) {
        const now = performance.now();
        if (now - this.lastKillAt > KILL_WINDOW_MS) this.killStreak = 0;
        this.killStreak = Math.min(5, this.killStreak + 1);
        this.lastKillAt = now;
        this.playSound(`kill:${this.killStreak}`, 0.65);
      }
    } else if (event.kind === 'roundStart' || event.kind === 'matchStart') {
      this.killStreak = 0;
      this.lastKillAt = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of this.voices) this.drop(voice, true);
    this.buffers.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }

  private playShot(event: ShotSound, listener: V3, localId: number): void {
    const key = event.weapon === 'melee' ? `melee:${event.heavy ? 'heavy' : 'light'}` : `shot:${event.weapon}`;
    this.playSound(key, event.weapon === 'melee' ? 0.55 : 0.8, event.origin, listener, event.shooter === localId, SHOT_DISTANCE);
  }

  private playSound(key: string, volume: number, origin?: V3, listener?: V3, local = true, maxDistance = SHOT_DISTANCE): void {
    const ctx = this.ctx;
    const master = this.master;
    if (this.disposed || !ctx || !master || ctx.state === 'closed') return;
    if (!local && origin && listener && !(Math.hypot(origin.x - listener.x, origin.y - listener.y, origin.z - listener.z) < maxDistance)) return;
    const buffer = this.sound(key);
    if (!buffer) return;
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      gain.gain.value = volume;
      source.connect(gain);
      const nodes: AudioNode[] = [source, gain];
      if (!local && origin && listener) {
        const panner = ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'linear';
        panner.refDistance = 1;
        panner.maxDistance = maxDistance;
        panner.rolloffFactor = 1;
        panner.positionX.value = origin.x;
        panner.positionY.value = origin.y;
        panner.positionZ.value = origin.z;
        ctx.listener.positionX.value = listener.x;
        ctx.listener.positionY.value = listener.y;
        ctx.listener.positionZ.value = listener.z;
        setOrientation(ctx, this.yaw);
        gain.connect(panner);
        panner.connect(master);
        nodes.push(panner);
      } else gain.connect(master);
      if (this.voices.size >= MAX_SOURCES) {
        const oldest = this.voices.values().next().value;
        if (oldest) this.drop(oldest, true);
      }
      const voice: Voice = { source, nodes };
      this.voices.add(voice);
      source.onended = () => this.drop(voice, false);
      try { source.start(); } catch { this.drop(voice, true); }
    } catch {
      // Audio is optional and must not interrupt gameplay.
    }
  }

  private drop(voice: Voice, stop: boolean): void {
    if (!this.voices.delete(voice)) return;
    voice.source.onended = null;
    if (stop) {
      try { voice.source.stop(); } catch { /* already stopped */ }
    }
    for (const node of voice.nodes) node.disconnect();
  }

  private sound(key: string): AudioBuffer | null {
    const cached = this.buffers.get(key);
    if (cached) return cached;
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return null;
    try {
      const buffer = synthesize(ctx, key);
      this.buffers.set(key, buffer);
      return buffer;
    } catch {
      return null;
    }
  }
}

function setOrientation(ctx: AudioContext, yaw: number): void {
  const listener = ctx.listener;
  listener.forwardX.value = -Math.sin(yaw);
  listener.forwardY.value = 0;
  listener.forwardZ.value = -Math.cos(yaw);
  listener.upX.value = 0;
  listener.upY.value = 1;
  listener.upZ.value = 0;
}

// Synthesis happens once per sound, then the resulting buffer is reused for every voice.
function synthesize(ctx: AudioContext, key: string): AudioBuffer {
  const [kind, variant] = key.split(':');
  const shot = kind === 'shot' ? SHOTS[variant as Exclude<WeaponId, 'melee'>] : undefined;
  const duration = shot ? shot[0] : kind === 'step' ? 0.16 : kind === 'melee' ? 0.2 : kind === 'reload' ? 0.12 : 0.4;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Seeded noise makes the generated variants stable without shipping any recordings.
  let seed = 2166136261;
  for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 16777619);
  let filtered = 0;
  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / ctx.sampleRate;
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const noise = (seed >>> 0) / 2147483648 - 1;
    let value: number;
    if (shot) {
      filtered += (noise - filtered) * shot[2];
      phase += 2 * Math.PI * shot[1] * (1 - 0.55 * t / duration) / ctx.sampleRate;
      value = filtered * Math.exp(-t * 23) * 0.65 + Math.sin(phase) * Math.exp(-t * 14) * 0.38;
    } else if (kind === 'step') {
      filtered += (noise - filtered) * 0.08;
      phase += 2 * Math.PI * (80 + Number(variant) * 9) / ctx.sampleRate;
      value = (filtered * 1.3 + Math.sin(phase) * 0.3) * Math.exp(-t * 27);
    } else if (kind === 'melee') {
      filtered += (noise - filtered) * 0.2;
      const envelope = Math.sin(Math.PI * t / duration);
      phase += 2 * Math.PI * (variant === 'heavy' ? 120 : 200) * (1 - t / duration * 0.6) / ctx.sampleRate;
      value = (filtered * 0.7 + Math.sin(phase) * 0.25) * envelope;
    } else if (kind === 'reload') {
      filtered += (noise - filtered) * 0.5;
      value = filtered * (Math.exp(-t * 80) + (t > 0.055 ? Math.exp(-(t - 0.055) * 100) : 0)) * 0.45;
    } else {
      const level = Number(variant) || 1;
      const frequency = 480 * Math.pow(2, (level - 1) / 12);
      phase += 2 * Math.PI * frequency * (t > 0.11 ? 1.5 : 1) / ctx.sampleRate;
      value = (Math.sin(phase) + 0.25 * Math.sin(phase * 2)) * Math.exp(-t * 8) * 0.42;
    }
    data[i] = Math.max(-1, Math.min(1, value));
  }
  return buffer;
}
