import { useRef, useState, type ComponentRef } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import appConfig from '../../app.json';
import { ABOUT } from './aboutText';
import { Button } from './components';
import { useTheme, type Theme } from './theme';

const ICON = require('../../assets/icon.png');

/** Overflow (⋮) button with the app menu. */
export function AppMenu() {
  const t = useTheme();
  const button = useRef<ComponentRef<typeof View>>(null);
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  const openMenu = () => {
    button.current?.measureInWindow((_x, y, _width, height) => {
      // The menu modal covers the whole window, so window coordinates apply.
      setMenuAt({ top: y + height, right: 8 });
    });
  };

  const choose = (action: () => void) => {
    setMenuAt(null);
    action();
  };

  return (
    <>
      <Pressable
        ref={button}
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel="More options"
        hitSlop={8}
        style={({ pressed }) => [styles.menuButton, pressed && { backgroundColor: t.border }]}
      >
        {[0, 1, 2].map((i) => (
          <View key={i} style={[styles.dot, { backgroundColor: t.text }]} />
        ))}
      </Pressable>

      <Modal
        visible={menuAt !== null}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setMenuAt(null)}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuAt(null)} accessibilityLabel="Close menu" />
        {menuAt && (
          <View
            style={[
              styles.menu,
              { top: menuAt.top, right: menuAt.right, backgroundColor: t.card, borderColor: t.border },
            ]}
          >
            <MenuItem label="About…" onPress={() => choose(() => setAboutOpen(true))} t={t} />
          </View>
        )}
      </Modal>

      <AboutDialog visible={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}

function MenuItem({ label, onPress, t }: { label: string; onPress: () => void; t: Theme }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="menuitem"
      style={({ pressed }) => [styles.menuItem, pressed && { backgroundColor: t.accentSoft }]}
    >
      <Text style={[styles.menuLabel, { color: t.text }]}>{label}</Text>
    </Pressable>
  );
}

function AboutDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close About" />
        <View style={[styles.dialog, { backgroundColor: t.card }]} accessibilityViewIsModal>
          <ScrollView contentContainerStyle={styles.dialogContent}>
            <Image source={ICON} style={styles.icon} accessibilityIgnoresInvertColors />
            <Text style={[styles.appName, { color: t.text }]}>{appConfig.expo.name}</Text>
            <Text style={[styles.version, { color: t.muted }]}>Version {appConfig.expo.version}. Dmitry Brant, 2026.</Text>
            <Text style={[styles.tagline, { color: t.text }]}>{ABOUT.tagline}</Text>
            {ABOUT.sections.map((paragraph, i) => (
              <Text key={i} style={[styles.paragraph, { color: t.muted }]}>
                {paragraph}
              </Text>
            ))}
          </ScrollView>
          <Button title="Close" variant="secondary" onPress={onClose} style={styles.close} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  menuButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  dot: { width: 4.5, height: 4.5, borderRadius: 2.25 },
  menu: {
    position: 'absolute',
    minWidth: 180,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 6,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  menuItem: { paddingHorizontal: 18, paddingVertical: 14 },
  menuLabel: { fontSize: 16 },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: { width: '100%', maxWidth: 420, maxHeight: '85%', borderRadius: 20, padding: 20 },
  dialogContent: { alignItems: 'center', gap: 10, paddingBottom: 8 },
  icon: { width: 72, height: 72, borderRadius: 16, marginBottom: 4 },
  appName: { fontSize: 22, fontWeight: '700' },
  version: { fontSize: 14 },
  tagline: { fontSize: 16, lineHeight: 22, textAlign: 'center', marginTop: 6 },
  paragraph: { fontSize: 14, lineHeight: 20, alignSelf: 'stretch' },
  close: { marginTop: 12 },
});
