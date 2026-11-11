import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { ErrorState, ProgramStep } from '../proto/base_pb';
import { MAX_SETPOINT_C, MIN_SETPOINT_C, cToF, fToC } from '../joule/protocol';
import { errorMessage, type JouleSession, type SessionState } from '../session';
import type { Unit } from '../settings';
import { Button } from './components';
import { useTheme, type Theme } from './theme';

const STEP: Record<Unit, number> = { C: 0.5, F: 1 };

function toUnit(c: number, unit: Unit): number {
  const value = unit === 'F' ? cToF(c) : c;
  return Math.round(value / STEP[unit]) * STEP[unit];
}

function toC(value: number, unit: Unit): number {
  return unit === 'F' ? fToC(value) : value;
}

function formatTemp(c: number | null, unit: Unit): string {
  if (c === null) return '—';
  return `${(unit === 'F' ? cToF(c) : c).toFixed(1)}°${unit}`;
}

function describe(s: SessionState, unit: Unit, name: string): { text: string; tone: 'muted' | 'accent' | 'danger' } {
  if (s.connection === 'searching') return { text: `Looking for ${name}…`, tone: 'muted' };
  if (s.connection === 'connecting') return { text: `Connecting to ${name}…`, tone: 'muted' };
  if (s.connection === 'disconnected') return { text: s.error ?? 'Not connected', tone: s.error ? 'danger' : 'muted' };
  if (s.step === ProgramStep.ERROR || s.errorState !== ErrorState.NO_ERROR) {
    return { text: 'The Joule reported a problem. Check the water level.', tone: 'danger' };
  }
  if (!s.cooking) return { text: 'Idle', tone: 'muted' };
  const target = formatTemp(s.setpointC, unit);
  if (s.step === ProgramStep.PRE_HEAT) return { text: `Heating to ${target}`, tone: 'accent' };
  return { text: `Holding at ${target}`, tone: 'accent' };
}

/** Calls `action` on press, and repeatedly while held. */
function useRepeatPress(action: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = () => clearTimeout(timer.current);
  useEffect(() => stop, []);
  return {
    onPressIn: () => {
      // Pressable drops the deferred onPressOut of a very short tap when the
      // next touch starts, so a previous repeat may still be running.
      stop();
      action();
      const repeat = (delay: number) => {
        timer.current = setTimeout(() => {
          action();
          repeat(80);
        }, delay);
      };
      repeat(400);
    },
    onPressOut: stop,
  };
}

function StepButton({ label, onStep, disabled, t }: { label: string; onStep: () => void; disabled: boolean; t: Theme }) {
  const press = useRepeatPress(onStep);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === '+' ? 'Raise target' : 'Lower target'}
      disabled={disabled}
      {...press}
      style={({ pressed }) => [
        styles.stepButton,
        { backgroundColor: t.accentSoft, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.stepLabel, { color: t.accent }]}>{label}</Text>
    </Pressable>
  );
}

