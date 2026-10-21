import { useEffect } from 'react';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { EngineProvider, useEngineState } from '@/engine/provider';
import { ToastHost } from '@/lib/toast';
import { AppLock } from '@/ui/app-lock';
import { t } from '@/lib/i18n';

void SplashScreen.preventAutoHideAsync();

function Root() {
  const { ready } = useEngineState();
  const scheme = useColorScheme();
  // Keep the splash up until the last budget is open, so the first frame is real data.
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerLargeTitle: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="welcome" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen
          name="add"
          options={{ presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true, headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}
        />
        <Stack.Screen
          name="budget-amount"
          options={{ presentation: 'formSheet', sheetAllowedDetents: [0.8], sheetGrabberVisible: true, headerShown: false }}
        />
        <Stack.Screen name="account/[id]" options={{ title: '', headerBackTitle: t.accounts }} />
        <Stack.Screen name="settings" options={{ title: t.settings, headerBackTitle: t.more }} />
        <Stack.Screen name="server" options={{ title: t.serverSync, headerBackTitle: t.more }} />
      </Stack>
      <ToastHost />
      <AppLock />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <EngineProvider>
        <Root />
      </EngineProvider>
    </GestureHandlerRootView>
  );
}
