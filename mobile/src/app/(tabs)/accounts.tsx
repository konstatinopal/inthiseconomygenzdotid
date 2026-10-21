import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { periodRange, q, type AccountEntity } from '@envelope/core';
import { useEngineQuery, useSyncRefresh } from '@/engine/provider';
import { t } from '@/lib/i18n';
import { monthTitle } from '@/lib/money';
import { useCurrentPeriod, useStartDay } from '@/lib/periods';
import { AddButton, Card, ListRow, Money, SyncPill } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/theme';

const toInt = (d: string) => Number(d.replace(/-/g, ''));
const openRegister = (id: string) => router.push({ pathname: '/account/[id]', params: { id } });

export default function Accounts() {
  const th = useTheme();
  const { refreshing, onRefresh } = useSyncRefresh();
  const [showClosed, setShowClosed] = useState(false);
  const { data: accounts } = useEngineQuery<AccountEntity[]>('accounts-get', {}, ['accounts', 'transactions']);
  const onIds = (accounts ?? []).filter(a => !a.offbudget && !a.closed).map(a => a.id);
  // "Needs attention": on-budget spending with no category (e.g. recorded via WhatsApp without one).
  const { data: uncategorized } = useEngineQuery<{ data: number }>(
    onIds.length ? 'query' : null,
    { query: q('transactions').filter({ account: { $oneof: onIds }, category: null, transfer_id: null, starting_balance_flag: 0 }).calculate({ $count: '*' } as any).serialize() },
    ['transactions'],
  );

  // All accounts: money in and out this period, transfers between own accounts excluded.
  const month = useCurrentPeriod();
  const { start, end } = periodRange(month, useStartDay());
  const flow = (sign: '$gt' | '$lt') =>
    q('transactions')
      .filter({ date: { $gte: toInt(start), $lte: toInt(end) }, amount: { [sign]: 0 }, transfer_id: null, starting_balance_flag: 0 })
      .calculate({ $sum: 'amount' } as any)
      .serialize();
  const { data: inflow } = useEngineQuery<{ data: number }>('query', { query: flow('$gt') }, ['transactions']);
  const { data: outflow } = useEngineQuery<{ data: number }>('query', { query: flow('$lt') }, ['transactions']);
  const income = inflow?.data ?? 0;
  const expenses = -(outflow?.data ?? 0);

  const open = (accounts ?? []).filter(a => !a.closed);
  const total = open.reduce((s, a) => s + a.balance, 0);
  const groups: { id: 'onbudget' | 'offbudget' | 'closed'; title: string; list: AccountEntity[] }[] = [
    { id: 'onbudget', title: t.onBudget, list: open.filter(a => !a.offbudget) },
    { id: 'offbudget', title: t.offBudget, list: open.filter(a => a.offbudget) },
    { id: 'closed', title: t.closed, list: (accounts ?? []).filter(a => a.closed) },
  ];
  const attention = uncategorized?.data ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: space.lg, paddingBottom: 140, gap: space.md }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm }}>
          <Text style={{ color: th.text, fontSize: 34, fontWeight: '700' }} accessibilityRole="header">
            {t.accounts}
          </Text>
          <SyncPill />
        </View>

        <Pressable onPress={() => openRegister('all')} accessibilityRole="button" accessibilityLabel={t.allAccounts}>
          {({ pressed }) => (
            <Card style={{ gap: space.md, opacity: pressed ? 0.7 : 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <Text style={{ flex: 1, color: th.text, fontSize: 17, fontWeight: '700' }}>{t.allAccounts}</Text>
                <Money cents={total} style={{ color: total < 0 ? th.neg : th.pos, fontSize: 17, fontWeight: '700' }} />
                <SymbolView name="chevron.right" size={14} tintColor={th.text3} />
              </View>
              <View style={{ height: 1, backgroundColor: th.surface2 }} />
              <Text style={{ color: th.text3, textTransform: 'capitalize' }}>{monthTitle(month)}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm }}>
                {[
                  [t.income, income, th.text],
                  [t.expenses, expenses, th.text],
                  [t.net, income - expenses, income - expenses < 0 ? th.neg : th.pos],
                ].map(([label, value, color], i) => (
                  <View key={i} style={{ flex: 1, alignItems: i === 0 ? 'flex-start' : i === 1 ? 'center' : 'flex-end' }}>
                    <Text style={{ color: th.text3, fontSize: 13 }}>{label as string}</Text>
                    <Money cents={value as number} short style={{ color: color as string, fontWeight: '700', fontSize: 16 }} />
                  </View>
                ))}
              </View>
            </Card>
          )}
        </Pressable>

        {attention > 0 ? (
          <Pressable
            onPress={() => openRegister('attention')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: th.warnSoft, borderRadius: radius.lg, padding: space.lg }}
            accessibilityRole="button">
            <SymbolView name="exclamationmark.circle.fill" size={22} tintColor={th.warn} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: th.text, fontWeight: '600' }}>{t.needsAttention}</Text>
              <Text style={{ color: th.text2 }}>{t.needsAttentionBody(attention)}</Text>
            </View>
            <SymbolView name="chevron.right" size={16} tintColor={th.text3} />
          </Pressable>
        ) : null}

        {groups
          .filter(g => g.list.length)
          .map(g => {
            const closed = g.id === 'closed';
            const expanded = !closed || showClosed;
            return (
              <Card key={g.id} style={{ padding: 0, overflow: 'hidden' }}>
                {/* Group header: opens that group's combined register (closed accounts just expand). */}
                <Pressable
                  onPress={() => (closed ? setShowClosed(v => !v) : openRegister(g.id))}
                  accessibilityRole="button"
                  style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: expanded ? space.xs : space.md, opacity: pressed ? 0.6 : 1 })}>
                  <Text style={{ flex: 1, color: th.text2, fontWeight: '600' }}>{g.title}</Text>
                  <Money cents={g.list.reduce((s, a) => s + a.balance, 0)} style={{ color: th.text2, fontWeight: '600' }} />
                  <SymbolView name={closed ? (showClosed ? 'chevron.down' : 'chevron.right') : 'chevron.right'} size={12} tintColor={th.text3} />
                </Pressable>
                {expanded
                  ? g.list.map(a => (
                      <ListRow
                        key={a.id}
                        title={a.name}
                        onPress={() => openRegister(a.id)}
                        right={<Money cents={a.balance} style={{ color: a.balance < 0 ? th.neg : th.text, fontWeight: '600', fontSize: 16 }} />}
                        accessibilityRole="button"
                      />
                    ))
                  : null}
              </Card>
            );
          })}
      </ScrollView>
      <AddButton />
    </View>
  );
}
