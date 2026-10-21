import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { dates, goalStatus, type CategoryGroupEntity, type MonthBudget } from '@envelope/core';
import { useEngineQuery, useEngineState, useSyncRefresh } from '@/engine/provider';
import { t } from '@/lib/i18n';
import { monthTitle } from '@/lib/money';
import { rangeLabel, useCurrentPeriod, useStartDay } from '@/lib/periods';
import { AddButton, BalancePill, Card, Money, SyncPill } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/theme';

type Month = MonthBudget & { goals?: Record<string, { target: number | null; longGoal: number | null }> };
const TABLES = ['transactions', 'zero_budgets', 'reflect_budgets', 'zero_budget_months', 'categories', 'category_groups', 'notes', 'preferences', 'accounts'];

export default function BudgetScreen() {
  const th = useTheme();
  const { prefs } = useEngineState();
  const startDay = useStartDay();
  const current = useCurrentPeriod();
  const [picked, setPicked] = useState<string | null>(null);
  const month = picked ?? current;
  const { refreshing, onRefresh } = useSyncRefresh();
  const { data: m } = useEngineQuery<Month>('budget-month', { month }, TABLES);
  const { data: groups } = useEngineQuery<CategoryGroupEntity[]>('categories-get', {}, ['categories', 'category_groups']);
  const tracking = prefs.budgetType === 'tracking';

  const visible = useMemo(() => (groups ?? []).filter(g => !g.hidden).map(g => ({ ...g, categories: g.categories.filter(c => !c.hidden) })), [groups]);
  const shift = (n: number) => {
    void Haptics.selectionAsync();
    setPicked(dates.addMonths(month, n));
  };
  const range = rangeLabel(month, startDay);
  const toBudget = m?.toBudget ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: space.lg, paddingBottom: 140, gap: space.md }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        }>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm }}>
          <Text style={{ color: th.text, fontSize: 34, fontWeight: '700' }} accessibilityRole="header">
            {t.budget}
          </Text>
          <SyncPill />
        </View>

        {/* Period switcher: chevrons, and the period's real dates when it doesn't start on the 1st. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Pressable onPress={() => shift(-1)} hitSlop={12} accessibilityLabel="Previous month">
            <SymbolView name="chevron.left" size={20} tintColor={th.accent} />
          </Pressable>
          <Pressable onPress={() => setPicked(null)} style={{ alignItems: 'center' }} accessibilityHint="Go to the current period">
            <Text style={{ color: month === current ? th.accent : th.text, fontSize: 18, fontWeight: '600', textTransform: 'capitalize' }}>{monthTitle(month)}</Text>
            {range ? <Text style={{ color: th.text3, fontSize: 13 }}>{range}</Text> : null}
          </Pressable>
          <Pressable onPress={() => shift(1)} hitSlop={12} accessibilityLabel="Next month">
            <SymbolView name="chevron.right" size={20} tintColor={th.accent} />
          </Pressable>
        </View>

        {/* Hero: how much is still to assign. */}
        {m && !tracking ? (
          <View
            style={{
              borderRadius: radius.lg,
              padding: space.xl,
              backgroundColor: toBudget > 0 ? th.posStrong : toBudget < 0 ? th.neg : th.surface,
              borderWidth: toBudget === 0 ? 1 : 0,
              borderColor: th.border,
            }}>
            <Text style={{ color: toBudget === 0 ? th.text2 : 'rgba(255,255,255,0.9)', fontWeight: '500' }}>{toBudget < 0 ? t.overbudgeted : t.toBudget}</Text>
            <Money cents={toBudget} style={{ color: toBudget === 0 ? th.text : '#FFFFFF', fontSize: 36, fontWeight: '700', marginTop: 4 }} />
            <View style={{ flexDirection: 'row', gap: space.lg, marginTop: space.sm }}>
              <Text style={{ color: toBudget === 0 ? th.text3 : 'rgba(255,255,255,0.85)', fontSize: 13 }}>
                {t.income} <Money cents={m.income} short style={{ color: toBudget === 0 ? th.text3 : 'rgba(255,255,255,0.85)', fontSize: 13 }} />
              </Text>
              <Text style={{ color: toBudget === 0 ? th.text3 : 'rgba(255,255,255,0.85)', fontSize: 13 }}>
                {t.budgeted} <Money cents={m.totalBudgeted} short style={{ color: toBudget === 0 ? th.text3 : 'rgba(255,255,255,0.85)', fontSize: 13 }} />
              </Text>
            </View>
          </View>
        ) : null}

        {m
          ? visible.map(g => {
              const total = m.groups[g.id];
              return (
                <Card key={g.id} style={{ padding: 0, overflow: 'hidden' }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}>
                    <Text style={{ color: th.text, fontWeight: '700', fontSize: 15 }}>{g.name}</Text>
                    {total ? <Money cents={g.is_income ? total.spent : total.balance} short style={{ color: th.text2, fontWeight: '600' }} /> : null}
                  </View>
                  {g.categories.map(c => {
                    const v = m.categories[c.id];
                    if (!v) return null;
                    const status = goalStatus(v.balance, v.budgeted, m.goals?.[c.id]);
                    return (
                      <Pressable
                        key={c.id}
                        onPress={() => !g.is_income && router.push({ pathname: '/budget-amount', params: { month, category: c.id, name: c.name } })}
                        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: 11, backgroundColor: pressed ? th.surface2 : 'transparent' })}
                        accessibilityRole={g.is_income ? undefined : 'button'}
                        accessibilityHint={g.is_income ? undefined : t.setBudget}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={{ color: th.text, fontSize: 16 }} numberOfLines={1}>
                            {c.name}
                          </Text>
                          <Text style={{ color: th.text3, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                            {g.is_income ? (
                              <>
                                {t.received} <Money cents={v.spent} short style={{ color: th.text3, fontSize: 12 }} />
                              </>
                            ) : (
                              <>
                                {t.budgeted} <Money cents={v.budgeted} short style={{ color: th.text3, fontSize: 12 }} /> · {t.spent}{' '}
                                <Money cents={-v.spent} short style={{ color: th.text3, fontSize: 12 }} />
                              </>
                            )}
                          </Text>
                        </View>
                        {g.is_income ? null : <BalancePill cents={v.balance} status={status} />}
                      </Pressable>
                    );
                  })}
                </Card>
              );
            })
          : null}
      </ScrollView>
      <AddButton />
    </View>
  );
}
