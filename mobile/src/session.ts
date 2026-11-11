// Keeps a connection to the paired Joule while the app is in use, streams
// its live data, and exposes commands. The Joule runs programs on its own, so
// disconnecting never affects cooking.

import { ErrorState, ProgramStep, type CirculatorDataPoint } from './proto/base_pb';
import { BleTransport, findJoule, prepareBluetooth } from './joule/ble';
import { JouleClient, JouleResultError, isCooking, type LiveFeed } from './joule/client';
import type { PairedJoule } from './settings';

export type Connection = 'disconnected' | 'searching' | 'connecting' | 'connected';

export interface SessionState {
  connection: Connection;
  /** Last connection problem, cleared on the next attempt. */
  error: string | null;
  bathTempC: number | null;
  /** Target of the running program, if known. */
  setpointC: number | null;
  cooking: boolean;
  step: ProgramStep | null;
  errorState: ErrorState;
}

const INITIAL: SessionState = {
  connection: 'disconnected',
  error: null,
  bathTempC: null,
  setpointC: null,
  cooking: false,
  step: null,
  errorState: ErrorState.NO_ERROR,
};

const RECONNECT_MS = 5_000;
const FEED_RESTART_MS = 1_000;
const FEED_RETRY_AFTER_ERROR_MS = 5_000;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class JouleSession {
  private state: SessionState = INITIAL;
  private listeners = new Set<() => void>();
  private client: JouleClient | null = null;
  private feed: LiveFeed | null = null;
  private wanted = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private feedTimer: ReturnType<typeof setTimeout> | undefined;
  private feedId: number | null = null;
  private setpoints = new Map<number, number | null>();

  constructor(
    private readonly joule: PairedJoule,
    private readonly appAddress: string,
  ) {}

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Connect and stay connected (reconnecting as needed) until `pause()`. */
  resume(): void {
    this.wanted = true;
    void this.connect();
  }

  async pause(): Promise<void> {
    this.wanted = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.feedTimer);
    const client = this.client;
    this.client = null;
    this.feed = null;
    await client?.close();
    this.update({ connection: 'disconnected' });
  }

  retryNow(): void {
    clearTimeout(this.reconnectTimer);
    this.resume();
  }

  async setTemperature(setpointC: number): Promise<void> {
    await this.requireClient().setTemperature(setpointC);
    this.update({ cooking: true, setpointC, step: ProgramStep.PRE_HEAT });
    this.restartFeed(0);
  }

  async stop(): Promise<void> {
    await this.requireClient().stop();
    this.update({ cooking: false, setpointC: null, step: null });
  }

  private requireClient(): JouleClient {
    if (!this.client?.isConnected) throw new Error('Not connected to the Joule yet.');
    return this.client;
  }

  private async connect(): Promise<void> {
    if (this.client || this.connecting || !this.wanted) return;
    this.connecting = true;
    try {
      this.update({ connection: 'searching', error: null });
      await prepareBluetooth();
      const found = await findJoule(this.joule.circulatorAddress);
      if (!found) {
        throw new Error(`Couldn't find ${this.joule.name || 'your Joule'}. Make sure it's plugged in and nearby.`);
      }
      if (!this.wanted) return;

      this.update({ connection: 'connecting' });
      const client = new JouleClient(new BleTransport(found.id), this.joule.circulatorAddress, this.appAddress);
      await client.open();
      try {
        await client.authenticate(this.joule.secretKey);
      } catch (e) {
        await client.close();
        if (e instanceof JouleResultError) {
          throw new Error('The Joule rejected the saved pairing. Forget this Joule and pair again.');
        }
        throw e;
      }
      if (!this.wanted) {
        await client.close();
        return;
      }
      this.client = client;
      client.onClose(() => this.handleDisconnect(client));
      this.update({ connection: 'connected' });
      this.startFeed();
    } catch (e) {
      this.update({ connection: 'disconnected', error: errorMessage(e) });
      this.scheduleReconnect(RECONNECT_MS);
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.wanted) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delayMs);
  }

  private handleDisconnect(client: JouleClient): void {
    if (this.client !== client) return;
    this.client = null;
    this.feed = null;
    clearTimeout(this.feedTimer);
    this.update({ connection: 'disconnected' });
    this.scheduleReconnect(1_000);
  }

  private restartFeed(delayMs: number): void {
    clearTimeout(this.feedTimer);
    this.feedTimer = setTimeout(() => {
      if (!this.client?.isConnected) return;
      const old = this.feed;
      this.feed = null;
      void (old ? old.stop() : Promise.resolve()).then(() => this.startFeed());
    }, delayMs);
  }

  private startFeed(): void {
    const client = this.client;
    if (!client?.isConnected || this.feed) return;
    const feed = client.liveFeed((p) => this.onPoint(client, p));
    this.feed = feed;
    feed.done.then(
      () => this.onFeedEnded(feed, FEED_RESTART_MS),
      (e) => {
        console.warn('Live feed failed', errorMessage(e));
        this.onFeedEnded(feed, FEED_RETRY_AFTER_ERROR_MS);
      },
    );
  }

  private onFeedEnded(feed: LiveFeed, restartMs: number): void {
    if (this.feed !== feed) return;
    this.feed = null;
    this.restartFeed(restartMs);
  }

  private onPoint(client: JouleClient, point: CirculatorDataPoint): void {
    const cooking = isCooking(point);
    this.feedId = point.feedId;
    if (cooking && !this.setpoints.has(point.feedId)) {
      this.setpoints.set(point.feedId, null);
      client.describeFeed(point.feedId).then(
        (info) => {
          const setpoint = info.circulatorProgram?.setPoint ?? null;
          this.setpoints.set(point.feedId, setpoint);
          if (this.feedId === point.feedId && this.state.cooking) this.update({ setpointC: setpoint });
        },
        () => this.setpoints.delete(point.feedId),
      );
    }
    this.update({
      bathTempC: point.bathTemp,
      cooking,
      step: point.programStep,
      errorState: point.errorState,
      // Until the feed's program is known, keep the target set from this app.
      setpointC: cooking ? (this.setpoints.get(point.feedId) ?? this.state.setpointC) : null,
    });
  }
}