export function ControlScreen({
  session,
  name,
  unit,
  initialSetpointC,
  onUnitChange,
  onSetpointChosen,
  onForget,
}: {
  session: JouleSession;
  name: string;
  unit: Unit;
  initialSetpointC: number;
  onUnitChange: (unit: Unit) => void;
  onSetpointChosen: (c: number) => void;
  onForget: () => void;
}) {
  const t = useTheme();
  const s = useSyncExternalStore(session.subscribe, session.getState);
  const [target, setTarget] = useState(() => toUnit(initialSetpointC, unit));
  const [busy, setBusy] = useState(false);
  const touched = useRef(false);

  const min = toUnit(MIN_SETPOINT_C, unit);
  const max = toUnit(MAX_SETPOINT_C, unit);
  const targetC = toC(target, unit);

  // Show the running program's target until the user picks a new one.
  useEffect(() => {
    if (s.setpointC !== null && !touched.current) setTarget(toUnit(s.setpointC, unit));
  }, [s.setpointC, unit]);

  const step = (direction: 1 | -1) => {
    touched.current = true;
    setTarget((v) => Math.min(max, Math.max(min, v + direction * STEP[unit])));
  };

  const switchUnit = (next: Unit) => {
    if (next === unit) return;
    setTarget(toUnit(targetC, next));
    onUnitChange(next);
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      Alert.alert("Couldn't reach the Joule", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run(async () => {
      await session.setTemperature(targetC);
      touched.current = false;
      onSetpointChosen(targetC);
    });

  const stop = () =>
    Alert.alert('Stop heating?', `${name} will turn off.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: () => run(() => session.stop()) },
    ]);

  const forget = () =>
    Alert.alert('Forget this Joule?', 'You will need to pair again to control it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: onForget },
    ]);

  const connected = s.connection === 'connected';
  const status = describe(s, unit, name);
  const toneColor = { muted: t.muted, accent: t.accent, danger: t.danger }[status.tone];
  const targetChanged = s.setpointC === null || Math.abs(targetC - s.setpointC) > 0.05;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={[styles.name, { color: t.text }]} numberOfLines={1}>
          {name}
        </Text>
        <View style={[styles.dot, { backgroundColor: connected ? t.ok : t.border }]} />
      </View>

      <View style={styles.reading}>
        <Text style={[styles.caption, { color: t.muted }]}>WATER</Text>
        <Text style={[styles.water, { color: t.text }]}>{formatTemp(connected ? s.bathTempC : null, unit)}</Text>
        <View style={styles.statusRow}>
          {(s.connection === 'searching' || s.connection === 'connecting') && <ActivityIndicator color={t.muted} />}
          <Text style={[styles.status, { color: toneColor }]}>{status.text}</Text>
        </View>
        {s.connection === 'disconnected' && (
          <Button title="Try again" variant="secondary" onPress={() => session.retryNow()} style={styles.retry} />
        )}
      </View>

      <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
        <View style={styles.cardHeader}>
          <Text style={[styles.caption, { color: t.muted }]}>TARGET</Text>
          <View style={[styles.segment, { borderColor: t.border }]}>
            {(['C', 'F'] as const).map((u) => (
              <Pressable
                key={u}
                accessibilityRole="button"
                accessibilityState={{ selected: unit === u }}
                onPress={() => switchUnit(u)}
                style={[styles.segmentItem, unit === u && { backgroundColor: t.accentSoft }]}
              >
                <Text style={{ color: unit === u ? t.accent : t.muted, fontWeight: '600' }}>°{u}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.stepper}>
          <StepButton label="−" onStep={() => step(-1)} disabled={target <= min} t={t} />
          <Text style={[styles.target, { color: t.text }]}>
            {target.toFixed(unit === 'C' ? 1 : 0)}°{unit}
          </Text>
          <StepButton label="+" onStep={() => step(1)} disabled={target >= max} t={t} />
        </View>
      </View>

      <View style={styles.actions}>
        {!s.cooking ? (
          <Button title={`Start at ${formatTemp(targetC, unit)}`} onPress={start} disabled={!connected} loading={busy} />
        ) : (
          <>
            {targetChanged && (
              <Button title={`Change to ${formatTemp(targetC, unit)}`} onPress={start} disabled={!connected} loading={busy} />
            )}
            <Button title="Stop" variant="danger" onPress={stop} disabled={!connected || busy} />
          </>
        )}
      </View>

      <Pressable onPress={forget} style={styles.forget}>
        <Text style={{ color: t.muted }}>Forget this Joule</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 20, fontWeight: '700', flexShrink: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  reading: { alignItems: 'center', paddingVertical: 12, gap: 6 },
  caption: { fontSize: 13, fontWeight: '600', letterSpacing: 1.2 },
  water: { fontSize: 64, fontWeight: '300', fontVariant: ['tabular-nums'] },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  status: { fontSize: 17, fontWeight: '500', textAlign: 'center', flexShrink: 1 },
  retry: { marginTop: 8, minHeight: 44 },
  card: { borderWidth: 1, borderRadius: 20, padding: 20, gap: 16 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  segment: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  segmentItem: { paddingHorizontal: 14, paddingVertical: 6 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepButton: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  stepLabel: { fontSize: 32, fontWeight: '500', marginTop: -2 },
  target: { fontSize: 44, fontWeight: '600', fontVariant: ['tabular-nums'] },
  actions: { gap: 12 },
  forget: { marginTop: 'auto', alignSelf: 'center', padding: 12 },
});
