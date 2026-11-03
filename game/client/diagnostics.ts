// Only the active match writes these values; unavailable in the lobby or after disposal.
export const diagnostics: {
  fps: number | null;
  snapshotHz: number | null;
  snapshotGapMs: number | null;
  inputAckMs: number | null;
  sendBufferedBytes: number | null;
  sampledAt: number;
} = {
  fps: null, snapshotHz: null, snapshotGapMs: null, inputAckMs: null,
  sendBufferedBytes: null, sampledAt: 0,
};

/** Per-runtime bounded sent-command timestamps; sequence values guard ring reuse. */
export class MatchNetworkMetrics {
  private readonly seqs = new Float64Array(512);
  private readonly sentAt = new Float64Array(512);
  private lastSnapshot = 0;
  private lastAckAt = 0;
  private lastAck = 0;
  private ackMs: number | null = null;
  private maxGap: number | null = null;
  private logMaxGap: number | null = null;
  private lastLogAt = performance.now();

  sent(seq: number, now: number) {
    const slot = seq % this.seqs.length;
    this.seqs[slot] = seq;
    this.sentAt[slot] = now;
  }

  snapshot(ack: number, now: number) {
    if (this.lastSnapshot) {
      const gap = now - this.lastSnapshot;
      this.maxGap = Math.max(this.maxGap ?? 0, gap);
      this.logMaxGap = Math.max(this.logMaxGap ?? 0, gap);
    }
    this.lastSnapshot = now;
    if (ack > this.lastAck) {
      const slot = ack % this.seqs.length;
      if (this.seqs[slot] === ack) {
        this.ackMs = now - this.sentAt[slot];
        this.lastAckAt = now;
      } else {
        this.ackMs = null;
      }
      this.lastAck = ack;
    }
  }

  publish(now: number, buffered: number) {
    diagnostics.snapshotGapMs = this.lastSnapshot && now - this.lastSnapshot <= 3000 ? this.maxGap : null;
    diagnostics.inputAckMs = this.lastAckAt && now - this.lastAckAt <= 3000 ? this.ackMs : null;
    diagnostics.sendBufferedBytes = buffered;
    diagnostics.sampledAt = now;
    this.maxGap = null;
    // Piggyback on the existing once-per-second render sample: no extra timer or traffic.
    if (now - this.lastLogAt >= 10_000) {
      const ongoingGap = this.lastSnapshot ? now - this.lastSnapshot : null;
      const snapshotGapMs = ongoingGap === null
        ? this.logMaxGap
        : Math.max(this.logMaxGap ?? 0, ongoingGap);
      console.info('[match-diagnostics]', JSON.stringify({
        sampledAt: Date.now(),
        intervalMs: now - this.lastLogAt,
        fps: diagnostics.fps,
        snapshotHz: diagnostics.snapshotHz,
        snapshotGapMs,
        inputAckMs: diagnostics.inputAckMs,
        sendBufferedBytes: buffered,
      }));
      this.lastLogAt = now;
      this.logMaxGap = null;
    }
  }
}

export function clearDiagnostics() {
  diagnostics.fps = diagnostics.snapshotHz = diagnostics.snapshotGapMs = diagnostics.inputAckMs = diagnostics.sendBufferedBytes = null;
  diagnostics.sampledAt = 0;
}
