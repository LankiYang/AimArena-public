// wtframes.ts — WebTransport 可靠流上的帧格式（客户端与服务端共用）
//
//   [u8 kind][u32 LE length][payload]
//
// kind 0 = 大厅 JSON（UTF-8），kind 1 = 二进制对局数据（输入/回退快照）。
// 数据报不套这层：载荷本身就是协议帧（第一个字节是 MSG_*），丢了由下一 tick 覆盖。

export const WT_TEXT = 0;
export const WT_BIN = 1;

/** 单帧上限，防止坏数据把缓冲撑爆（最大输入包 514B，快照回退 ~1KB，JSON 几百 B）。 */
export const WT_MAX_FRAME = 64 * 1024;

export function encodeWtFrame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, kind);
  dv.setUint32(1, payload.byteLength, true);
  out.set(payload, 5);
  return out;
}

export interface WtFrame {
  kind: number;
  payload: Uint8Array;
}

/** 增量解析字节流；跨 chunk 的半帧留在内部缓冲里。 */
export class WtFrameReader {
  private buf = new Uint8Array(0);
  /** 遇到坏长度后流已无法重新对齐：永久停用，等连接重建。 */
  private broken = false;

  push(chunk: Uint8Array): WtFrame[] {
    if (this.broken) return [];
    if (chunk.byteLength) {
      const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
      next.set(this.buf);
      next.set(chunk, this.buf.byteLength);
      this.buf = next;
    }
    const frames: WtFrame[] = [];
    for (;;) {
      if (this.buf.byteLength < 5) break;
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = dv.getUint32(1, true);
      if (len > WT_MAX_FRAME) {
        // 坏帧无法重新同步；停用解析，由传输层重连。
        this.broken = true;
        this.buf = new Uint8Array(0);
        return [];
      }
      if (this.buf.byteLength < 5 + len) break;
      frames.push({ kind: dv.getUint8(0), payload: this.buf.slice(5, 5 + len) });
      this.buf = this.buf.slice(5 + len);
    }
    return frames;
  }
}
