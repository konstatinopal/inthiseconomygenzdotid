import { Redirect } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEngineState } from '@/engine/provider';
import { t } from '@/lib/i18n';
import { useTheme } from '@/ui/theme';

export default function TabsLayout() {
  const { file } = useEngineState();
  const th = useTheme();
  // No budget open yet: start with the welcome screen.
  if (!file) return <Redirect href="/welcome" />;
  return (
    <NativeTabs tintColor={th.accent}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{t.budget}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chart.pie.fill" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="accounts">
        <NativeTabs.Trigger.Label>{t.accounts}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="creditcard.fill" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="reports">
        <NativeTabs.Trigger.Label>{t.reports}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chart.bar.fill" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Label>{t.more}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="ellipsis.circle.fill" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
