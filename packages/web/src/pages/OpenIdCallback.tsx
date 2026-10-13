import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/app';
import { send } from '../lib/client';
import { describeSignInError, serverChanged, userLabel, type ServerUser } from '../lib/server';

/** Google sends the browser back here with a one-use login code (or an error). */
export function OpenIdCallback() {
  const { notify } = useApp();
  const navigate = useNavigate();
  const [message, setMessage] = useState('Signing you in…');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    (async () => {
      if (error || !code) {
        notify('error', describeSignInError(error ?? 'invalid-login-code'));
      } else {
        try {
          const user = await send<ServerUser>('server-openid-exchange', { code });
          notify('success', `Signed in as ${userLabel(user)}`);
          try {
            sessionStorage.removeItem('loginSkipped');
          } catch {}
          serverChanged();
        } catch (e: any) {
          notify('error', describeSignInError(e.reason ?? 'invalid-login-code'));
        }
      }
      setMessage('Returning…');
      navigate('/', { replace: true });
    })();
  }, [navigate, notify]);
  return <div className="center-page muted">{message}</div>;
}
