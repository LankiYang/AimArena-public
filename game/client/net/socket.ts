// socket.ts — 到服务器的连接：WebSocket 或 WebTransport，多线路回退、自动重连、JSON 大厅消息、二进制对局消息
//
// 服务器提供 WT 时，可由 ?wt=1 或静态包的 wt-default 启用；否则使用 WebSocket：
//   · 一条双向可靠流承载大厅 JSON 与输入（帧格式见 shared/wtframes.ts）；
//   · 快照走 QUIC 数据报，丢一帧由下一 tick 覆盖，不阻塞后续输入。
// 连接、状态、重连与线路选择逻辑两种传输共用。
import type { C2S, S2C } from '../../shared/lobby.ts';
import { MAP_ROPE_REVISION } from '../../shared/rope.ts';
import { encodeWtFrame, WtFrameReader, WT_BIN, WT_TEXT } from '../../shared/wtframes.ts';
import { wsEndpoints, wtUrl } from '../paths.ts';

type Listener = (msg: S2C) => void;

const CONNECT_TIMEOUT_MS = 5000;
/** Toy 无法带查询参数；UDP 被封/握手失败时 3 s 内回退，兼顾移动网络握手与开屏等待。 */
const WT_CONNECT_TIMEOUT_MS = 3000;
const MAX_BACKOFF_MS = 5000;
const ENDPOINT_KEY = 'aimarena.ws.endpoint';


export class Connection {
  private ws: WebSocket | null = null;
  private wt: WebTransport | null = null;
  private wtWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private wtQueued = 0;
  private useWt: boolean;
  private listeners = new Set<Listener>();
  private binaryHandler: { generation: number; fn: (buf: ArrayBuffer) => void } | null = null;
  private socketGeneration = 0;
  private retry = 0;
  private timer: number | undefined;
  private connectTimer: number | undefined;
  private hello: () => C2S;
  private endpoints: string[];
  private endpointIndex = 0;
  private attemptsOnEndpoint = 0;
  /** replaced：同一会话被另一个标签页接管了，这里不再自动重连 */
  status: 'connecting' | 'open' | 'closed' | 'replaced' = 'connecting';
  onStatus: ((s: Connection['status']) => void) | null = null;
  /** 设置面板按需测量的应用层往返时间；旧服务器无响应时不可用。 */
  rtt: number | null = null;
  private latencyToken: number | null = null;
  private latencySentAt = 0;
  private latencyLastAt = 0;
  private latencyCounter = 0;
  private latencySupported = false;
  /** Reset on each socket generation; old servers do not advertise map ropes. */
  mapRopeRevision = 0;
  /** 当前尝试的线路（完整 ws/wss 或 https 地址） */
  endpoint = '';
  /** 最近一次失败原因，设置面板与日志用 */
  lastError = '';

  /** 是否处于「已断、正在自动重连」阶段：UI 用它区分「首次连接中」和「掉线重连中」 */
  get retrying() {
    return this.status !== 'open' && this.status !== 'replaced' && this.retry > 0;
  }

  /** 每次新建连接都换代；对局输入和回包只能使用创建运行时的那一代连接。 */
  get generation() {
    return this.socketGeneration;
  }

  get endpointCount() {
    return this.endpoints.length;
  }

  get line() {
    return `${Math.min(this.endpointIndex + 1, this.endpoints.length)}/${this.endpoints.length}`;
  }

  get endpointLabel() {
    if (!this.endpoint) return '';
    try {
      const u = new URL(this.endpoint);
      return `${u.host}${u.pathname}`;
    } catch {
      return this.endpoint;
    }
  }

  get endpointList() {
    return [...this.endpoints];
  }

  /** 当前传输，设置面板/诊断显示用 */
  get transport(): 'websocket' | 'webtransport' {
    return this.useWt ? 'webtransport' : 'websocket';
  }

