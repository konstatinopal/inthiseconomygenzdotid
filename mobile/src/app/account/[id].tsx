import { useMemo } from 'react';
import { Alert, Pressable, RefreshControl, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import type { AccountEntity, CategoryGroupEntity, PayeeEntity, TransactionEntity } from '@envelope/core';
import { send } from '@/engine/index';
import { useEngineQuery, useSyncRefresh } from '@/engine/provider';
import { t } from '@/lib/i18n';
import { dayLabel } from '@/lib/money';
import { showToast } from '@/lib/toast';
import { AddButton, Empty, Money } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

type Item = { type: 'day'; key: string; date: string; total: number } | { type: 'txn'; key: string; t: TransactionEntity };

/** Combined registers: every open account, on-budget or off-budget accounts. */
const COMBINED = { all: null, onbudget: 'onbudget', offbudget: 'offbudget' } as const;

/** An account's register (or a combined one, or the "needs attention" list), grouped by day and virtualised. */
export default function Register() {
  const th = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const attention = id === 'attention';
  const combined = id in COMBINED;
  const multi = combined || attention;
  const { refreshing, onRefresh } = useSyncRefresh();
  const { data: accounts } = useEngineQuery<AccountEntity[]>('accounts-get', {}, ['accounts', 'transactions']);
  const { data: payees } = useEngineQuery<PayeeEntity[]>('payees-get', {}, ['payees']);
  const { data: groups } = useEngineQuery<CategoryGroupEntity[]>('categories-get', {}, ['categories']);
  const { data: txns } = useEngineQuery<TransactionEntity[]>(
    'transactions-get',
    attention
      ? { account: 'onbudget', filter: { conditionsOp: 'and', conditions: [{ field: 'category', op: 'is', value: null }, { field: 'transfer', op: 'is', value: false }] } }
      : { account: combined ? COMBINED[id as keyof typeof COMBINED] : id },
    ['transactions', 'payees', 'categories'],
  );
  const account = accounts?.find(a => a.id === id);
  const accountName = useMemo(() => {
    const m = new Map((accounts ?? []).map(a => [a.id, a.name]));
    return (aid: string) => m.get(aid) ?? '';
  }, [accounts]);
  const title = attention ? t.needsAttention : id === 'all' ? t.allAccounts : id === 'onbudget' ? t.onBudget : id === 'offbudget' ? t.offBudget : account?.name ?? '';
  // Header balance: the account itself, or the sum of the open accounts in the combined view.
  const balance = account
    ? account.balance
    : combined
      ? (accounts ?? []).filter(a => !a.closed && (id === 'all' || (id === 'offbudget') === !!a.offbudget)).reduce((s, a) => s + a.balance, 0)
      : null;
  const payeeName = useMemo(() => {
    const accts = new Map((accounts ?? []).map(a => [a.id, a.name]));
    const m = new Map((payees ?? []).map(p => [p.id, p.transfer_acct ? `Transfer: ${accts.get(p.transfer_acct) ?? ''}` : p.name]));
    return (pid: string | null) => (pid ? m.get(pid) ?? '' : '');
  }, [payees, accounts]);
  const catName = useMemo(() => {
    const m = new Map((groups ?? []).flatMap(g => g.categories.map(c => [c.id, c.name] as const)));
    return (cid: string | null) => (cid ? m.get(cid) ?? '' : '');
  }, [groups]);

  const items = useMemo(() => {
    // One pass: a day header, then that day's transactions (newest first).
    const out: Item[] = [];
    let header: Extract<Item, { type: 'day' }> | null = null;
    for (const tx of txns ?? []) {
      if (attention && tx.starting_balance_flag) continue;
      if (!header || header.date !== tx.date) {
        header = { type: 'day', key: 'd' + tx.date, date: tx.date, total: 0 };
        out.push(header);
      }
      header.total += tx.amount;
      out.push({ type: 'txn', key: tx.id, t: tx });
    }
    return out;
  }, [txns, attention]);

  const toggleCleared = async (tx: TransactionEntity) => {
    if (tx.reconciled) return;
    void Haptics.selectionAsync();
    await send('transaction-update', { id: tx.id, cleared: !tx.cleared });
  };
  const longPress = (tx: TransactionEntity) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(payeeName(tx.payee) || t.noCategory, undefined, [
      { text: tx.cleared ? 'Uncleared' : 'Cleared', onPress: () => void toggleCleared(tx) },
      { text: 'Duplicate', onPress: () => void send('transactions-duplicate', { ids: [tx.id] }) },
      {
        text: t.delete,
        style: 'destructive',
        onPress: async () => {
          await send('transaction-delete', { id: tx.id });
          showToast(t.delete, { label: t.undo, run: () => void send('undo') });
        },
      },
      { text: t.cancel, style: 'cancel' },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <Stack.Screen options={{ title }} />
      {balance != null ? (
        <View style={{ padding: space.lg, paddingBottom: space.sm }}>
          <Text style={{ color: th.text2 }}>{title}</Text>
          <Money cents={balance} style={{ color: balance < 0 ? th.neg : th.text, fontSize: 32, fontWeight: '700' }} />
        </View>
      ) : null}
      <FlashList
        data={items}
        keyExtractor={i => i.key}
        getItemType={i => i.type}
        contentContainerStyle={{ paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={txns ? <Empty title={t.noTransactions} body={t.noTransactionsBody} /> : null}
        renderItem={({ item }) =>
          item.type === 'day' ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs }}>
              <Text style={{ color: th.text2, fontWeight: '600', textTransform: 'capitalize' }}>{dayLabel(item.date)}</Text>
              <Money cents={item.total} short style={{ color: th.text3 }} />
            </View>
          ) : (
            <Pressable
              onPress={() => router.push({ pathname: '/add', params: { id: item.t.id } })}
              onLongPress={() => longPress(item.t)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 11, backgroundColor: pressed ? th.surface2 : th.surface })}
              accessibilityRole="button">
              <Pressable onPress={() => void toggleCleared(item.t)} hitSlop={10} accessibilityLabel={item.t.cleared ? 'Cleared' : 'Not cleared'}>
                <SymbolView
                  name={item.t.reconciled ? 'lock.circle.fill' : item.t.cleared ? 'checkmark.circle.fill' : 'circle'}
                  size={20}
                  tintColor={item.t.reconciled ? th.text3 : item.t.cleared ? th.pos : th.text3}
                />
              </Pressable>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: th.text, fontSize: 16 }} numberOfLines={1}>
                  {payeeName(item.t.payee) || (item.t.starting_balance_flag ? 'Saldo awal' : item.t.imported_payee ?? '—')}
                </Text>
                <Text style={{ color: item.t.category || item.t.is_parent || item.t.transfer_id ? th.text3 : th.warn, fontSize: 13 }} numberOfLines={1}>
                  {item.t.is_parent ? 'Split' : item.t.transfer_id && !item.t.category ? 'Transfer' : catName(item.t.category) || t.noCategory}
                  {multi ? ` · ${accountName(item.t.account)}` : ''}
                  {item.t.notes ? ` · ${item.t.notes}` : ''}
                </Text>
              </View>
              <Money cents={item.t.amount} style={{ color: item.t.amount > 0 ? th.pos : th.text, fontWeight: '600', fontSize: 16 }} />
            </Pressable>
          )
        }
      />
      <AddButton account={multi ? undefined : id} />
    </View>
  );
}
