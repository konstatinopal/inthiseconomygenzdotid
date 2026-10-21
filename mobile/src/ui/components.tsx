import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { radius, space, useTheme } from './theme';
import { formatMoney, formatShort } from '@/lib/money';
import { useEngineState } from '@/engine/provider';

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ backgroundColor: t.surface, borderRadius: radius.lg, padding: space.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }, style]}>{children}</View>;
}

export function Label({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[{ color: t.text2, fontSize: 13, fontWeight: '500' }, style]}>{children}</Text>;
}

/** Money with the budget's currency settings. */
export function Money({ cents, short, sign, style }: { cents: number; short?: boolean; sign?: boolean; style?: StyleProp<TextStyle> }) {
  const { prefs } = useEngineState();
  const t = useTheme();
  const text = short ? formatShort(cents, prefs) : formatMoney(cents, prefs, { sign });
  return (
    <Text style={[{ color: t.text, fontVariant: ['tabular-nums'] }, style]} accessibilityLabel={text}>
      {text}
    </Text>
  );
}

/** Category balance pill: green funded, yellow underfunded, red overspent, grey zero. */
export function BalancePill({ cents, status }: { cents: number; status?: 'funded' | 'underfunded' | 'overspent' | null }) {
  const t = useTheme();
  const tone = cents < 0 || status === 'overspent' ? 'neg' : status === 'underfunded' ? 'warn' : cents > 0 ? 'pos' : 'zero';
  const bg = { neg: t.neg, warn: t.warnSoft, pos: t.posSoft, zero: 'transparent' }[tone];
  const fg = { neg: '#FFFFFF', warn: t.warn, pos: t.pos, zero: t.text3 }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, minWidth: 64, alignItems: 'flex-end' }}>
      <Money cents={cents} short style={{ color: fg, fontWeight: '600', fontSize: 14 }} />
    </View>
  );
}

export function Chip({ label, selected, onPress, icon }: { label: string; selected?: boolean; onPress?: () => void; icon?: string }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress?.();
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: radius.pill,
        backgroundColor: selected ? t.accent : t.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? t.accent : t.border,
        opacity: pressed ? 0.7 : 1,
      })}
      accessibilityRole="button"
      accessibilityState={{ selected }}>
      {icon ? <SymbolView name={icon as any} size={14} tintColor={selected ? t.onAccent : t.text2} /> : null}
      <Text style={{ color: selected ? t.onAccent : t.text, fontWeight: '500' }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PrimaryButton({ title, onPress, disabled, style }: { title: string; onPress: () => void; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        { backgroundColor: t.accent, borderRadius: radius.pill, paddingVertical: 16, alignItems: 'center', opacity: disabled ? 0.4 : pressed ? 0.85 : 1 },
        style,
      ]}>
      <Text style={{ color: t.onAccent, fontSize: 17, fontWeight: '600' }}>{title}</Text>
    </Pressable>
  );
}

/** Floating add button above the tab bar, on every main tab. */
export function AddButton({ account }: { account?: string } = {}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        router.push(account ? { pathname: '/add', params: { account } } : '/add');
      }}
      accessibilityLabel="Add transaction"
      accessibilityRole="button"
      style={({ pressed }) => ({
        position: 'absolute',
        right: 20,
        bottom: Math.max(insets.bottom, 12) + 64,
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: t.accent,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: t.accent,
        shadowOpacity: 0.35,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}>
      <SymbolView name="plus" size={26} weight="semibold" tintColor={t.onAccent} />
    </Pressable>
  );
}

export function Empty({ title, body, action, onAction }: { title: string; body?: string; action?: string; onAction?: () => void }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', padding: space.xl, gap: space.sm }}>
      <Text style={{ color: t.text, fontSize: 17, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
      {body ? <Text style={{ color: t.text2, textAlign: 'center' }}>{body}</Text> : null}
      {action ? <PrimaryButton title={action} onPress={onAction ?? (() => {})} style={{ alignSelf: 'stretch', marginTop: space.sm }} /> : null}
    </View>
  );
}

export function SyncPill() {
  const { sync } = useEngineState();
  const t = useTheme();
  if (sync.state === 'disabled') return null;
  const label = { idle: 'Tersinkron', syncing: 'Sinkron…', error: 'Gagal sinkron', offline: 'Offline', disabled: '' }[sync.state];
  const color = { idle: t.pos, syncing: t.accent, error: t.neg, offline: t.warn, disabled: t.text3 }[sync.state];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.surface, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: t.text2, fontSize: 12, fontWeight: '500' }}>{label}</Text>
    </View>
  );
}

export function ListRow({ title, subtitle, right, onPress, ...rest }: { title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void } & Omit<PressableProps, 'children'>) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: space.lg, backgroundColor: pressed ? t.surface2 : t.surface, gap: space.md })}
      {...rest}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: t.text, fontSize: 16 }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: t.text3, fontSize: 13, marginTop: 1 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}
