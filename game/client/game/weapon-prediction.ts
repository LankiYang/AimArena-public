import type { CombatSelf, WeaponId, WeaponState } from '../../shared/combat.ts';
import { BTN, type UserCmd } from '../../shared/protocol.ts';
import { TICK_RATE } from '../../shared/sim/tick.ts';
import { canAttack, cloneWeaponState, stepWeaponInput, type WeaponAttack } from '../../shared/sim/weapons.ts';
import type { WeaponPose } from '../../shared/sim/weapon-game.ts';

/** 本地武器预测：声音、开火动作、相机后坐力，以及 HUD 的弹药 / 换弹 / 选枪显示。
 *  射线、命中与伤害仍然只以服务器为准。 */
export class LocalWeaponPrediction {
  state: WeaponState | null = null;
  tick = 0;
  private readonly commands: { command: UserCmd; pose?: WeaponPose; sampledTick: number }[] = [];
  /** State at the last acknowledged command, before replaying pending input. */
  private acknowledgedState: WeaponState | null = null;
  private readonly presented = new Map<number, { weapon: string; commandSeq: number }>();
  private readonly presentedMeleeCommands = new Set<number>();
  private readonly meleeStarts = new Set<number>();
  private buttons = 0;
  private acknowledgedButtons = 0;

  private readonly present: (attack: WeaponAttack, tick: number) => boolean;

  constructor(present: (attack: WeaponAttack, tick: number) => boolean) {
    this.present = present;
  }

  command(command: UserCmd, alive: boolean, frozen: boolean, pose?: WeaponPose): void {
    this.commands.push({ command, pose, sampledTick: this.tick + 1 });
    if (this.commands.length > 128) this.commands.shift();
    this.advance(command, alive, frozen, pose);
  }

  reconcile(self: CombatSelf, tick: number, frozen: boolean): void {
    const full = self.prediction;
    // A compact snapshot has no weapon simulation state. Advance the last acknowledged
    // baseline through newly acknowledged commands, never through the already-predicted
    // future state: otherwise pending shots advance cooldown/recoil a second time.
    this.state = full ? cloneWeaponState(full)
      : this.acknowledgedState ? cloneWeaponState(this.acknowledgedState) : null;
    this.buttons = this.acknowledgedButtons;
    while (this.commands.length && this.commands[0].command.seq <= self.inputSeq) {
      const { command, pose, sampledTick } = this.commands.shift()!;
      if (!full && this.state) {
        this.tick = sampledTick - 1;
        // A rejected predicted attack must not leave its cooldown in the compact
        // baseline. Save only when another attack could exceed the confirmed serial.
        const couldReject = this.state.attackSerial >= self.attackSerial &&
          (command.buttons & (BTN.fire | BTN.aim)) !== 0 && canAttack(this.state, sampledTick);
        const before = couldReject ? cloneWeaponState(this.state) : null;
        const previousButtons = this.buttons;
        this.advance(command, self.alive, frozen, pose, false);
        if (before && this.state.attackSerial > self.attackSerial) {
          this.state = before;
          this.buttons = previousButtons;
          this.tick = sampledTick - 1;
          this.advance(command, self.alive, true, pose, false);
        }
      }
      this.acknowledgedButtons = command.buttons;
    }
    this.tick = tick;
    this.buttons = this.acknowledgedButtons;
    // An acknowledged command that produced no authority attack must not reserve a future serial.
    const attackSerial = full?.attackSerial ?? self.attackSerial;
    for (const [serial, feedback] of this.presented) {
      if (serial > attackSerial && feedback.commandSeq <= self.inputSeq) this.presented.delete(serial);
    }
    if (!this.state) return;
    if (!full) {
      // 常规包只带简单状态：合并武器/弹药/换弹窗口，保留本地预测的 game/RNG，
      // 未确认的换弹/装备不要被服务器的 0 提前清掉。
      if (self.reloadUntil > 0) this.state.reloadUntil = self.reloadUntil;
      if (self.equipUntil > 0) this.state.equipUntil = self.equipUntil;
      const ammo = this.state.ammo[this.state.weapon];
      if (ammo) {
        ammo.mag = self.mag;
        ammo.reserve = self.reserve;
      }
      this.state.attackSerial = attackSerial;
      this.state.ackFire = self.ackFire;
    }
    this.acknowledgedState = cloneWeaponState(this.state);
    if (!self.alive) {
      this.commands.length = 0;
      this.buttons = this.acknowledgedButtons = 0;
      return;
    }
    for (const entry of this.commands) {
      const { command, pose, sampledTick } = entry;
      const replayPose = pose?.landT === undefined ? pose : {
        ...pose, landT: pose.landT + (this.tick + 1 - sampledTick) / TICK_RATE,
      };
      entry.sampledTick = this.tick + 1;
      entry.pose = replayPose;
      this.advance(command, self.alive, frozen, replayPose, false);
    }
  }

