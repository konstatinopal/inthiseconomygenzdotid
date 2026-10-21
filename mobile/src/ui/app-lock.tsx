import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { SymbolView } from 'expo-symbols';
import { storage } from '@/engine/index';
import { t } from '@/lib/i18n';
import { useTheme } from './theme';

const LOCK_AFTER_MS = 60_000;

/**
 * PRD security: Face ID / passcode lock after a minute in the background, and
 * a privacy cover so the app switcher never shows balances.
 */
export function AppLock() {
  const th = useTheme();
  const [locked, setLocked] = useState(false);
  const [covered, setCovered] = useState(false);
  const leftAt = useRef<number | null>(null);

  const unlock = async () => {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: t.unlock, disableDeviceFallback: false });
    if (r.success) setLocked(false);
  };
  // Read the setting each time, so turning it on in Settings applies immediately.
  const lockIfEnabled = () =>
    void storage.getItem('appLock').then(v => {
      if (v !== '1') return;
      setLocked(true);
      void unlock();
    });

  useEffect(() => {
    lockIfEnabled();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setCovered(false);
        if (leftAt.current && Date.now() - leftAt.current > LOCK_AFTER_MS) {
          lockIfEnabled();
        }
        leftAt.current = null;
      } else {
        setCovered(true);
        leftAt.current ??= Date.now();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!covered && !(locked)) return null;
  return (
    <View style={{ position: 'absolute', inset: 0, backgroundColor: th.bg, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
      <SymbolView name="lock.fill" size={40} tintColor={th.text3} />
      {locked ? (
        <Pressable onPress={unlock} accessibilityRole="button" style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999, backgroundColor: th.accent }}>
          <Text style={{ color: th.onAccent, fontWeight: '600' }}>{t.unlock}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
