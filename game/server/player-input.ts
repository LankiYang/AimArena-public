// One command represents one 1/32 s movement step, even when packets arrive in batches.
import { BTN, type UserCmd } from '../shared/protocol.ts';

export const PLAYER_INPUT_LIMITS = Object.freeze({ queue: 16, perTick: 2, credit: 8 });
const PRESS_BUTTONS = BTN.fire | BTN.reload | BTN.aim | BTN.jump;

export interface PlayerInputFrame {
  command: UserCmd;
  pressed: number;
  fire?: number;
  aim?: number;
}

/** Per-player FIFO and server-time budget. Packet count and sequence gaps cannot buy time. */
export class PlayerInputBuffer {
  private queue: PlayerInputFrame[] = [];
  private accepted = 0;
  private buttons = 0;
  private credit = 0;
  private remaining = 0;

  get size(): number { return this.queue.length; }

  push(command: UserCmd): boolean {
    if (command.seq <= this.accepted) return false;
    const pressed = command.buttons & ~this.buttons & PRESS_BUTTONS;
    this.accepted = command.seq;
    this.buttons = command.buttons;
    this.queue.push({ command, pressed,
      fire: pressed & BTN.fire ? command.seq : undefined,
      aim: pressed & BTN.aim ? command.seq : undefined });
    if (this.queue.length > PLAYER_INPUT_LIMITS.queue) {
      // Emergency overflow: skip the oldest movement, carry its short presses only to
      // the first surviving command. Later queued actions must not execute early.
      const dropped = this.queue.shift()!;
      const next = this.queue[0];
      if (!(next.pressed & BTN.fire)) next.fire = dropped.fire;
      if (!(next.pressed & BTN.aim)) next.aim = dropped.aim;
      next.pressed |= dropped.pressed;
    }
    return true;
  }

  beginTick(): void {
    this.credit = Math.min(PLAYER_INPUT_LIMITS.credit, this.credit + 1);
    this.remaining = PLAYER_INPUT_LIMITS.perTick;
  }

  take(): PlayerInputFrame | undefined {
    if (!this.queue.length || this.credit < 1 || this.remaining < 1) return undefined;
    this.credit--;
    this.remaining--;
    const frame = this.queue.shift()!;
    if ((frame.pressed & BTN.jump) && !(frame.command.buttons & BTN.jump)) {
      frame.command = { ...frame.command, buttons: frame.command.buttons | BTN.jump };
    }
    return frame;
  }

  /** Death/respawn discards actions and stored time, but still rejects old sequences. */
  clear(): UserCmd | undefined {
    const latest = this.queue.at(-1)?.command;
    this.queue.length = 0;
    this.buttons = this.credit = this.remaining = 0;
    return latest;
  }

  /** Only a new connection generation restarts the client's sequence space. */
  reconnect(): void {
    this.clear();
    this.accepted = 0;
  }
}
