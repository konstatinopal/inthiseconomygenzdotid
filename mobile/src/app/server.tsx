import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { send } from '@/engine/index';
import { t } from '@/lib/i18n';
import { Card, ListRow, PrimaryButton } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/theme';

interface ServerState {
  url: string | null;
  loggedIn: boolean;
  reachable: boolean;
  multiuser?: boolean;
  user?: { userName: string; displayName: string | null } | null;
}
interface CloudFile {
  fileId: string;
  name: string;
  encryptKeyId: string | null;
  ownerName?: string | null;
  access?: string;
}

/** Connect to the existing sync server: address, then username + password, then pick a budget. */
export default function Server() {
  const th = useTheme();
  const [state, setState] = useState<ServerState | null>(null);
  const [url, setUrl] = useState('');
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await send<ServerState>('server-get');
    setState(s);
    if (s.url) setUrl(s.url);
    if (s.loggedIn) setFiles(await send<CloudFile[]>('cloud-files-list').catch(() => []));
  };
  useEffect(() => {
    void send<ServerState>('server-get').then(async s => {
      setState(s);
      if (s.url) setUrl(s.url);
      if (s.loggedIn) setFiles(await send<CloudFile[]>('cloud-files-list').catch(() => []));
    });
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e: any) {
      Alert.alert('', e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = (props: React.ComponentProps<typeof TextInput>) => (
    <TextInput
      placeholderTextColor={th.text3}
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      style={{ backgroundColor: th.surface2, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: th.text }}
    />
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: th.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
      <Card style={{ gap: space.sm }}>
        <Text style={{ color: th.text2, fontWeight: '500' }}>{t.serverUrl}</Text>
        {input({ value: url, onChangeText: setUrl, placeholder: 'https://budget.example.com', keyboardType: 'url', textContentType: 'URL' })}
        <PrimaryButton title={state?.url ? 'OK' : 'Connect'} onPress={() => void run(() => send('server-set-url', { url: url.trim() || null }))} disabled={busy || !url.trim()} />
      </Card>

      {state?.url && !state.loggedIn ? (
        <Card style={{ gap: space.sm }}>
          {state.multiuser ? input({ value: userName, onChangeText: setUserName, placeholder: t.username, textContentType: 'username' }) : null}
          {input({ value: password, onChangeText: setPassword, placeholder: t.password, secureTextEntry: true, textContentType: 'password' })}
          <PrimaryButton
            title={t.signIn}
            disabled={busy || !password}
            onPress={() =>
              void run(async () => {
                const r = await send<{ mustChangePassword: boolean }>('server-login', { userName: userName.trim() || undefined, password });
                if (r?.mustChangePassword) throw new Error('Set your own password in the web app first, then sign in here.');
              })
            }
          />
        </Card>
      ) : null}

      {state?.loggedIn ? (
        <>
          <Text style={{ color: th.text2 }}>{state.user ? t.signedInAs(state.user.displayName || state.user.userName) : ''}</Text>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <Text style={{ color: th.text2, fontWeight: '600', padding: space.lg, paddingBottom: space.xs }}>{t.serverBudgets}</Text>
            {(files ?? []).map(f => (
              <ListRow
                key={f.fileId}
                title={f.name}
                subtitle={f.encryptKeyId ? 'Encrypted (not supported on iPhone yet)' : f.access && f.access !== 'owner' ? f.ownerName ?? undefined : undefined}
                accessibilityRole="button"
                right={<Text style={{ color: f.encryptKeyId ? th.text3 : th.accent, fontWeight: '600' }}>{t.download}</Text>}
                onPress={() =>
                  !f.encryptKeyId &&
                  void run(async () => {
                    await send('cloud-file-download', { cloudFileId: f.fileId });
                    router.replace('/');
                  })
                }
              />
            ))}
          </Card>
          <Pressable onPress={() => void run(() => send('server-logout'))} style={{ alignItems: 'center', padding: space.md }}>
            <Text style={{ color: th.neg, fontWeight: '600' }}>{t.signOut}</Text>
          </Pressable>
        </>
      ) : null}
      {busy ? <ActivityIndicator /> : null}
      {state && !state.reachable && state.url ? <View><Text style={{ color: th.warn }}>Server not reachable.</Text></View> : null}
    </ScrollView>
  );
}