  /** The authoritative event still supplies tracers, surface impacts, hit marker and damage. */
  confirmed(serial: number, weapon: string): boolean {
    return this.presented.get(serial)?.weapon === weapon;
  }

  /** Match melee feedback by input command as prediction and authority serials can diverge. */
  meleeStarted(commandSeq: number): boolean {
    const predicted = this.presentedMeleeCommands.has(commandSeq);
    this.meleeStarts.add(commandSeq);
    if (this.meleeStarts.size > 128) this.meleeStarts.delete(this.meleeStarts.values().next().value!);
    return predicted;
  }

  private advance(command: UserCmd, alive: boolean, frozen: boolean, pose?: WeaponPose, present = true): void {
    if (!this.state) return;
    const buttons = command.buttons;
    const pressed = buttons & ~this.buttons;
    this.buttons = buttons;
    const { attack } = stepWeaponInput(this.state, {
      tick: ++this.tick,
      fire: (buttons & BTN.fire) !== 0,
      firePressed: (pressed & BTN.fire) !== 0,
      reloadPressed: (pressed & BTN.reload) !== 0,
      aim: (buttons & BTN.aim) !== 0,
      aimPressed: (pressed & BTN.aim) !== 0,
      alive, frozen, commandSeq: command.seq, pose,
    });
    if (!present || !attack || (attack.weapon === 'melee'
      ? this.meleeStarts.has(command.seq) || this.presentedMeleeCommands.has(command.seq)
      : this.presented.get(attack.attackSerial)?.weapon === attack.weapon)) return;
    if (!this.present(attack, this.tick)) return;
    if (attack.weapon === 'melee') {
      this.presentedMeleeCommands.add(command.seq);
      if (this.presentedMeleeCommands.size > 128) this.presentedMeleeCommands.delete(this.presentedMeleeCommands.values().next().value!);
    }
    this.presented.set(attack.attackSerial, { weapon: attack.weapon, commandSeq: command.seq });
    if (this.presented.size > 128) this.presented.delete(this.presented.keys().next().value!);
  }
}

/**
 * HUD 弹药 / 换弹 / 武器名使用本地预测状态：开火扣弹、按 R 换弹、选枪都在当帧显示，
 * 不再等 16 Hz 的 combat 包。伤害、命中、死亡仍然只认服务器。
 *
 * `predictedTick` 是预测时间线（服务器 tick + 未确认命令），与 `predicted.reloadUntil` 同一时基；
 * `fallbackTick` 是权威 combat 的时间估计。取较大值让换弹进度不会因为一次快照回退而倒退。
 */
export function predictedHud(
  self: CombatSelf,
  predicted: WeaponState | null,
  selectingWeapon: WeaponId | null,
  fallbackTick: number,
  predictedTick: number,
): { self: CombatSelf; tick: number } {
  if (!predicted || !self.alive) return { self, tick: fallbackTick };
  const weapon = selectingWeapon ?? predicted.weapon;
  const ammo = predicted.ammo[weapon] ?? predicted.ammo[predicted.weapon];
  return {
    self: {
      ...self,
      weapon,
      mag: ammo?.mag ?? self.mag,
      reserve: ammo?.reserve ?? self.reserve,
      // 换枪会取消换弹；本地选枪还没被服务器确认时不要显示旧枪的换弹条。
      reloadUntil: selectingWeapon ? 0 : predicted.reloadUntil,
    },
    tick: Math.max(fallbackTick, predictedTick),
  };
}
