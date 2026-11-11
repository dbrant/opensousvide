// Persistent settings, kept in the OS keystore because they include the
// Joule's pairing key.

import * as SecureStore from 'expo-secure-store';

import { newAppAddress } from './joule/protocol';

export type Unit = 'C' | 'F';

export interface PairedJoule {
  circulatorAddress: string;
  secretKey: string;
  name: string;
}

export interface Settings {
  appAddress: string;
  unit: Unit;
  /** Last target chosen, in °C. */
  lastSetpointC: number;
  joule: PairedJoule | null;
}

const KEY = 'opensousvide.settings';

export async function loadSettings(): Promise<Settings> {
  const raw = await SecureStore.getItemAsync(KEY);
  const saved: Partial<Settings> = raw ? JSON.parse(raw) : {};
  const settings: Settings = {
    appAddress: saved.appAddress ?? newAppAddress(),
    unit: saved.unit ?? 'C',
    lastSetpointC: saved.lastSetpointC ?? 57,
    joule: saved.joule ?? null,
  };
  if (!raw) await saveSettings(settings);
  return settings;
}

export function saveSettings(settings: Settings): Promise<void> {
  return SecureStore.setItemAsync(KEY, JSON.stringify(settings));
}
