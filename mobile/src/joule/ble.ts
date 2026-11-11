// BLE access through react-native-ble-manager: permissions, scanning, and the
// GATT transport used by JouleClient.

import { PermissionsAndroid, Platform, type EventSubscription } from 'react-native';
import BleManager, {
  BleScanCallbackType,
  BleScanMatchMode,
  BleScanMode,
  BleState,
  type Peripheral,
} from 'react-native-ble-manager';

import type { Transport } from './client';
import {
  MANUFACTURER_ID,
  NOTIFY_CHAR_UUID,
  READ_CHAR_UUID,
  STREAM_SERVICE_UUID,
  WRITE_CHAR_UUID,
  parseManufacturerPayload,
  type Advertisement,
} from './protocol';

const CONNECT_TIMEOUT_MS = 15_000;
// Large enough that the library never splits a message across writes; Android
// performs a long write if the message exceeds the negotiated MTU.
const MAX_WRITE_BYTES = 512;

let started: Promise<void> | null = null;

function ensureStarted(): Promise<void> {
  started ??= BleManager.start({ logLevel: 'none' });
  return started;
}

/** Request runtime permissions and make sure Bluetooth is on. */
export async function prepareBluetooth(): Promise<void> {
  if (Platform.OS === 'android') {
    const permissions =
      Number(Platform.Version) >= 31
        ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const results = await PermissionsAndroid.requestMultiple(permissions);
    if (!Object.values(results).every((r) => r === PermissionsAndroid.RESULTS.GRANTED)) {
      throw new Error('Bluetooth permission is needed to talk to the Joule.');
    }
  }
  await ensureStarted();
  if ((await BleManager.checkState()) !== BleState.On) {
    if (Platform.OS !== 'android') throw new Error('Turn on Bluetooth to talk to the Joule.');
    await BleManager.enableBluetooth();
  }
}

export interface FoundJoule {
  /** BLE peripheral ID (the MAC address on Android). */
  id: string;
  name?: string;
  rssi: number;
  ad: Advertisement;
}

function advertisementOf(p: Peripheral): Advertisement | null {
  const key = MANUFACTURER_ID.toString(16).padStart(4, '0');
  const payload = p.advertising?.manufacturerData?.[key]?.bytes;
  if (payload) return parseManufacturerPayload(payload);
  // Raw form starts with the little-endian company ID.
  const raw = p.advertising?.manufacturerRawData?.bytes;
  if (raw && raw.length > 2 && (raw[0] | (raw[1] << 8)) === MANUFACTURER_ID) {
    return parseManufacturerPayload(raw.slice(2));
  }
  return null;
}

export interface ScanHandle {
  stop(): Promise<void>;
  /** Resolves when the scan ends, whether it timed out or was stopped. */
  done: Promise<void>;
}

/** Report each Joule seen during a scan of `seconds`. */
export function scanForJoules(seconds: number, onFound: (joule: FoundJoule) => void): ScanHandle {
  const subs: EventSubscription[] = [];
  const seen = new Set<string>();
  const done = new Promise<void>((resolve, reject) => {
    subs.push(BleManager.onStopScan(() => resolve()));
    subs.push(
      BleManager.onDiscoverPeripheral((p) => {
        const ad = advertisementOf(p);
        if (!ad || seen.has(p.id)) return;
        seen.add(p.id);
        onFound({ id: p.id, name: p.advertising?.localName ?? p.name, rssi: p.rssi, ad });
      }),
    );
    ensureStarted()
      .then(() =>
        BleManager.scan({
          seconds,
          scanMode: BleScanMode.LowLatency,
          matchMode: BleScanMatchMode.Aggressive,
          callbackType: BleScanCallbackType.AllMatches,
        }),
      )
      .catch(reject);
  }).finally(() => subs.forEach((s) => s.remove()));
  return { done, stop: () => BleManager.stopScan().catch(() => {}) };
}

/** Scan until the Joule with `circulatorAddress` shows up. */
export async function findJoule(circulatorAddress: string, seconds = 10): Promise<FoundJoule | null> {
  let match: FoundJoule | null = null;
  const scan = scanForJoules(seconds, (j) => {
    if (j.ad.circulatorAddress === circulatorAddress) {
      match = j;
      scan.stop();
    }
  });
  await scan.done;
  return match;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/**
 * GATT transport: requests are written to one characteristic; the Joule
 * signals pending data with a notification, which is then fetched by reading
 * another.
 */
export class BleTransport implements Transport {
  private subs: EventSubscription[] = [];
  private reads: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly peripheralId: string) {}

  async open(onMessage: (data: Uint8Array) => void, onClose: () => void): Promise<void> {
    await ensureStarted();
    const id = this.peripheralId;
    this.subs.push(
      BleManager.onDisconnectPeripheral((e) => {
        if (e.peripheral !== id) return;
        this.removeListeners();
        const wasOpen = !this.closed;
        this.closed = true;
        if (wasOpen) onClose();
      }),
      BleManager.onDidUpdateValueForCharacteristic((e) => {
        if (e.peripheral === id && e.characteristic.toLowerCase() === NOTIFY_CHAR_UUID) {
          this.scheduleRead(onMessage);
        }
      }),
    );
    try {
      await withTimeout(BleManager.connect(id), CONNECT_TIMEOUT_MS, 'Timed out connecting to the Joule.');
      await BleManager.requestMTU(id, 247).catch(() => {});
      await BleManager.retrieveServices(id);
      await BleManager.startNotification(id, STREAM_SERVICE_UUID, NOTIFY_CHAR_UUID);
    } catch (e) {
      await this.close();
      throw e;
    }
    // The official app reads once right after subscribing.
    this.scheduleRead(onMessage);
  }

  private scheduleRead(onMessage: (data: Uint8Array) => void): void {
    this.reads = this.reads.then(async () => {
      if (this.closed) return;
      try {
        const data = await BleManager.read(this.peripheralId, STREAM_SERVICE_UUID, READ_CHAR_UUID);
        // A leading zero byte means "nothing to read".
        if (data.length > 0 && data[0] !== 0) onMessage(Uint8Array.from(data));
      } catch (e) {
        if (!this.closed) console.warn('Joule read failed', e);
      }
    });
  }

  write(data: Uint8Array): Promise<void> {
    return BleManager.write(this.peripheralId, STREAM_SERVICE_UUID, WRITE_CHAR_UUID, Array.from(data), MAX_WRITE_BYTES);
  }

  private removeListeners(): void {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
  }

  async close(): Promise<void> {
    this.closed = true;
    this.removeListeners();
    await BleManager.disconnect(this.peripheralId).catch(() => {});
  }
}
