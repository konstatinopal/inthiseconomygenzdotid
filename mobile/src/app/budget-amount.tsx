import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MonthBudget } from '@envelope/core';
import { send } from '@/engine/index';
import { useEngineQuery, useEngineState } from '@/engine/provider';
import { t } from '@/lib/i18n';
import { formatMoney, monthTitle, parseAmountInput } from '@/lib/money';
import { Chip, Money, PrimaryButton } from '@/ui/components';
import { Keypad } from '@/ui/keypad';
import { space, useTheme } from '@/ui/theme';

/** Set how much a category gets this period, with the same keypad as entry. */
export default function BudgetAmount() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const { prefs } = useEngineState();
  const { month, category, name } = useLocalSearchParams<{ month: string; category: string; name: string }>();
  const { data: m } = useEngineQuery<MonthBudget>('budget-month', { month }, ['zero_budgets', 'transactions', 'reflect_budgets']);
  const v = m?.categories[category];
  // Start from the current amount until the user types.
  const [edited, setText] = useState<string | null>(null);
  const text = edited ?? (v?.budgeted ? String(v.budgeted / 100).replace('.', ',') : '');
  const cents = parseAmountInput(text) ?? 0;
  const newBalance = v ? v.balance - v.budgeted + cents : 0;

  const save = async () => {
    await send('budget-set-amount', { month, category, amount: cents });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };
  const action = async (a: 'copy-last' | 'avg-3') => {
    await send('budget-category-action', { month, category, action: a });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, padding: space.lg, paddingBottom: insets.bottom + space.md, gap: space.md }}>
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Text style={{ color: th.text, fontSize: 20, fontWeight: '700' }}>{name}</Text>
        <Text style={{ color: th.text3, textTransform: 'capitalize' }}>{monthTitle(month)}</Text>
      </View>
      <View style={{ alignItems: 'center' }}>
        <Text style={{ color: th.text2 }}>{t.budgeted}</Text>
        <Text style={{ color: th.text, fontSize: 40, fontWeight: '700', fontVariant: ['tabular-nums'] }} adjustsFontSizeToFit numberOfLines={1}>
          {formatMoney(cents, prefs)}
        </Text>
        {v ? (
          <Text style={{ color: newBalance < 0 ? th.neg : th.text2 }}>
            {t.available}: <Money cents={newBalance} style={{ color: newBalance < 0 ? th.neg : th.text2 }} />
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
        <Chip label={t.copyLast} icon="arrow.uturn.backward" onPress={() => void action('copy-last')} />
        <Chip label={t.avg3} icon="chart.line.flattrend.xyaxis" onPress={() => void action('avg-3')} />
      </View>
      <View style={{ flex: 1 }} />
      <Keypad value={text} onChange={setText} />
      <PrimaryButton title={t.save} onPress={() => void save()} />
      <Pressable onPress={() => router.back()} style={{ alignItems: 'center' }}>
        <Text style={{ color: th.accent }}>{t.cancel}</Text>
      </Pressable>
    </View>
  );
}
