import { useEffect, useRef, useState } from 'react';
import type { FileMeta } from '@envelope/core';
import { useApp, useAction } from '../lib/app';
import { send } from '../lib/client';
import { useQuery } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { MenuButton, confirmDialog, promptDialog } from '../components/ui';
import { ServerSettings } from '../components/ServerSettings';
import { useServerState } from '../lib/server';

interface CloudFile {
  fileId: string;
  groupId: string;
  name: string;
  encryptKeyId: string | null;
  access?: 'owner' | 'shared' | 'admin';
  ownerName?: string | null;
}

export function FileManager() {
  const { notify } = useApp();
  const act = useAction();
  const files = useQuery<FileMeta[]>('files-list', {}, '*');
  const server = useServerState();
  const [cloud, setCloud] = useState<CloudFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const loadCloud = async () => {
    if (!server.data?.url || !server.data.loggedIn) return setCloud(null);
    try {
      setCloud(await send('cloud-files-list'));
    } catch (e: any) {
      setCloud(null);
      if (e.reason === 'unauthorized') server.reload();
    }
  };
  useEffect(() => {
    void loadCloud();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.data?.url, server.data?.loggedIn]);

  const create = async (demo: boolean) => {
    const name = demo ? 'Demo Budget' : await promptDialog({ title: 'New budget', label: 'Name', initial: 'My Budget' });
    if (!name) return;
    setBusy(true);
    await act('file-create', { name, demo });
    setBusy(false);
  };

  const download = async (f: CloudFile) => {
    setBusy(true);
    try {
      await send('cloud-file-download', { cloudFileId: f.fileId });
    } catch (e: any) {
      if (e.reason === 'missing-key') {
        const password = await promptDialog({ title: `Unlock “${f.name}”`, label: 'Encryption password', type: 'password' });
        if (password) await act('cloud-file-download', { cloudFileId: f.fileId, password });
      } else notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };

  const local = files.data ?? [];
  const localCloudIds = new Set(local.map(f => f.cloudFileId).filter(Boolean));
  const remoteOnly = (cloud ?? []).filter(f => !localCloudIds.has(f.fileId));
  const cloudById = new Map((cloud ?? []).map(f => [f.fileId, f]));
  const sharedLabel = (f?: CloudFile) => (f && f.access !== 'owner' && f.ownerName ? ` · ${f.access === 'shared' ? 'shared by' : 'owned by'} ${f.ownerName}` : '');

  return (
    <div className="center-page">
      <div className="files">
        <div className="row">
          <img src="/icon.svg" width={36} height={36} alt="" />
          <div className="grow">
            <h1>inthiseconomygenz.id</h1>
            <div className="muted small">Local-first envelope budgeting. Your data stays on this device unless you sync it.</div>
          </div>
        </div>

        <div className="card">
          <div className="row wrap" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <h2 className="grow" style={{ minWidth: 'max-content' }}>
              Your budgets
            </h2>
            <button disabled={busy} onClick={() => importRef.current?.click()}>
              <Icon name="upload" /> Import
            </button>
            <button disabled={busy} onClick={() => create(true)}>
              Try demo
            </button>
            <button className="primary" disabled={busy} onClick={() => create(false)}>
              <Icon name="plus" /> New budget
            </button>
          </div>
          {local.length === 0 && remoteOnly.length === 0 && (
            <div className="empty">
              No budgets yet. Create one, try the demo, or import an exported budget file.
            </div>
          )}
          {local.map(f => (
            <div key={f.id} className="file-item" onClick={() => !busy && act('file-load', { id: f.id })} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && act('file-load', { id: f.id })}>
              <span className="file-icon">
                <Icon name="file" size={18} />
              </span>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{f.name}</div>
                <div className="dim small">
                  {f.cloudFileId ? (f.encryptKeyId ? 'Synced · encrypted' : 'Synced') : 'Local only'}
                  {sharedLabel(cloudById.get(f.cloudFileId ?? ''))}
                  {f.lastOpened ? ` · opened ${new Date(f.lastOpened).toLocaleDateString()}` : ''}
                </div>
              </div>
              <span onClick={e => e.stopPropagation()}>
                <MenuButton
                  title="File actions"
                  align="right"
                  items={[
                    {
                      label: 'Rename',
                      onClick: async () => {
                        const name = await promptDialog({ title: 'Rename budget', label: 'Name', initial: f.name });
                        if (name) {
                          await act('file-rename', { id: f.id, name });
                          files.reload();
                        }
                      },
                    },
                    {
                      label: 'Duplicate',
                      onClick: async () => {
                        await act('file-duplicate', { id: f.id, name: `${f.name} (copy)` });
                        files.reload();
                      },
                    },
                    { divider: true, label: '' },
                    {
                      label: 'Delete from this device',
                      danger: true,
                      onClick: async () => {
                        if (await confirmDialog({ title: 'Delete budget', message: `Delete “${f.name}” from this device?${f.cloudFileId ? ' The server copy is kept.' : ' This cannot be undone.'}`, danger: true, confirmLabel: 'Delete' })) {
                          await act('file-delete', { id: f.id });
                          files.reload();
                        }
                      },
                    },
                    ...(f.cloudFileId && server.data?.loggedIn && cloudById.get(f.cloudFileId)?.access !== 'shared'
                      ? [
                          {
                            label: 'Delete everywhere (device and server)',
                            danger: true,
                            onClick: async () => {
                              if (await confirmDialog({ title: 'Delete everywhere', message: `Delete “${f.name}” from this device and the sync server? Other devices lose access.`, danger: true, confirmLabel: 'Delete' })) {
                                await act('file-delete', { id: f.id, fromServer: true });
                                files.reload();
                                void loadCloud();
                              }
                            },
                          },
                        ]
                      : []),
                  ]}
                >
                  <Icon name="more" />
                </MenuButton>
              </span>
            </div>
          ))}
          {remoteOnly.map(f => (
            <div key={f.fileId} className="file-item" onClick={() => !busy && download(f)} role="button" tabIndex={0}>
              <span className="file-icon">
                <Icon name="download" size={18} />
              </span>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{f.name}</div>
                <div className="dim small">On server{f.encryptKeyId ? ' · encrypted' : ''}{sharedLabel(f)} · click to download</div>
              </div>
            </div>
          ))}
        </div>

        <ServerSettings onChange={() => server.reload()} />

        <input
          ref={importRef}
          type="file"
          accept=".sqlite,.db,.envelope"
          hidden
          onChange={async e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            setBusy(true);
            await act('file-import', { name: file.name.replace(/\.[^.]+$/, ''), data: btoa(bin) });
            setBusy(false);
          }}
        />
      </div>
    </div>
  );
}
