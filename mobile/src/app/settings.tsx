import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { currentPeriod, dates, MAX_START_DAY, periodRange } from '@envelope/core';
import { send, storage } from '@/engine/index';
import { t } from '@/lib/i18n';
import { monthTitle } from '@/lib/money';
import { useStartDay } from '@/lib/periods';
import { Card } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/theme';

const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });

export default function Settings() {
  const th = useTheme();
  const startDay = useStartDay();
  const [lock, setLock] = useState(false);
  useEffect(() => {
    void storage.getItem('appLock').then(v => setLock(v === '1'));
  }, []);

  const setDay = async (d: number) => {
    void Haptics.selectionAsync();
    await send('pref-set', { id: 'monthStartDay', value: d });
  };
  const toggleLock = async (on: boolean) => {
    if (on) {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: t.appLock });
      if (!r.success) return;
    }
    setLock(on);
    await storage.setItem('appLock', on ? '1' : null);
  };

  const cur = currentPeriod(startDay);
  const preview = [cur, dates.addMonths(cur, 1)].map(p => ({ p, ...periodRange(p, startDay) }));

  return (
    <ScrollView style={{ flex: 1, backgroundColor: th.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <Card style={{ gap: space.md }}>
        <Text style={{ color: th.text, fontWeight: '700', fontSize: 16 }}>{t.monthStart}</Text>
        <Text style={{ color: th.text2 }}>{t.monthStartBody}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xl }}>
          <Pressable onPress={() => void setDay(Math.max(1, startDay - 1))} style={stepper(th)} accessibilityLabel="Earlier day">
            <Text style={{ fontSize: 24, color: th.accent }}>−</Text>
          </Pressable>
          <Text style={{ color: th.text, fontSize: 28, fontWeight: '700', minWidth: 120, textAlign: 'center' }}>{t.dayOfMonth(startDay)}</Text>
          <Pressable onPress={() => void setDay(Math.min(MAX_START_DAY, startDay + 1))} style={stepper(th)} accessibilityLabel="Later day">
            <Text style={{ fontSize: 24, color: th.accent }}>+</Text>
          </Pressable>
        </View>
        {preview.map(x => (
          <View key={x.p} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: th.text, fontWeight: '600', textTransform: 'capitalize' }}>{monthTitle(x.p)}</Text>
            <Text style={{ color: th.text2 }}>
              {fmt(x.start)} – {fmt(x.end)}
            </Text>
          </View>
        ))}
      </Card>
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: th.text, fontWeight: '700', fontSize: 16 }}>{t.appLock}</Text>
          <Text style={{ color: th.text2 }}>{t.appLockBody}</Text>
        </View>
        <Switch value={lock} onValueChange={v => void toggleLock(v)} trackColor={{ true: th.accent }} />
      </Card>
    </ScrollView>
  );
}

const stepper = (th: ReturnType<typeof useTheme>) => ({
  width: 48,
  height: 48,
  borderRadius: radius.pill,
  backgroundColor: th.accentSoft,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
});
