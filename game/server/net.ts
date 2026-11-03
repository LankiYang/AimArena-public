// net.ts — 连接接入层：WebSocket 与 WebTransport 共用同一套大厅/对局逻辑。
// 文本消息 = 大厅 JSON，二进制消息 = 对局数据（输入 / 快照）。
import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { C2S, S2C } from '../shared/lobby.ts';
import { PROTOCOL_VERSION, CLIENT_VERSION } from '../shared/lobby.ts';
import { MAP_ROPE_REVISION } from '../shared/rope.ts';
import { AGENTS, isAgentId } from '../shared/catalog.ts';
import { Lobby, isSessionToken, type Client } from './lobby.ts';
import { createMatch } from './match.ts';
import { createRoomMatch, roomWorkersEnabled } from './room-execution.ts';
import { APP_BASE_PATH } from './paths.ts';

// ROOM_GRACE_MS：掉线后座位保留的毫秒数（默认 30 秒；测试里可以设短）
export const lobby = new Lobby(roomWorkersEnabled() ? createRoomMatch : createMatch, { graceMs: Number(process.env.ROOM_GRACE_MS) || undefined });

/** 一条已建立的传输连接；WebSocket 与 WebTransport 适配到同一形状。 */
export interface GameIo {
  ip: string;
  ua: string;
  /** 日志用 */
  transport: 'ws' | 'wt';
  send(msg: S2C): void;
  /** 服务端 -> 客户端二进制。WebTransport 适配器按大小选择数据报或可靠流。 */
  sendBinary(buf: Uint8Array): void;
  close(code?: number): void;
}

/** 传输层收到数据后调用；握手/大厅语义都在这里，和具体传输无关。 */
export interface GameSession {
  receiveText(raw: string): void;
  receiveBinary(buf: Uint8Array): void;
  /** 连接断开（幂等）：进入座位保留流程。 */
  disconnected(code?: number): void;
}

/**
 * 把一条连接接进大厅。WebSocket 与 WebTransport 都走这里，避免两套 hello / 会话恢复逻辑。
 */
export function attachGameClient(io: GameIo): GameSession {
  let client: Client | null = null;
  let closed = false;
  const t0 = Date.now();

  const send = (msg: S2C) => {
    if (!closed) io.send(msg);
  };

  const session: GameSession = {
    receiveText(raw: string) {
      if (closed) return;
      let msg: C2S;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (client && msg.t === 'latencyPing') {
        if (typeof msg.token === 'number' && Number.isSafeInteger(msg.token) && msg.token >= 0)
          send({ t: 'latencyPong', token: msg.token });
        return;
      }
      if (!client) {
        if (msg.t !== 'hello') return;
        const build = String(msg.build ?? '');
        if (build && build !== CLIENT_VERSION) console.warn(`[net] build mismatch client=${build} server=${CLIENT_VERSION}`);
        client = {
          id: lobby.newClientId(),
          name: String(msg.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || '玩家',
          agent: isAgentId(msg.agent) ? msg.agent : AGENTS[0].id,
          build: String(msg.build ?? ''),
          mapRopeRevision: msg.mapRopeRevision === MAP_ROPE_REVISION ? MAP_ROPE_REVISION : 0,
          roomId: null,
          session: isSessionToken(msg.session) ? msg.session : null,
          parked: false,
          send,
          sendBinary: (buf) => {
            if (!closed) io.sendBinary(buf);
          },
          onBinary: null,
          close: (code) => io.close(code),
        };
        // 同一会话还在宽限期内：接回原座位（id / 房间 / 对局），然后把房间（和对局）推过去
        const resumed = lobby.connect(client);
        send({ t: 'welcome', id: client.id, name: client.name, version: PROTOCOL_VERSION, build: CLIENT_VERSION, latencyProbe: true, mapRopeRevision: MAP_ROPE_REVISION });
        if (resumed) lobby.resumeSeat(client);
        else {
          send({ t: 'rooms', rooms: lobby.publicRooms() });
          send({ t: 'room', room: null });
        }
        return;
      }
      try {
        lobby.handle(client, msg);
      } catch (e) {
        console.error('[lobby]', msg.t, e);
      }
    },
    receiveBinary(buf: Uint8Array) {
      if (!closed) client?.onBinary?.(buf);
    },
    disconnected(code?: number) {
      if (closed) return;
      closed = true;
      console.log(`[net] close transport=${io.transport} id=${client?.id ?? '-'} code=${code ?? '-'} ms=${Date.now() - t0}`);
      if (client) lobby.disconnect(client);
      client = null;
    },
  };
  return session;
}

/** 已写进 TCP socket 的字节数（带宽观测用）。ws 库把底层 net.Socket 挂在未公开的 _socket 上，
 *  所以这里按 unknown 收窄，读不到就返回 undefined，绝不假设形状。 */
function socketBytesWritten(ws: WebSocket): number | undefined {
  const raw: unknown = ws;
  if (!raw || typeof raw !== 'object' || !('_socket' in raw)) return undefined;
  const sock: unknown = raw._socket;
  if (!sock || typeof sock !== 'object' || !('bytesWritten' in sock)) return undefined;
  const bytes: unknown = sock.bytesWritten;
  return typeof bytes === 'number' ? bytes : undefined;
}

// 每连接最多积压 8 MiB（含待发送帧的最大 10 字节服务端帧头）。
// 地图资源通过 HTTP 加载，不经过此队列；这里留足大厅消息和加载期间的突发空间。
// 超限时直接断开，而非排队 close 帧或丢弃战斗消息，让既有断线/座位宽限流程接管。
const WS_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const WS_MAX_FRAME_HEADER_BYTES = 10;

function allowWsSend(ws: WebSocket, frameBytes: number): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  if (ws.bufferedAmount + frameBytes > WS_MAX_BUFFERED_BYTES) {
    ws.terminate();
    return false;
  }
  return true;
}

