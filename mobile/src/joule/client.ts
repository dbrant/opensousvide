// Speaks the Joule stream protocol over a Transport.
//
// Every exchange is a "stream": the opener picks a handle, and both sides tag
// their messages with it until one sends a message with `end` set.

import { FeedType, Result, type CirculatorDataPoint, type DescribeFeedReply, type StreamMessage } from '../proto/base_pb';
import {
  ACTIVE_STEPS,
  HandlePool,
  bytesToHex,
  decodeStreamMessage,
  encodeStreamMessage,
  hexToBytes,
  manualProgram,
  resultName,
  type Contents,
  type ContentsInit,
} from './protocol';

export interface Transport {
  open(onMessage: (data: Uint8Array) => void, onClose: () => void): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class JouleError extends Error {}

export class JouleTimeout extends JouleError {}

export class JouleResultError extends JouleError {
  constructor(
    readonly request: string,
    readonly result: number,
  ) {
    super(`${request} failed: ${resultName(result)}`);
  }
}

class StreamCancelled extends Error {}

type ReplyOf<K extends Contents> = Extract<StreamMessage['contents'], { case: K }>['value'];

const DEFAULT_TIMEOUT_MS = 5_000;
// Key exchange waits for the user to press the button on the Joule.
export const KEY_EXCHANGE_TIMEOUT_MS = 35_000;
const LIVE_FEED_TIMEOUT_MS = 30_000;

class Stream {
  remoteEnded = false;
  private queue: (StreamMessage | null | StreamCancelled)[] = [];
  private waiter: ((item: StreamMessage | null | StreamCancelled) => void) | null = null;

  constructor(readonly handle: number) {}

  /** `null` means the connection closed. */
  push(item: StreamMessage | null | StreamCancelled): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
    } else {
      this.queue.push(item);
    }
  }

  private next(timeoutMs: number): Promise<StreamMessage | null | StreamCancelled> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new JouleTimeout('Timed out waiting for the Joule to respond'));
      }, timeoutMs);
      this.waiter = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
    });
  }

  /** Return the next message with content, skipping keep-alives. */
  async receive(timeoutMs: number): Promise<StreamMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const item = await this.next(Math.max(0, deadline - Date.now()));
      if (item instanceof StreamCancelled) throw item;
      if (item === null) throw new JouleError('Connection to the Joule was lost');
      if (item.end) this.remoteEnded = true;
      const kind = item.contents.case;
      if (kind && kind !== 'keepAlive') return item;
      if (item.end) throw new JouleError('The Joule ended the request without replying');
    }
  }
}

export interface LiveFeed {
  /** Ends the feed; resolves once it has stopped. */
  stop(): Promise<void>;
  /** Resolves when the feed ends normally, rejects if it fails. */
  done: Promise<void>;
}

export interface ClientOptions {
  keepAliveMs?: number;
  random?: () => number;
}

export function isCooking(point: CirculatorDataPoint): boolean {
  return ACTIVE_STEPS.has(point.programStep);
}

export class JouleClient {
  private readonly remote: Uint8Array;
  private readonly me: Uint8Array;
  private readonly handles: HandlePool;
  private readonly keepAliveMs: number;
  private streams = new Map<number, Stream>();
  private connected = false;
  private closeListeners = new Set<() => void>();

