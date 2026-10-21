import { Alert, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { send } from '@/engine/index';
import { useEngineState } from '@/engine/provider';
import { t } from '@/lib/i18n';
import { Card, ListRow } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

export default function More() {
  const th = useTheme();
  const { file } = useEngineState();
  const icon = (name: string) => <SymbolView name={name as any} size={18} tintColor={th.text3} />;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: th.bg }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <Text style={{ color: th.text, fontSize: 34, fontWeight: '700', marginTop: space.sm }} accessibilityRole="header">
        {t.more}
      </Text>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <ListRow title={file?.name ?? ''} subtitle={file?.cloudFileId ? t.serverSync : 'Offline'} right={icon('doc.fill')} />
      </Card>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <ListRow title={t.settings} right={icon('chevron.right')} onPress={() => router.push('/settings')} accessibilityRole="button" />
        <ListRow title={t.serverSync} right={icon('chevron.right')} onPress={() => router.push('/server')} accessibilityRole="button" />
      </Card>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <ListRow
          title={t.closeBudget}
          right={icon('xmark.circle')}
          accessibilityRole="button"
          onPress={() =>
            Alert.alert(t.closeBudget, file?.name, [
              { text: t.cancel, style: 'cancel' },
              {
                text: t.closeBudget,
                style: 'destructive',
                onPress: async () => {
                  await send('file-close');
                  router.replace('/welcome');
                },
              },
            ])
          }
        />
      </Card>
      <View style={{ alignItems: 'center', marginTop: space.lg }}>
        <Text style={{ color: th.text3 }}>inthiseconomygenz.id</Text>
      </View>
    </ScrollView>
  );
}
