import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { send } from '@/engine/index';
import { isIndonesian, t } from '@/lib/i18n';
import { PrimaryButton } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/theme';

/** First launch: start offline in one tap, try sample data, or connect to a server. */
export default function Welcome() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const create = async (demo: boolean) => {
    setBusy(true);
    try {
      await send('file-create', { name: demo ? 'Demo Budget' : isIndonesian ? 'Budget saya' : 'My Budget', demo });
      router.replace('/');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: th.bg, padding: space.xl, paddingTop: insets.top + 80, paddingBottom: insets.bottom + space.xl }}>
      <View style={{ width: 72, height: 72, borderRadius: 20, backgroundColor: th.accent, alignItems: 'center', justifyContent: 'center' }}>
        <SymbolView name="envelope.fill" size={36} tintColor="#FFFFFF" />
      </View>
      <Text style={{ color: th.text, fontSize: 34, fontWeight: '800', marginTop: space.xl }}>{t.welcomeTitle}</Text>
      <Text style={{ color: th.text2, fontSize: 17, marginTop: space.md, lineHeight: 24 }}>{t.welcomeBody}</Text>
      <Text style={{ color: th.text3, marginTop: space.sm }}>inthiseconomygenz.id</Text>
      <View style={{ flex: 1 }} />
      {busy ? <ActivityIndicator style={{ marginBottom: space.lg }} /> : null}
      <PrimaryButton title={t.startNew} onPress={() => void create(false)} disabled={busy} />
      <Pressable
        onPress={() => void create(true)}
        disabled={busy}
        style={{ marginTop: space.md, paddingVertical: 16, borderRadius: radius.pill, alignItems: 'center', backgroundColor: th.surface }}
        accessibilityRole="button">
        <Text style={{ color: th.text, fontSize: 17, fontWeight: '600' }}>{t.tryDemo}</Text>
      </Pressable>
      <Pressable onPress={() => router.push('/server')} style={{ marginTop: space.lg, alignItems: 'center' }} accessibilityRole="button">
        <Text style={{ color: th.accent, fontWeight: '600' }}>{t.signInServer}</Text>
      </Pressable>
    </View>
  );
}
