import { BleTransport, findJoule, prepareBluetooth } from './joule/ble';
import { JouleClient } from './joule/client';
import type { OpenClient } from './session';

/** Finds the paired Joule over BLE and opens a client to it. */
export const openBleClient: OpenClient = async (joule, appAddress, onConnecting) => {
  await prepareBluetooth();
  const found = await findJoule(joule.circulatorAddress);
  if (!found) {
    throw new Error(`Couldn't find ${joule.name || 'your Joule'}. Make sure it's plugged in and nearby.`);
  }
  onConnecting();
  const client = new JouleClient(new BleTransport(found.id), joule.circulatorAddress, appAddress);
  await client.open();
  return client;
};
