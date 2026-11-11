/// <reference types="node" />
// Runs under Node (`npm test`), not in the app.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { JouleClient } from './joule/client';
import { bytesToHex } from './joule/protocol';
import { JouleSession, type OpenClient } from './session';
import { APP_ADDR, FakeJoule, JOULE_ADDR, SECRET, sleep } from './testing/fakeJoule';

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(5);
  }
}

describe('JouleSession', () => {
  let joule: FakeJoule;
  let opens: number;
  let session: JouleSession;

  beforeEach(async () => {
    joule = new FakeJoule();
    opens = 0;
    const openClient: OpenClient = async (_paired, appAddress, onConnecting) => {
      opens += 1;
      onConnecting();
      const client = new JouleClient(joule, JOULE_ADDR, appAddress, { keepAliveMs: 50 });
      await client.open();
      return client;
    };
    session = new JouleSession({ circulatorAddress: JOULE_ADDR, secretKey: bytesToHex(SECRET), name: 'Test' }, APP_ADDR, openClient);
    session.resume();
    await waitFor(() => session.getState().connection === 'connected');
  });

  it('shows live data once connected', async () => {
    await waitFor(() => session.getState().bathTempC !== null);
    assert.equal(session.getState().bathTempC, 41.5);
    await session.pause();
  });

  it('lets a temperature change finish before disconnecting on pause', async () => {
    await session.setTemperature(57);
    joule.commandDelayMs = 40;
    const change = session.setTemperature(63);
    await sleep(10); // Between the stop and the start that make up the change.
    const paused = session.pause();
    await change;
    await paused;
    assert.equal(joule.program?.setPoint, 63);
    assert.ok(joule.closed);
    assert.equal(session.getState().connection, 'disconnected');
  });

  it('keeps the connection when resumed before the disconnect happens', async () => {
    joule.commandDelayMs = 40;
    const change = session.setTemperature(60);
    const paused = session.pause();
    session.resume();
    await change;
    await paused;
    assert.equal(joule.closed, false);
    assert.equal(opens, 1);
    assert.equal(session.getState().connection, 'connected');
    await session.pause();
  });

  it('disconnects right away when nothing is in flight', async () => {
    await session.pause();
    assert.ok(joule.closed);
    assert.equal(session.getState().connection, 'disconnected');
  });
});
