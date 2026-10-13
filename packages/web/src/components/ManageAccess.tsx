import { useMemo, useState } from 'react';
import { useAction } from '../lib/app';
import { useQuery } from '../lib/hooks';
import { userLabel, type ServerUser } from '../lib/server';
import { Autocomplete } from './Autocomplete';
import { Avatar } from './Avatar';
import { Modal, confirmDialog } from './ui';

interface AccessInfo {
  owner: ServerUser | null;
  users: ServerUser[];
}

export function ManageAccessModal({ fileName, meId, onClose }: { fileName: string; meId: string | null; onClose: () => void }) {
  const act = useAction();
  const access = useQuery<AccessInfo>('file-access-get', {}, []);
  const directory = useQuery<ServerUser[]>('users-directory', {}, []);
  const [pick, setPick] = useState<string | null>(null);
  const [pickKey, setPickKey] = useState(0);

  const taken = new Set([access.data?.owner?.id, ...(access.data?.users ?? []).map(u => u.id)]);
  const items = useMemo(
    () => (directory.data ?? []).filter(u => !taken.has(u.id)).map(u => ({ id: u.id, label: userLabel(u), hint: u.userName })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [directory.data, access.data],
  );

  const grant = async () => {
    if (!pick) return;
    if ((await act('file-access-grant', { userId: pick })) !== undefined) {
      setPick(null);
      setPickKey(k => k + 1);
      access.reload();
    }
  };

  return (
    <Modal title={`Access to “${fileName}”`} onClose={onClose} footer={<button onClick={onClose}>Done</button>}>
      <p className="muted small">People with access can open this budget on their devices and sync changes. Only the owner and admins can share, rename, reset or delete it.</p>
      {access.data?.owner && (
        <div className="row">
          <Avatar name={userLabel(access.data.owner)} picture={access.data.owner.picture} size={30} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>
              {userLabel(access.data.owner)} {access.data.owner.id === meId && <span className="dim">(you)</span>}
            </div>
            <div className="dim small">{access.data.owner.userName}</div>
          </div>
          <span className="badge accent">Owner</span>
        </div>
      )}
      {(access.data?.users ?? []).map(u => (
        <div key={u.id} className="row">
          <Avatar name={userLabel(u)} picture={u.picture} size={30} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>
              {userLabel(u)} {u.id === meId && <span className="dim">(you)</span>}
            </div>
            <div className="dim small">{u.userName}</div>
          </div>
          <button
            className="small ghost"
            onClick={async () => {
              if (await confirmDialog({ title: 'Make owner', message: `Make ${userLabel(u)} the owner? The current owner keeps access as a collaborator.`, confirmLabel: 'Make owner' })) {
                if ((await act('file-access-transfer', { newUserId: u.id }, 'Ownership transferred')) !== undefined) access.reload();
              }
            }}
          >
            Make owner
          </button>
          <button
            className="small danger"
            onClick={async () => {
              if ((await act('file-access-revoke', { userId: u.id }, `${userLabel(u)} removed`)) !== undefined) access.reload();
            }}
          >
            Remove
          </button>
        </div>
      ))}
      {access.data && access.data.users.length === 0 && <p className="dim small">Not shared with anyone yet.</p>}
      <div className="row">
        <div className="grow">
          <Autocomplete key={pickKey} items={items} value={pick} onSelect={setPick} placeholder="Add a person from the user directory…" ariaLabel="Add person" />
        </div>
        <button className="primary" disabled={!pick} onClick={grant}>
          Share
        </button>
      </div>
      {directory.data && items.length === 0 && <p className="dim small">Everyone in the user directory already has access. Admins can invite more people.</p>}
    </Modal>
  );
}