  constructor(hello: () => C2S) {
    this.hello = hello;
    // 只使用当前服务器的 WT；未配置或浏览器不支持时使用当前服务器的 WS。
    const query = new URL(location.href).searchParams.get('wt');
    const wtMeta = document.querySelector<HTMLMetaElement>('meta[name="wt-url"]')?.content?.trim() ?? '';
    const wtDefault = document.querySelector<HTMLMetaElement>('meta[name="wt-default"]')?.content === '1';
    // ?wt=1 强制开，?wt=0 强制关；没有查询参数时看静态包里的 meta（Toy 主战场）。
    const wantsWt = query === '0' ? false : query === '1' || (query === null && wtDefault && !!wtMeta);
    const targetWt = wantsWt ? wtUrl() : null;
    this.useWt = !!targetWt && typeof WebTransport !== 'undefined';
    if (wantsWt && !this.useWt)
      console.warn(targetWt ? '[wt] 浏览器不支持 WebTransport，退回 WebSocket' : '[wt] 当前服务器未配置 WebTransport，使用 WebSocket');
    this.endpoints = this.useWt ? [targetWt!] : wsEndpoints();
    // 上次成功的线路优先，避免每次刷新都先撞一遍被 VPN 卡住的那条
    try {
      const saved = sessionStorage.getItem(ENDPOINT_KEY);
      if (saved) {
        const at = this.endpoints.indexOf(saved);
        if (at > 0) {
          this.endpoints.splice(at, 1);
          this.endpoints.unshift(saved);
        }
      }
    } catch {}
    this.open();
    // 移动端切后台会被系统冻结（甚至直接关掉 socket），回到前台/网络恢复时立刻重连，
    // 否则要等退避计时器（最长 5 秒）才动作，玩家看到的就是「已断开」卡着不动。
    const kick = () => {
      if (this.status !== 'closed') return;
      this.retry = 0;
      this.attemptsOnEndpoint = 0;
      this.clearTimers();
      this.dropSocket();
      this.open();
    };
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    });
  }

  /** 手动切到下一线路（设置面板用） */
  cycleEndpoint() {
    if (this.endpoints.length < 2) return;
    this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    this.attemptsOnEndpoint = 0;
    this.retry = 0;
    this.lastError = '';
    this.clearTimers();
    this.dropSocket();
    this.open();
  }

  private open() {
    this.clearTimers();
    const url = this.endpoints[this.endpointIndex % this.endpoints.length];
    if (!url) {
      this.lastError = '没有可用线路';
      this.setStatus('closed');
      return;
    }
    this.endpoint = url;
    if (this.useWt) this.openWt(url);
    else this.openWs(url);
  }

  private openWs(url: string) {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.handleFailure(false, 0);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.socketGeneration++;
    this.mapRopeRevision = 0;
    this.binaryHandler = null;
    let opened = false;
    this.setStatus('connecting');
    console.info('[ws] try', url);
    this.connectTimer = window.setTimeout(() => {
      if (this.ws !== ws || opened) return;
      this.lastError = '连接超时';
      this.dropSocket(ws);
      this.handleFailure(false, 0);
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.clearConnectTimer();
      this.retry = 0;
      this.attemptsOnEndpoint = 0;
      this.lastError = '';
      this.rememberEndpoint(url);
      this.setStatus('open');
      console.info('[ws] open', url);
      ws.send(JSON.stringify(this.hello()));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') this.handleText(ev.data);
      else if (this.binaryHandler?.generation === this.socketGeneration)
        this.binaryHandler.fn(ev.data as ArrayBuffer);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      // 4000：同一会话被另一个标签页接管了。这里停下、不自动重连（否则两个标签页会互相顶掉）
      if (ev.code === 4000) {
        this.setStatus('replaced');
        return;
      }
      this.handleFailure(opened, ev.code);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.lastError = '连接错误';
    };
  }

  private async openWt(url: string) {
    const gen = ++this.socketGeneration;
    this.mapRopeRevision = 0;
    this.binaryHandler = null;
    let opened = false;
    let attemptedWt: WebTransport | null = null;
    this.setStatus('connecting');
    console.info('[wt] try', url);
    this.connectTimer = window.setTimeout(() => {
      if (gen !== this.socketGeneration || opened) return;
      this.lastError = '连接超时';
      this.dropSocket();
      this.handleFailure(false, 0);
    }, WT_CONNECT_TIMEOUT_MS);
    try {
      const wt = new WebTransport(url);
      attemptedWt = wt;
      // ready 失败时 closed 也可能拒绝；先消费该 rejection，正常断线仍由下方处理。
      void wt.closed.catch(() => {});
      this.wt = wt;
      await wt.ready;
      if (this.wt !== wt || gen !== this.socketGeneration) return;
      const bidi = await wt.createBidirectionalStream();
      if (this.wt !== wt || gen !== this.socketGeneration) return;
      const writer = bidi.writable.getWriter();
      this.wtWriter = writer;
      this.wtQueued = 0;
      opened = true;
      this.clearConnectTimer();
      this.retry = 0;
      this.attemptsOnEndpoint = 0;
      this.lastError = '';
      this.rememberEndpoint(url);
      this.setStatus('open');
      console.info('[wt] open', url);
      this.sendFrame(WT_TEXT, new TextEncoder().encode(JSON.stringify(this.hello())));
      void this.readWtStream(gen, bidi.readable);
      void this.readWtDatagrams(gen, wt);
      void wt.closed.then((info) => {
        if (this.wt !== wt || gen !== this.socketGeneration) return;
        this.wtWriter = null;
        if (info.closeCode === 4000) {
          this.setStatus('replaced');
          return;
        }
        this.handleFailure(opened, info.closeCode ?? 0);
      }, (e) => {
        if (this.wt !== wt || gen !== this.socketGeneration) return;
        this.lastError = e instanceof Error ? e.message : String(e);
        this.dropSocket();
        this.handleFailure(opened, 0);
      });
    } catch (e) {
      if (gen !== this.socketGeneration || (attemptedWt && this.wt !== attemptedWt)) return;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.dropSocket();
      this.handleFailure(false, 0);
    }
  }

  private async readWtStream(gen: number, readable: ReadableStream<Uint8Array>) {
    const reader = readable.getReader();
    const frames = new WtFrameReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== this.socketGeneration) return;
        for (const f of frames.push(value)) {
          if (f.kind === WT_TEXT) this.handleText(decoder.decode(f.payload));
          else if (f.kind === WT_BIN && this.binaryHandler?.generation === gen)
            this.binaryHandler.fn(f.payload.buffer.slice(f.payload.byteOffset, f.payload.byteOffset + f.payload.byteLength) as ArrayBuffer);
        }
      }
    } catch {
      // 读取中断由 wt.closed / 重连路径处理
    }
  }

  private async readWtDatagrams(gen: number, wt: WebTransport) {
    const reader = wt.datagrams.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== this.socketGeneration || this.wt !== wt) return;
        if (this.binaryHandler?.generation === gen)
          this.binaryHandler.fn(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
      }
    } catch {
      // 同上
    }
  }

  private handleText(raw: string) {
    let msg: S2C;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'welcome') {
      this.latencySupported = msg.latencyProbe === true;
      this.mapRopeRevision = msg.mapRopeRevision === MAP_ROPE_REVISION ? MAP_ROPE_REVISION : 0;
    }
    if (msg.t === 'latencyPong') {
      if (msg.token === this.latencyToken) {
        this.rtt = Math.round(performance.now() - this.latencySentAt);
        this.latencyLastAt = performance.now();
        this.latencyToken = null;
      }
      return;
    }
    for (const l of this.listeners) l(msg);
  }

  private rememberEndpoint(url: string) {
    try {
      sessionStorage.setItem(ENDPOINT_KEY, url);
    } catch {}
  }

  private sendFrame(kind: number, payload: Uint8Array) {
    const writer = this.wtWriter;
    if (!writer) return;
    this.wtQueued += payload.byteLength;
    writer.write(encodeWtFrame(kind, payload)).then(
      () => (this.wtQueued = Math.max(0, this.wtQueued - payload.byteLength)),
      () => (this.wtQueued = Math.max(0, this.wtQueued - payload.byteLength)),
    );
  }

  private handleFailure(opened: boolean, code: number) {
    this.retry += 1;
    this.attemptsOnEndpoint += 1;
    if (!this.lastError) this.lastError = code ? `连接失败 (${code})` : '连接失败';
    // 本次 WT 握手失败时降级；曾成功的连接断开后先重试 WT，重试失败也必须回退。
    if (this.useWt && !opened) {
      console.warn('[wt] 会话建立失败，回退 WebSocket');
      this.useWt = false;
      this.endpoints = wsEndpoints();
      this.endpointIndex = 0;
      this.attemptsOnEndpoint = 0;
      this.retry = 0;
    }
    // 没打开过：立刻换线路；打开过：同线路连续失败两次再换，避免网络抖动时来回跳
    if (this.endpoints.length > 1 && this.attemptsOnEndpoint >= (opened ? 2 : 1)) {
      this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
      this.attemptsOnEndpoint = 0;
    }
    const delay = opened ? Math.min(MAX_BACKOFF_MS, 300 * 2 ** Math.min(this.retry - 1, 4)) : 300;
    console.warn('[net] fail', this.endpoint, code, this.lastError);
    this.setStatus('closed');
    this.schedule(delay);
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.open();
    }, delay);
  }

  private clearConnectTimer() {
    clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private clearTimers() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.clearConnectTimer();
  }

  private dropSocket(ws: WebSocket | null = this.ws) {
    if (ws) {
      if (this.ws === ws) this.ws = null;
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      } catch {}
    }
    const wt = this.wt;
    if (wt) {
      this.wt = null;
      this.wtWriter = null;
      this.wtQueued = 0;
      try {
        wt.close();
      } catch {}
    }
  }

  private setStatus(s: Connection['status']) {
    if (s !== 'open') { this.rtt = null; this.latencyToken = null; this.latencyLastAt = 0; this.latencySupported = false; }
    this.status = s;
    this.onStatus?.(s);
  }

  /** 开面板时低频探测；旧服务器、断连及超时不显示陈旧值。 */
  probeLatency() {
    const now = performance.now();
    if (this.status !== 'open') { this.rtt = null; this.latencyToken = null; return; }
    if (!this.latencySupported) return;
    if (this.latencyLastAt && now - this.latencyLastAt > 6000) this.rtt = null;
    if (this.latencyToken !== null && now - this.latencySentAt < 4000) return;
    this.latencyToken = ++this.latencyCounter;
    this.latencySentAt = now;
    this.send({ t: 'latencyPing', token: this.latencyToken });
  }

  send(msg: C2S) {
    if (this.useWt) {
      this.sendFrame(WT_TEXT, new TextEncoder().encode(JSON.stringify(msg)));
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendBinary(buf: ArrayBufferView | ArrayBuffer, generation: number) {
    // 重连握手期间旧对局的 RAF 仍可能运行，不能把上一代的高 seq 输入送进新连接。
    if (generation !== this.socketGeneration) return;
    if (this.useWt) {
      const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      this.sendFrame(WT_BIN, bytes);
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  /** 发送缓冲区里积压的字节数（网络卡时用来丢弃过期输入） */
  get buffered() {
    return this.useWt ? this.wtQueued : this.ws?.bufferedAmount ?? 0;
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onBinary(fn: (buf: ArrayBuffer) => void, generation: number) {
    if (generation !== this.socketGeneration) return () => {};
    const handler = { generation, fn };
    this.binaryHandler = handler;
    // 旧运行时晚到的清理不得摘掉新运行时的回包处理器。
    return () => {
      if (this.binaryHandler === handler) this.binaryHandler = null;
    };
  }
}
