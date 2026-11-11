// Joule BLE protocol constants and message helpers (no I/O).
// See docs/PROTOCOL.md at the repo root.

import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';

import {
  CirculatorProgramSchema,
  ProgramStep,
  ProgramType,
  Result,
  StreamMessageSchema,
  type CirculatorProgram,
  type StreamMessage,
} from '../proto/base_pb';

export const STREAM_SERVICE_UUID = '700b4321-9836-4383-a2b2-31a9098d1473';
export const WRITE_CHAR_UUID = '700b4322-9836-4383-a2b2-31a9098d1473';
export const READ_CHAR_UUID = '700b4323-9836-4383-a2b2-31a9098d1473';
export const NOTIFY_CHAR_UUID = '700b4325-9836-4383-a2b2-31a9098d1473';

export const MANUFACTURER_ID = 0x0159;

// Limits enforced by the official app.
export const MIN_SETPOINT_C = 20;
export const MAX_SETPOINT_C = 90;

export const ACTIVE_STEPS: ReadonlySet<ProgramStep> = new Set([
  ProgramStep.PRE_HEAT,
  ProgramStep.WAIT_FOR_FOOD,
  ProgramStep.COOK,
  ProgramStep.WAIT_FOR_REMOVE_FOOD,
]);

export type Contents = NonNullable<StreamMessage['contents']['case']>;

export interface Advertisement {
  /** Hex address used in StreamMessage sender/recipient fields. */
  circulatorAddress: string;
  version: number;
  /** True when another client already holds the BLE connection. */
  isConnected: boolean;
}

/**
 * Parse the manufacturer payload (company ID already stripped): one flags byte
 * (bit 7 = connected, bits 0-6 = version) followed by the circulator address.
 */
export function parseManufacturerPayload(payload: ArrayLike<number> | undefined): Advertisement | null {
  if (!payload || payload.length < 2) return null;
  const flags = payload[0];
  return {
    circulatorAddress: bytesToHex(Array.from(payload).slice(1)),
    version: flags & 0x7f,
    isConnected: (flags & 0x80) !== 0,
  };
}

export function bytesToHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Random 8-byte address identifying this client to the circulator. */
export function newAppAddress(random: () => number = Math.random): string {
  return bytesToHex(Array.from({ length: 8 }, () => Math.floor(random() * 256)));
}

/**
 * Allocates stream handles toward one remote address. Each side uses only odd
 * or only even handles so that streams opened by either party never collide.
 * The side whose address compares lower (as a hex string) uses odd handles.
 */
export class HandlePool {
  static readonly LRU_SIZE = 128;
  static readonly MAX_HANDLE = 999_999 - HandlePool.LRU_SIZE * 2;

  readonly even: boolean;
  private recent: number[] = [];

  constructor(myAddress: string, remoteAddress: string, private random: () => number = Math.random) {
    this.even = remoteAddress.toLowerCase() > myAddress.toLowerCase();
  }

  owns(handle: number): boolean {
    return (handle % 2 === 0) === this.even;
  }

  next(): number {
    let handle = Math.round(this.random() * HandlePool.MAX_HANDLE);
    if (!this.owns(handle)) handle += 1;
    while (this.recent.includes(handle)) handle += 2;
    this.recent.push(handle);
    if (this.recent.length > HandlePool.LRU_SIZE) this.recent.shift();
    return handle;
  }
}

export type ContentsInit = MessageInitShape<typeof StreamMessageSchema>['contents'];

export function encodeStreamMessage(
  handle: number,
  sender: Uint8Array,
  recipient: Uint8Array,
  contents?: ContentsInit,
  end = false,
): Uint8Array {
  const msg = create(StreamMessageSchema, {
    handle,
    senderAddress: sender,
    recipientAddress: recipient,
    ...(end ? { end: true } : {}),
    ...(contents ? { contents } : {}),
  });
  return toBinary(StreamMessageSchema, msg);
}

export function decodeStreamMessage(data: Uint8Array): StreamMessage {
  return fromBinary(StreamMessageSchema, data);
}

/** A program that heats to `setpointC` and holds it until stopped. */
export function manualProgram(setpointC: number): CirculatorProgram {
  validateSetpoint(setpointC);
  return create(CirculatorProgramSchema, { setPoint: setpointC, programType: ProgramType.MANUAL });
}

export function validateSetpoint(setpointC: number): void {
  if (!(setpointC >= MIN_SETPOINT_C && setpointC <= MAX_SETPOINT_C)) {
    throw new RangeError(
      `${setpointC.toFixed(1)}°C is outside the supported range ${MIN_SETPOINT_C}-${MAX_SETPOINT_C}°C`,
    );
  }
}

export const fToC = (f: number) => ((f - 32) * 5) / 9;
export const cToF = (c: number) => (c * 9) / 5 + 32;

export function resultName(result: number): string {
  return Result[result] ?? String(result);
}

export function stepName(step: number): string {
  return ProgramStep[step] ?? String(step);
}