  constructor(
    private readonly transport: Transport,
    circulatorAddress: string,
    appAddress: string,
    options: ClientOptions = {},
  ) {
    this.remote = hexToBytes(circulatorAddress);
    this.me = hexToBytes(appAddress);
    this.handles = new HandlePool(appAddress, circulatorAddress, options.random);
    this.keepAliveMs = options.keepAliveMs ?? 5_000;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Called when the connection drops (not when `close()` is called). */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async open(): Promise<void> {
    await this.transport.open(
      (data) => this.onBytes(data),
      () => this.onTransportClosed(),
    );
    this.connected = true;
  }

  async close(): Promise<void> {
    for (const stream of this.streams.values()) stream.push(new StreamCancelled());
    this.connected = false;
    await this.transport.close();
  }

  // --- Commands ---

  /** Start a key exchange; resolves with the secret key (hex) once the user
   * presses the button on the Joule. */
  async pair(timeoutMs = KEY_EXCHANGE_TIMEOUT_MS): Promise<string> {
    const reply = await this.request(
      { case: 'startKeyExchangeRequest', value: {} },
      'startKeyExchangeReply',
      timeoutMs,
    );
    return bytesToHex(reply.secretKey);
  }

  async authenticate(secretKey: string): Promise<void> {
    await this.request(
      { case: 'submitKeyRequest', value: { secretKey: hexToBytes(secretKey) } },
      'submitKeyReply',
    );
  }

  identify() {
    return this.request({ case: 'identifyCirculatorRequest', value: {} }, 'identifyCirculatorReply');
  }

  async stop(): Promise<void> {
    await this.request({ case: 'stopCirculatorRequest', value: {} }, 'stopCirculatorReply');
  }

  /**
   * Heat to `setpointC` and hold until stopped. Programs can't be modified
   * once running, so any current program is stopped first, as the official
   * app does.
   */
  async setTemperature(setpointC: number): Promise<void> {
    const program = manualProgram(setpointC);
    try {
      await this.stop();
    } catch (e) {
      if (!(e instanceof JouleResultError)) throw e;
    }
    await this.request(
      { case: 'startProgramRequest', value: { circulatorProgram: program } },
      'startProgramReply',
    );
  }

  describeFeed(feedId: number): Promise<DescribeFeedReply> {
    return this.request({ case: 'describeFeedRequest', value: { feedId } }, 'describeFeedReply', 10_000);
  }

  /** Stream live data points to `onPoint` until stopped. */
  liveFeed(onPoint: (point: CirculatorDataPoint) => void, timeoutMs = LIVE_FEED_TIMEOUT_MS): LiveFeed {
    let current: Stream | null = null;
    let cancelled = false;
    const contents: ContentsInit = { case: 'beginLiveFeed', value: { feedType: FeedType.COOK_DATA } };
    const done = this.withStream(contents, async (stream) => {
      current = stream;
      if (cancelled) return;
      try {
        while (!stream.remoteEnded) {
          const msg = await stream.receive(timeoutMs);
          if (msg.contents.case === 'beginLiveFeedReply') {
            const result = msg.contents.value.result;
            if (result !== Result.CS_SUCCESS) throw new JouleResultError('beginLiveFeed', result);
          } else if (msg.contents.case === 'circulatorDataPoint') {
            onPoint(msg.contents.value);
          }
        }
      } catch (e) {
        if (!(e instanceof StreamCancelled)) throw e;
      }
    });
    return {
      done,
      stop: async () => {
        cancelled = true;
        (current as Stream | null)?.push(new StreamCancelled());
        await done.catch(() => {});
      },
    };
  }

  // --- Stream plumbing ---

  private onBytes(data: Uint8Array): void {
    let msg: StreamMessage;
    try {
      msg = decodeStreamMessage(data);
    } catch {
      console.warn(`Undecodable message: ${bytesToHex(data)}`);
      return;
    }
    this.streams.get(msg.handle)?.push(msg);
  }

  private onTransportClosed(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const stream of this.streams.values()) stream.push(null);
    for (const listener of this.closeListeners) listener();
  }

  private async send(handle: number, contents?: ContentsInit, end = false): Promise<void> {
    await this.transport.write(encodeStreamMessage(handle, this.me, this.remote, contents, end));
  }

  private async withStream<T>(contents: ContentsInit, body: (stream: Stream) => Promise<T>): Promise<T> {
    if (!this.connected) throw new JouleError('Not connected to the Joule');
    const stream = new Stream(this.handles.next());
    this.streams.set(stream.handle, stream);
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    try {
      await this.send(stream.handle, contents);
      keepAlive = setInterval(() => {
        this.send(stream.handle, { case: 'keepAlive', value: {} }).catch(() => {});
      }, this.keepAliveMs);
      return await body(stream);
    } finally {
      clearInterval(keepAlive);
      this.streams.delete(stream.handle);
      if (this.connected && !stream.remoteEnded) {
        await this.send(stream.handle, undefined, true).catch(() => {});
      }
    }
  }

  private async request<K extends Contents>(
    contents: ContentsInit,
    expect: K,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ReplyOf<K>> {
    const msg = await this.withStream(contents, (stream) => stream.receive(timeoutMs));
    if (msg.contents.case !== expect) {
      throw new JouleError(`Expected ${expect} but the Joule sent ${msg.contents.case}`);
    }
    const reply = msg.contents.value as ReplyOf<K>;
    // An unset optional `result` reads as 0 (CS_SUCCESS).
    const result = (reply as { result?: unknown }).result;
    if (typeof result === 'number' && result !== Result.CS_SUCCESS) {
      throw new JouleResultError(contents?.case ?? 'request', result);
    }
    return reply;
  }
}
