import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { q, type AccountEntity, type CategoryGroupEntity, type PayeeEntity, type TransactionEntity } from '@envelope/core';
import { send, storage } from '@/engine/index';
import { useEngineQuery, useEngineState } from '@/engine/provider';
import { t } from '@/lib/i18n';
import { addDaysISO, dayLabel, formatMoney, parseAmountInput, todayISO } from '@/lib/money';
import { showToast } from '@/lib/toast';
import { Chip, PrimaryButton } from '@/ui/components';
import { Keypad } from '@/ui/keypad';
import { radius, space, useTheme } from '@/ui/theme';

type Kind = 'expense' | 'income';

export default function AddTransaction() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const { prefs } = useEngineState();
  const params = useLocalSearchParams<{ id?: string; account?: string }>();
  const editId = params.id ?? null;

  const { data: accounts } = useEngineQuery<AccountEntity[]>('accounts-get', {}, ['accounts']);
  const { data: groups } = useEngineQuery<CategoryGroupEntity[]>('categories-get', {}, ['categories', 'category_groups']);
  const { data: payees } = useEngineQuery<PayeeEntity[]>('payees-get', {}, ['payees']);
  const { data: common } = useEngineQuery<string[]>('payees-common', {}, ['transactions', 'payees']);

  const [kind, setKind] = useState<Kind>('expense');
  const [amountText, setAmountText] = useState('');
  const [payee, setPayee] = useState<{ id: string | null; name: string } | null>(null);
  const [payeeQuery, setPayeeQuery] = useState('');
  const [editingPayee, setEditingPayee] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(params.account ?? null);
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const open = (accounts ?? []).filter(a => !a.closed);
  const onBudget = open.filter(a => !a.offbudget);

  // Default account: the one used last time, else the first on-budget account.
  useEffect(() => {
    if (account || !accounts) return;
    void storage.getItem('lastAccount').then(id => {
      const pick = open.find(a => a.id === id) ?? onBudget[0] ?? open[0];
      if (pick) setAccount(pick.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  // Editing: load the transaction once.
  useEffect(() => {
    if (!editId) return;
    void send<TransactionEntity | null>('transaction-get', { id: editId }).then(tx => {
      if (!tx) return;
      setKind(tx.amount > 0 ? 'income' : 'expense');
      setAmountText(String(Math.abs(tx.amount) / 100).replace('.', ','));
      setAccount(tx.account);
      setDate(tx.date);
      setNotes(tx.notes ?? '');
      setCategory(tx.category);
      const p = tx.payee ? payees?.find(x => x.id === tx.payee) : null;
      if (p) setPayee({ id: p.id, name: p.name });
    });
  }, [editId, payees]);

  const accountName = (id: string | null) => (accounts ?? []).find(a => a.id === id)?.name ?? '';
  const payeeLabel = (p: PayeeEntity) => (p.transfer_acct ? `Transfer: ${accountName(p.transfer_acct)}` : p.name);

  // Suggestions: common payees first; while typing, every match (transfers too).
  const suggestions = useMemo(() => {
    const all = (payees ?? []).filter(p => !p.transfer_acct || p.transfer_acct !== account);
    const typed = payeeQuery.trim().toLowerCase();
    if (typed) return all.filter(p => payeeLabel(p).toLowerCase().includes(typed)).slice(0, 8);
    const byId = new Map(all.map(p => [p.id, p]));
    return (common ?? []).map(id => byId.get(id)).filter((p): p is PayeeEntity => !!p && !p.transfer_acct).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payees, common, payeeQuery, account, accounts]);

  const selectedPayee = payee?.id ? (payees ?? []).find(p => p.id === payee.id) : null;
  const transferTo = selectedPayee?.transfer_acct ? (accounts ?? []).find(a => a.id === selectedPayee.transfer_acct) : null;
  const thisAccount = (accounts ?? []).find(a => a.id === account);
  // Moving money between two on-budget accounts needs no category.
  const needsCategory = !(transferTo && !transferTo.offbudget && thisAccount && !thisAccount.offbudget) && !thisAccount?.offbudget;

  const categories = useMemo(() => {
    const list = (groups ?? []).filter(g => !g.hidden && !!g.is_income === (kind === 'income')).flatMap(g => g.categories.filter(c => !c.hidden));
    return category ? [...list.filter(c => c.id === category), ...list.filter(c => c.id !== category)] : list;
  }, [groups, kind, category]);

  const pickPayee = async (p: PayeeEntity) => {
    setPayee({ id: p.id, name: payeeLabel(p) });
    setPayeeQuery('');
    setEditingPayee(false);
    if (p.transfer_acct) return setCategory(null);
    // The category this payee was used with most recently (the learned rule also applies on save).
    const { data } = await send('query', {
      query: q('transactions').filter({ payee: p.id, category: { $ne: null } }).orderBy({ date: 'desc' }).limit(1).select(['category']).serialize(),
    });
    if (data?.[0]?.category) setCategory(data[0].category);
  };

  const cents = parseAmountInput(amountText) ?? 0;

  const save = async (another: boolean) => {
    if (!cents || !account) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setSaving(true);
    try {
      const typedName = editingPayee ? payeeQuery.trim() : '';
      const body: Record<string, unknown> = {
        account,
        date,
        amount: kind === 'expense' ? -cents : cents,
        notes: notes.trim() || null,
        category: needsCategory ? category : null,
      };
      if (payee?.id) body.payee = payee.id;
      else if (typedName || payee?.name) body.payee_name = typedName || payee?.name;
      if (editId) await send('transaction-update', { id: editId, ...body });
      else await send('transaction-add', body);
      await storage.setItem('lastAccount', account);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const label = `${t.saved} · ${formatMoney(kind === 'expense' ? -cents : cents, prefs)}`;
      if (another && !editId) {
        setAmountText('');
        setPayee(null);
        setPayeeQuery('');
        setCategory(null);
        setNotes('');
        showToast(label, { label: t.undo, run: () => void send('undo') });
      } else {
        router.back();
        showToast(label, { label: t.undo, run: () => void send('undo') });
      }
    } catch (e: any) {
      Alert.alert('Error', e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = () =>
    Alert.alert(t.delete, undefined, [
      { text: t.cancel, style: 'cancel' },
      {
        text: t.delete,
        style: 'destructive',
        onPress: async () => {
          await send('transaction-delete', { id: editId });
          router.back();
          showToast(t.delete, { label: t.undo, run: () => void send('undo') });
        },
      },
    ]);

  const sectionLabel = (text: string) => <Text style={{ color: th.text3, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>{text}</Text>;

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: space.md }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg }}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button">
          <Text style={{ color: th.accent, fontSize: 17 }}>{t.cancel}</Text>
        </Pressable>
        <Text style={{ color: th.text, fontSize: 17, fontWeight: '600' }}>{editId ? t.editTitle : t.addTitle}</Text>
        {editId ? (
          <Pressable onPress={remove} hitSlop={10} accessibilityRole="button">
            <Text style={{ color: th.neg, fontSize: 17 }}>{t.delete}</Text>
          </Pressable>
        ) : (
          <View style={{ width: 48 }} />
        )}
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        {/* Expense / income */}
        <View style={{ flexDirection: 'row', backgroundColor: th.surface2, borderRadius: radius.pill, padding: 3 }}>
          {(['expense', 'income'] as Kind[]).map(k => (
            <Pressable
              key={k}
              onPress={() => {
                void Haptics.selectionAsync();
                setKind(k);
                setCategory(null);
              }}
              style={{ flex: 1, paddingVertical: 8, borderRadius: radius.pill, alignItems: 'center', backgroundColor: kind === k ? th.surface : 'transparent' }}
              accessibilityRole="button"
              accessibilityState={{ selected: kind === k }}>
              <Text style={{ color: kind === k ? th.text : th.text2, fontWeight: '600' }}>{k === 'expense' ? t.expense : t.incomeKind}</Text>
            </Pressable>
          ))}
        </View>

        {/* Amount */}
        <View style={{ alignItems: 'center', paddingVertical: space.sm }}>
          <Text
            style={{ color: kind === 'expense' ? th.text : th.pos, fontSize: 44, fontWeight: '700', fontVariant: ['tabular-nums'] }}
            adjustsFontSizeToFit
            numberOfLines={1}
            accessibilityLabel={formatMoney(cents, prefs)}>
            {kind === 'expense' && cents ? '−' : ''}
            {formatMoney(cents, prefs)}
          </Text>
          {/[+a-z]/.test(amountText) ? <Text style={{ color: th.text3 }}>{amountText}</Text> : null}
        </View>

        {/* Payee */}
        {sectionLabel(t.payee)}
        {editingPayee || !payee ? (
          <TextInput
            value={payeeQuery}
            onChangeText={v => {
              setPayeeQuery(v);
              setEditingPayee(true);
              setPayee(null);
            }}
            placeholder={t.payeePlaceholder}
            placeholderTextColor={th.text3}
            onFocus={() => setEditingPayee(true)}
            autoCorrect={false}
            style={{ backgroundColor: th.surface, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: th.text }}
          />
        ) : (
          <Chip label={payee.name} selected icon="person.fill" onPress={() => setEditingPayee(true)} />
        )}
        {!payee || editingPayee ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
            {suggestions.map(p => (
              <Chip key={p.id} label={payeeLabel(p)} onPress={() => void pickPayee(p)} />
            ))}
          </ScrollView>
        ) : null}

        {/* Category */}
        {needsCategory ? (
          <>
            {sectionLabel(t.category)}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {categories.map(c => (
                <Chip key={c.id} label={c.name} selected={c.id === category} onPress={() => setCategory(c.id === category ? null : c.id)} />
              ))}
            </ScrollView>
          </>
        ) : null}

        {/* Account and date */}
        {sectionLabel(`${t.account} · ${t.date}`)}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {open.map(a => (
            <Chip key={a.id} label={a.name} selected={a.id === account} onPress={() => setAccount(a.id)} />
          ))}
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Chip label={t.today} selected={date === todayISO()} onPress={() => setDate(todayISO())} />
          <Chip label={t.yesterday} selected={date === addDaysISO(todayISO(), -1)} onPress={() => setDate(addDaysISO(todayISO(), -1))} />
          <Chip label="‹" onPress={() => setDate(addDaysISO(date, -1))} />
          <Text style={{ color: th.text2, minWidth: 90, textAlign: 'center' }}>{dayLabel(date)}</Text>
          <Chip label="›" onPress={() => setDate(addDaysISO(date, 1))} />
        </View>

        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder={t.notesPlaceholder}
          placeholderTextColor={th.text3}
          style={{ backgroundColor: th.surface, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: th.text }}
        />
      </ScrollView>

      {/* Keypad and save, in the thumb zone */}
      <View style={{ padding: space.lg, paddingBottom: insets.bottom + space.md, gap: space.md, backgroundColor: th.bg }}>
        <Keypad value={amountText} onChange={setAmountText} />
        <PrimaryButton title={t.save} onPress={() => void save(false)} disabled={!cents || !account || saving} />
        {!editId ? (
          <Pressable onPress={() => void save(true)} disabled={!cents || saving} style={{ alignItems: 'center' }} accessibilityRole="button">
            <Text style={{ color: th.accent, fontWeight: '600', opacity: cents ? 1 : 0.4 }}>{t.saveAnother}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
