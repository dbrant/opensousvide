import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { JouleSession } from './src/session';
import { loadSettings, saveSettings, type Settings } from './src/settings';
import { ControlScreen } from './src/ui/ControlScreen';
import { PairScreen } from './src/ui/PairScreen';
import { useTheme } from './src/ui/theme';

export default function App() {
  const t = useTheme();
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const update = (patch: Partial<Settings>) =>
    setSettings((s) => {
      if (!s) return s;
      const next = { ...s, ...patch };
      void saveSettings(next);
      return next;
    });

  const joule = settings?.joule ?? null;
  const session = useMemo(
    () => (joule && settings ? new JouleSession(joule, settings.appAddress) : null),
    // A new session only when a different Joule is paired.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [joule?.circulatorAddress, joule?.secretKey],
  );

  // Hold the BLE connection only while the app is in the foreground.
  useEffect(() => {
    if (!session) return;
    if (AppState.currentState === 'active') session.resume();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') session.resume();
      else if (state === 'background') void session.pause();
    });
    return () => {
      sub.remove();
      void session.pause();
    };
  }, [session]);

  let content;
  if (!settings) {
    content = <ActivityIndicator style={styles.loading} color={t.accent} />;
  } else if (!joule || !session) {
    content = <PairScreen appAddress={settings.appAddress} onPaired={(j) => update({ joule: j })} />;
  } else {
    content = (
      <ControlScreen
        session={session}
        name={joule.name || 'Joule'}
        unit={settings.unit}
        initialSetpointC={settings.lastSetpointC}
        onUnitChange={(unit) => update({ unit })}
        onSetpointChosen={(c) => update({ lastSetpointC: c })}
        onForget={() => update({ joule: null })}
      />
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.root, { backgroundColor: t.background }]}>
        <StatusBar style="auto" />
        <View style={styles.root}>{content}</View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: { flex: 1 },
});
