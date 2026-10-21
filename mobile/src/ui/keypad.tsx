import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { radius, useTheme } from './theme';

const KEYS = [
  ['1', '2', '3', '+'],
  ['4', '5', '6', 'rb'],
  ['7', '8', '9', 'jt'],
  ['000', '0', ',', 'del'],
];

/**
 * In-app number pad: large keys in the thumb zone, a 000 key, calculator "+"
 * and Indonesian shorthands. Edits a plain text expression like "25rb+5000".
 */
export function Keypad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTheme();
  const press = (k: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (k === 'del') return onChange(value.slice(0, -1));
    const last = value.split('+').pop() ?? '';
    if (k === '+') return onChange(value && !value.endsWith('+') ? value + '+' : value);
    if (k === 'rb' || k === 'jt') return onChange(last && /\d$/.test(last) && !/(rb|jt)$/.test(last) ? value + k : value);
    if (/(rb|jt)$/.test(last)) return; // a unit closes the number; press + to add another
    if (k === ',' && (last.includes(',') || !last)) return;
    if (value.length >= 24) return;
    onChange(value === '0' && k !== ',' ? k : value + k);
  };
  return (
    <View style={{ gap: 8 }} accessibilityLabel="Number pad">
      {KEYS.map(row => (
        <View key={row.join()} style={{ flexDirection: 'row', gap: 8 }}>
          {row.map(k => {
            const op = k === '+' || k === 'rb' || k === 'jt';
            return (
              <Pressable
                key={k}
                onPress={() => press(k)}
                onLongPress={k === 'del' ? () => onChange('') : undefined}
                accessibilityRole="button"
                accessibilityLabel={k === 'del' ? 'Delete' : k === 'rb' ? 'ribu' : k === 'jt' ? 'juta' : k}
                style={({ pressed }) => ({
                  flex: 1,
                  height: 56,
                  borderRadius: radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? t.surface2 : op ? t.accentSoft : t.surface,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: t.border,
                })}>
                {k === 'del' ? (
                  <SymbolView name="delete.left" size={22} tintColor={t.text} />
                ) : (
                  <Text style={{ fontSize: op ? 18 : 24, fontWeight: op ? '600' : '500', color: op ? t.accent : t.text }}>{k}</Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
