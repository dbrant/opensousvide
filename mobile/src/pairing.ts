import { BleTransport, prepareBluetooth, type FoundJoule } from './joule/ble';
import { JouleClient } from './joule/client';
import type { PairedJoule } from './settings';

/**
 * Pair with `found`. `onWaitingForButton` is called once the Joule is ready
 * for its button to be pressed.
 */
export async function pairJoule(
  found: FoundJoule,
  appAddress: string,
  onWaitingForButton: () => void,
): Promise<PairedJoule> {
  await prepareBluetooth();
  const address = found.ad.circulatorAddress;
  const client = new JouleClient(new BleTransport(found.id), address, appAddress);
  await client.open();
  try {
    onWaitingForButton();
    const secretKey = await client.pair();
    await client.authenticate(secretKey);
    let name = found.name ?? '';
    try {
      name = (await client.identify()).name || name;
    } catch {
      // The name is cosmetic; keep the advertised one.
    }
    return { circulatorAddress: address, secretKey, name };
  } finally {
    await client.close();
  }
}
