import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, useTheme } from '@/ui/theme';

// A tiny app-wide toast with an optional action (used for "Saved · Undo").
type Toast = { id: number; text: string; action?: { label: string; run: () => void } };
let listener: ((t: Toast | null) => void) | null = null;
let seq = 0;

export function showToast(text: string, action?: Toast['action']) {
  listener?.({ id: ++seq, text, action });
}

export function ToastHost() {
  const [toast, setToast] = useState<Toast | null>(null);
  const insets = useSafeAreaInsets();
  const th = useTheme();
  useEffect(() => {
    listener = setToast;
    return () => {
      listener = null;
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(cur => (cur?.id === toast.id ? null : cur)), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 140, alignItems: 'center' }}>
      <View
        accessibilityLiveRegion="polite"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: th.text, borderRadius: radius.pill, paddingVertical: 12, paddingHorizontal: 18 }}>
        <Text style={{ color: th.surface, fontWeight: '500' }}>{toast.text}</Text>
        {toast.action ? (
          <Pressable
            onPress={() => {
              toast.action!.run();
              setToast(null);
            }}
            accessibilityRole="button">
            <Text style={{ color: th.accentSoft, fontWeight: '700' }}>{toast.action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