export function attachGameServer(server: http.Server) {
  const wss = new WebSocketServer({
    server,
    path: `${APP_BASE_PATH}/ws`,
    maxPayload: 64 * 1024,
    // 实时小包默认不协商压缩：50 人负载下 zlib 队列会放大输入确认延迟。
    // WS_DEFLATE=1 可显式开启 JSON 压缩以换取较低带宽；启用前须复测并发长尾。
    // 快照始终显式不压缩；HTTP 素材 gzip 与缓存不受这里影响。
    perMessageDeflate: process.env.WS_DEFLATE !== '1'
      ? false
      : {
          threshold: 1024,
          zlibDeflateOptions: { level: 5, memLevel: 7, windowBits: 13 },
          clientNoContextTakeover: false,
          serverNoContextTakeover: false,
        },
  });

  wss.on('connection', (ws: WebSocket & { missed?: number }, req?: http.IncomingMessage) => {
    ws.missed = 0;
    const ip = String(req?.headers['cf-connecting-ip'] ?? req?.headers['x-real-ip'] ?? req?.socket?.remoteAddress ?? '-');
    const ua = String(req?.headers['user-agent'] ?? '').slice(0, 90);
    console.log(`[ws] open ip=${ip} ua=${ua}`);
    const session = attachGameClient({
      ip,
      ua,
      transport: 'ws',
      send: (msg) => {
        // 已经积压过多时先检查，避免为无望发送的消息执行 JSON 编码。
        if (!allowWsSend(ws, WS_MAX_FRAME_HEADER_BYTES)) return;
        const json = JSON.stringify(msg);
        if (allowWsSend(ws, Buffer.byteLength(json) + WS_MAX_FRAME_HEADER_BYTES)) ws.send(json);
      },
      sendBinary: (buf) => {
        if (allowWsSend(ws, buf.byteLength + WS_MAX_FRAME_HEADER_BYTES)) ws.send(buf, { binary: true, compress: false });
      },
      close: (code) => ws.close(code),
    });
    // 带宽观测（NET_METER=1 才开）：真实写进 socket 的字节（含 ws 压缩后），每 5 秒一条，排查跨境带宽/拥塞用。
    let meterB = socketBytesWritten(ws) ?? 0;
    let meterT = Date.now();
    const meter = !process.env.NET_METER ? undefined : setInterval(() => {
      const b = socketBytesWritten(ws) ?? 0;
      const now = Date.now();
      const secs = Math.max(0.001, (now - meterT) / 1000);
      console.log(`[net] ws ip=${ip} wire=${((b - meterB) / secs / 1024).toFixed(1)}KB/s buffered=${ws.bufferedAmount}B`);
      meterB = b;
      meterT = now;
    }, 5000);
    ws.on('pong', () => (ws.missed = 0));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = data instanceof Buffer ? data : Buffer.concat(data as Buffer[]);
        session.receiveBinary(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        return;
      }
      session.receiveText(String(data));
    });
    ws.on('close', (code: number) => {
      clearInterval(meter);
      console.log(`[ws] close ip=${ip} code=${code}`);
      session.disconnected(code);
    });
  });

  // 心跳容错：连续漏 2 次 pong 才断开（冷启动/烘焙期间事件循环被占住时，偶尔会漏一次）
  const iv = setInterval(() => {
    for (const ws of wss.clients as Set<WebSocket & { missed?: number }>) {
      // ping 也会进入发送队列；非 OPEN 连接不再发送心跳。
      if (!allowWsSend(ws, 2)) continue;
      if ((ws.missed ?? 0) >= 2) {
        ws.terminate();
        continue;
      }
      ws.missed = (ws.missed ?? 0) + 1;
      ws.ping();
    }
  }, 15000);
  iv.unref();
}
