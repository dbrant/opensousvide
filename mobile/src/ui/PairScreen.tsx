import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { prepareBluetooth, scanForJoules, type FoundJoule, type ScanHandle } from '../joule/ble';
import { pairJoule } from '../pairing';
import { errorMessage } from '../session';
import type { PairedJoule } from '../settings';
import { Button } from './components';
import { useTheme } from './theme';

type Phase = { kind: 'idle' } | { kind: 'scanning' } | { kind: 'pairing'; joule: FoundJoule; waiting: boolean };

export function PairScreen({ appAddress, onPaired }: { appAddress: string; onPaired: (j: PairedJoule) => void }) {
  const t = useTheme();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [found, setFound] = useState<FoundJoule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const scan = useRef<ScanHandle | null>(null);

  useEffect(() => () => void scan.current?.stop(), []);

  async function startScan() {
    setError(null);
    setFound([]);
    try {
      await prepareBluetooth();
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    setPhase({ kind: 'scanning' });
    const handle = scanForJoules(8, (j) => setFound((list) => [...list, j]));
    scan.current = handle;
    try {
      await handle.done;
    } catch (e) {
      setError(errorMessage(e));
    }
    if (scan.current === handle) scan.current = null;
    setScanned(true);
    setPhase((p) => (p.kind === 'scanning' ? { kind: 'idle' } : p));
  }

  async function pair(joule: FoundJoule) {
    await scan.current?.stop();
    setError(null);
    setPhase({ kind: 'pairing', joule, waiting: false });
    try {
      const paired = await pairJoule(joule, appAddress, () =>
        setPhase({ kind: 'pairing', joule, waiting: true }),
      );
      onPaired(paired);
    } catch (e) {
      setError(`Pairing failed: ${errorMessage(e)}`);
      setPhase({ kind: 'idle' });
    }
  }

  if (phase.kind === 'pairing') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={t.accent} />
        <Text style={[styles.title, { color: t.text }]}>
          {phase.waiting ? 'Press the button on top of your Joule' : `Connecting to ${phase.joule.name || 'Joule'}…`}
        </Text>
        {phase.waiting && <Text style={[styles.body, { color: t.muted }]}>Waiting up to 35 seconds.</Text>}
      </View>
    );
  }

  const scanning = phase.kind === 'scanning';
  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: t.text }]}>Connect your Joule</Text>
      <Text style={[styles.body, { color: t.muted }]}>
        Plug in your Joule and keep it close to your phone. You only need to pair once.
      </Text>

      <FlatList
        style={styles.list}
        data={found}
        keyExtractor={(j) => j.id}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => pair(item)}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: t.card, borderColor: t.border, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={[styles.rowTitle, { color: t.text }]}>{item.name || 'Joule'}</Text>
            <Text style={[styles.rowDetail, { color: t.muted }]}>
              {item.ad.isConnected ? 'In use by another device' : `Signal ${item.rssi} dBm`} · tap to pair
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          scanning ? (
            <ActivityIndicator style={{ marginTop: 24 }} color={t.accent} />
          ) : scanned && !error ? (
            <Text style={[styles.body, { color: t.muted }]}>No Joules found nearby.</Text>
          ) : undefined
        }
      />

      {error && <Text style={[styles.error, { color: t.danger }]}>{error}</Text>}
      <Button
        title={scanning ? 'Searching…' : found.length ? 'Search again' : 'Find my Joule'}
        onPress={startScan}
        loading={scanning}
        variant={found.length ? 'secondary' : 'primary'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12 },
  center: { flex: 1, padding: 24, gap: 16, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  list: { flexGrow: 0, marginVertical: 12 },
  row: { borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 10 },
  rowTitle: { fontSize: 18, fontWeight: '600' },
  rowDetail: { fontSize: 14, marginTop: 4 },
  error: { fontSize: 15, textAlign: 'center' },
});
