import { ScrollView, Text, View } from 'react-native';
import { dates, periodRange, type MonthBudget } from '@envelope/core';
import { useEngineQuery } from '@/engine/provider';
import { t } from '@/lib/i18n';
import { monthTitle } from '@/lib/money';
import { useCurrentPeriod, useStartDay } from '@/lib/periods';
import { AddButton, Card, Money } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/theme';

const TABLES = ['transactions', 'zero_budgets', 'categories', 'preferences'];

export default function Reports() {
  const th = useTheme();
  const startDay = useStartDay();
  const month = useCurrentPeriod();
  const prev = dates.addMonths(month, -1);
  const { start, end } = periodRange(month, startDay);
  const { data: cur } = useEngineQuery<MonthBudget>('budget-month', { month }, TABLES);
  const { data: last } = useEngineQuery<MonthBudget>('budget-month', { month: prev }, TABLES);
  const { data: report } = useEngineQuery<{ rows: { id: string; name: string; total: number }[] }>(
    'report-custom',
    { start, end, groupBy: 'category', interval: 'total', type: 'expense' },
    TABLES,
  );
  const spent = -(cur?.totalSpent ?? 0);
  const spentLast = -(last?.totalSpent ?? 0);
  const diff = spent - spentLast;
  const top = (report?.rows ?? []).slice(0, 6);
  const max = Math.max(1, ...top.map(r => r.total));
  const income = cur?.income ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, paddingBottom: 140, gap: space.md }}>
        <Text style={{ color: th.text, fontSize: 34, fontWeight: '700', marginTop: space.sm }} accessibilityRole="header">
          {t.reports}
        </Text>
        <Text style={{ color: th.text3, textTransform: 'capitalize' }}>{monthTitle(month)}</Text>

        <Card>
          <Text style={{ color: th.text2, fontWeight: '500' }}>{t.spentThisPeriod}</Text>
          <Money cents={spent} style={{ fontSize: 32, fontWeight: '700', marginTop: 4 }} />
          {last ? (
            <Text style={{ color: diff > 0 ? th.neg : th.pos, marginTop: 4 }}>
              {t.vsLast((diff > 0 ? '+' : '') + new Intl.NumberFormat('id-ID').format(Math.round(diff / 100)))}
            </Text>
          ) : null}
        </Card>

        <Card style={{ gap: space.md }}>
          <Text style={{ color: th.text, fontWeight: '700' }}>{t.topCategories}</Text>
          {top.map(r => (
            <View key={r.id} style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: th.text }} numberOfLines={1}>
                  {r.name}
                </Text>
                <Money cents={r.total} short style={{ color: th.text2, fontWeight: '600' }} />
              </View>
              <View style={{ height: 8, borderRadius: radius.pill, backgroundColor: th.surface2, overflow: 'hidden' }}>
                <View style={{ width: `${(r.total / max) * 100}%`, height: '100%', borderRadius: radius.pill, backgroundColor: th.accent }} />
              </View>
            </View>
          ))}
          {!top.length ? <Text style={{ color: th.text3 }}>{t.noTransactions}</Text> : null}
        </Card>

        <Card style={{ gap: space.sm }}>
          <Text style={{ color: th.text, fontWeight: '700' }}>{t.incomeVsSpending}</Text>
          {[
            [t.income, income, th.pos],
            [t.spent, spent, th.neg],
          ].map(([label, value, color]) => (
            <View key={label as string} style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: th.text2 }}>{label as string}</Text>
                <Money cents={value as number} short style={{ color: th.text, fontWeight: '600' }} />
              </View>
              <View style={{ height: 10, borderRadius: radius.pill, backgroundColor: th.surface2, overflow: 'hidden' }}>
                <View style={{ width: `${Math.min(100, ((value as number) / Math.max(1, income, spent)) * 100)}%`, height: '100%', backgroundColor: color as string }} />
              </View>
            </View>
          ))}
        </Card>
      </ScrollView>
      <AddButton />
    </View>
  );
}
