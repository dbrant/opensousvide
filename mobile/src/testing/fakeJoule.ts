// Test helper: simulates the circulator side of the stream protocol.

import { create } from '@bufbuild/protobuf';

import {
  BeginLiveFeedReplySchema,
  CirculatorDataPointSchema,
  DescribeFeedReplySchema,
  ProgramStep,
  Result,
  type CirculatorProgram,
  type StreamMessage,
} from '../proto/base_pb';
import type { Transport } from '../joule/client';
import { bytesToHex, decodeStreamMessage, encodeStreamMessage, hexToBytes, type ContentsInit } from '../joule/protocol';

export const JOULE_ADDR = '0a1b2c3d4e5f';
export const APP_ADDR = 'aabbaabbaabbaabb';
export const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeJoule implements Transport {
  /** Delay before the key exchange reply; `null` never replies. */
  buttonDelayMs: number | null = 0;
  /** Delay before replying to start and stop requests. */
  commandDelayMs = 0;
  authorized = false;
  closed = false;
  program: CirculatorProgram | null = null;
  feedId = 7;
  received: StreamMessage[] = [];
  private onMessage!: (data: Uint8Array) => void;
  private onCloseCb!: () => void;
  private address = hexToBytes(JOULE_ADDR);

  async open(onMessage: (data: Uint8Array) => void, onClose: () => void) {
    this.onMessage = onMessage;
    this.onCloseCb = onClose;
  }

  async close() {
    this.closed = true;
  }

  dropConnection() {
    this.closed = true;
    this.onCloseCb();
  }

  messages(kind: string) {
    return this.received.filter((m) => m.contents.case === kind);
  }

  private reply(req: StreamMessage, contents: ContentsInit, delayMs = 0) {
    const data = encodeStreamMessage(req.handle, this.address, req.senderAddress, contents);
    setTimeout(() => {
      if (!this.closed) this.onMessage(data);
    }, delayMs);
  }

  private guarded(action: () => Result): Result {
    return this.authorized ? action() : Result.CS_ERROR_FORBIDDEN;
  }

  async write(data: Uint8Array) {
    if (this.closed) throw new Error('Device is not connected');
    const req = decodeStreamMessage(data);
    this.received.push(req);
    const c = req.contents;
    switch (c.case) {
      case 'startKeyExchangeRequest':
        if (this.buttonDelayMs !== null) {
          this.reply(req, { case: 'startKeyExchangeReply', value: { secretKey: SECRET } }, this.buttonDelayMs);
        }
        break;
      case 'submitKeyRequest': {
        this.authorized = bytesToHex(c.value.secretKey) === bytesToHex(SECRET);
        const result = this.authorized ? Result.CS_SUCCESS : Result.CS_ERROR_FORBIDDEN;
        this.reply(req, { case: 'submitKeyReply', value: { result } });
        break;
      }
      case 'startProgramRequest': {
        const result = this.guarded(() => {
          if (this.program) return Result.CS_ERROR_INVALID_STATE;
          this.program = c.value.circulatorProgram ?? null;
          this.feedId += 1;
          return Result.CS_SUCCESS;
        });
        this.reply(req, { case: 'startProgramReply', value: { result } }, this.commandDelayMs);
        break;
      }
      case 'stopCirculatorRequest': {
        const result = this.guarded(() => {
          if (!this.program) return Result.CS_ERROR_INVALID_STATE;
          this.program = null;
          return Result.CS_SUCCESS;
        });
        this.reply(req, { case: 'stopCirculatorReply', value: { result } }, this.commandDelayMs);
        break;
      }
      case 'beginLiveFeed': {
        this.reply(req, { case: 'beginLiveFeedReply', value: create(BeginLiveFeedReplySchema, {}) });
        const programStep = this.program ? ProgramStep.PRE_HEAT : ProgramStep.UNKNOWN;
        for (const seq of [0, 1]) {
          const point = create(CirculatorDataPointSchema, {
            feedId: this.feedId,
            sequenceNumber: seq,
            timestamp: seq * 1000,
            bathTemp: 41.5,
            programStep,
          });
          this.reply(req, { case: 'circulatorDataPoint', value: point }, 5 * (seq + 1));
        }
        break;
      }
      case 'describeFeedRequest': {
        const reply = create(DescribeFeedReplySchema, { feedId: c.value.feedId });
        if (this.program) reply.circulatorProgram = this.program;
        this.reply(req, { case: 'describeFeedReply', value: reply });
        break;
      }
    }
  }
}
