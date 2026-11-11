/// <reference types="node" />
// Runs under Node (`npm test`), not in the app.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { create } from '@bufbuild/protobuf';

import {
  BeginLiveFeedReplySchema,
  CirculatorDataPointSchema,
  DescribeFeedReplySchema,
  ProgramStep,
  ProgramType,
  Result,
  type CirculatorProgram,
  type StreamMessage,
} from '../proto/base_pb';
import { JouleClient, JouleError, JouleResultError, JouleTimeout, isCooking, type Transport } from './client';
import {
  HandlePool,
  bytesToHex,
  decodeStreamMessage,
  encodeStreamMessage,
  hexToBytes,
  parseManufacturerPayload,
  type ContentsInit,
} from './protocol';

const JOULE_ADDR = '0a1b2c3d4e5f';
const APP_ADDR = 'aabbaabbaabbaabb';
const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulates the circulator side of the stream protocol. */
class FakeJoule implements Transport {
  buttonDelayMs: number | null = 0;
  authorized = false;
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

  async close() {}

  dropConnection() {
    this.onCloseCb();
  }

  messages(kind: string) {
    return this.received.filter((m) => m.contents.case === kind);
  }

  private reply(req: StreamMessage, contents: ContentsInit, delayMs = 0) {
    const data = encodeStreamMessage(req.handle, this.address, req.senderAddress, contents);
    setTimeout(() => this.onMessage(data), delayMs);
  }

  private guarded(action: () => Result): Result {
    return this.authorized ? action() : Result.CS_ERROR_FORBIDDEN;
  }

  async write(data: Uint8Array) {
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
        this.reply(req, { case: 'startProgramReply', value: { result } });
        break;
      }
      case 'stopCirculatorRequest': {
        const result = this.guarded(() => {
          if (!this.program) return Result.CS_ERROR_INVALID_STATE;
          this.program = null;
          return Result.CS_SUCCESS;
        });
        this.reply(req, { case: 'stopCirculatorReply', value: { result } });
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

describe('protocol', () => {
  it('encodes the same bytes the real Joule accepted', () => {
    // Captured from the Python client talking to a Joule (firmware 175).
    const sender = hexToBytes('2bcee63eeeb2c785');
    const recipient = hexToBytes('c00000b03893fa46');
    const identify = encodeStreamMessage(621298, sender, recipient, { case: 'identifyCirculatorRequest', value: {} });
    assert.equal(bytesToHex(identify), '0df27a09002a082bcee63eeeb2c7853208c00000b03893fa46c20900');
    const end = encodeStreamMessage(621298, sender, recipient, undefined, true);
    assert.equal(bytesToHex(end), '0df27a090020012a082bcee63eeeb2c7853208c00000b03893fa46');
  });

  it('picks handle parity from address order', () => {
    const even = new HandlePool('0001', 'ff00');
    const odd = new HandlePool('ff00', '0001');
    for (let i = 0; i < 200; i++) {
      assert.equal(even.next() % 2, 0);
      assert.equal(odd.next() % 2, 1);
    }
  });

  it('does not reuse recent handles', () => {
    const pool = new HandlePool('01', '02', () => 0.5);
    const handles = Array.from({ length: 50 }, () => pool.next());
    assert.equal(new Set(handles).size, 50);
  });

  it('parses the manufacturer payload', () => {
    const ad = parseManufacturerPayload([0x81, ...hexToBytes('c00000b03893fa46')]);
    assert.deepEqual(ad, { circulatorAddress: 'c00000b03893fa46', version: 1, isConnected: true });
    assert.equal(parseManufacturerPayload([0x01]), null);
  });
});

describe('JouleClient', () => {
  let joule: FakeJoule;
  let client: JouleClient;

  beforeEach(async () => {
    joule = new FakeJoule();
    client = new JouleClient(joule, JOULE_ADDR, APP_ADDR, { keepAliveMs: 50 });
    await client.open();
  });

  it('pairs, authenticates, and ends every request stream', async () => {
    const key = await client.pair();
    assert.equal(key, bytesToHex(SECRET));
    await client.authenticate(key);
    assert.ok(joule.authorized);
    for (const m of joule.received) {
      assert.equal(bytesToHex(m.senderAddress), APP_ADDR);
      assert.equal(bytesToHex(m.recipientAddress), JOULE_ADDR);
    }
    const requests = new Set(joule.received.filter((m) => m.contents.case).map((m) => m.handle));
    const ends = new Set(joule.received.filter((m) => m.end && !m.contents.case).map((m) => m.handle));
    assert.deepEqual(ends, requests);
  });

  it('rejects a wrong key', async () => {
    await assert.rejects(client.authenticate('00'.repeat(16)), (e: unknown) => {
      assert.ok(e instanceof JouleResultError);
      assert.equal(e.result, Result.CS_ERROR_FORBIDDEN);
      return true;
    });
  });

  it('sets, replaces and stops a program', async () => {
    await client.authenticate(bytesToHex(SECRET));
    await client.setTemperature(57);
    assert.equal(joule.program?.setPoint, 57);
    assert.equal(joule.program?.programType, ProgramType.MANUAL);
    await client.setTemperature(63.5);
    assert.equal(joule.program?.setPoint, 63.5);
    await client.stop();
    assert.equal(joule.program, null);
  });

  it('refuses out-of-range temperatures without sending anything', async () => {
    await assert.rejects(client.setTemperature(99), RangeError);
    assert.equal(joule.received.length, 0);
  });

  it('streams live data and ends the feed on stop', async () => {
    await client.authenticate(bytesToHex(SECRET));
    await client.setTemperature(57);
    const points: number[] = [];
    let cooking = false;
    const feed = client.liveFeed((p) => {
      points.push(p.sequenceNumber);
      cooking = isCooking(p);
    });
    await sleep(30);
    await feed.stop();
    assert.deepEqual(points, [0, 1]);
    assert.ok(cooking);
    const handle = joule.messages('beginLiveFeed')[0].handle;
    assert.ok(joule.received.some((m) => m.handle === handle && m.end));
    const info = await client.describeFeed(joule.feedId);
    assert.equal(info.circulatorProgram?.setPoint, 57);
  });

  it('times out when the button is not pressed', async () => {
    joule.buttonDelayMs = null;
    await assert.rejects(client.pair(50), JouleTimeout);
  });

  it('sends keep-alives while waiting', async () => {
    joule.buttonDelayMs = 180;
    await client.pair();
    const handle = joule.messages('startKeyExchangeRequest')[0].handle;
    const keepAlives = joule.messages('keepAlive').filter((m) => m.handle === handle);
    assert.ok(keepAlives.length >= 2, `only ${keepAlives.length} keep-alives`);
  });

  it('fails pending requests when the connection drops', async () => {
    joule.buttonDelayMs = null;
    let closed = false;
    client.onClose(() => (closed = true));
    const pending = client.pair();
    await sleep(10);
    joule.dropConnection();
    await assert.rejects(pending, JouleError);
    assert.ok(closed);
    assert.equal(client.isConnected, false);
  });
});
