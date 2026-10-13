import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from './lib/app';
import { send } from './lib/client';
import { Sidebar } from './components/Sidebar';
import { Rail } from './components/Rail';
import { TopBar } from './components/TopBar';
import { CommandBar, ShortcutsModal } from './components/CommandBar';
import { ConfirmHost, PromptHost, Toasts } from './components/ui';
import { Icon } from './components/Icon';
import { FileManager } from './pages/FileManager';
import { BudgetPage } from './pages/Budget';
import { AccountPage } from './pages/Account';
import { CategoryPage } from './pages/Category';
import { ReportsPage } from './pages/Reports';
import { SchedulesPage } from './pages/Schedules';
import { PayeesPage } from './pages/Payees';
import { RulesPage } from './pages/Rules';
import { TagsPage } from './pages/Tags';
import { SettingsPage } from './pages/Settings';
import { OpenIdCallback } from './pages/OpenIdCallback';
import { UserDirectoryPage } from './pages/UserDirectory';
import { LoginPage } from './pages/Login';
import { LOGIN_SKIPPED, serverChanged, useServerState } from './lib/server';

export function App() {
  const { file, fileLoading, notify } = useApp();
  const [cmd, setCmd] = useState(false);
  const [help, setHelp] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const server = useServerState();

  useEffect(() => setSidebarOpen(false), [location.pathname]);

  // Served by a sync server? Connect to it once, so its login page shows on first visit.
  useEffect(() => {
    if (!server.data || server.data.url) return;
    try {
      if (localStorage.getItem('serverAutoDetected')) return;
      localStorage.setItem('serverAutoDetected', '1');
    } catch {
      return;
    }
    send('server-set-url', { url: window.location.origin })
      .then(() => serverChanged())
      .catch(() => {});
  }, [server.data]);

  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmd(true);
      } else if (mod && e.key.toLowerCase() === 'z' && !typing && file) {
        e.preventDefault();
        const ok = await send<boolean>(e.shiftKey ? 'redo' : 'undo');
        if (!ok) notify('info', e.shiftKey ? 'Nothing to redo' : 'Nothing to undo');
      } else if (mod && e.key.toLowerCase() === 'y' && !typing && file) {
        e.preventDefault();
        await send('redo');
      } else if (e.key === '?' && !typing) {
        setHelp(true);
      } else if (!typing && !mod && file && e.altKey === false) {
        if (e.key === 'g') (window as any).__gPressed = Date.now();
        else if ((window as any).__gPressed && Date.now() - (window as any).__gPressed < 800) {
          const map: Record<string, string> = { b: '/budget', r: '/reports', s: '/schedules', a: '/accounts', p: '/payees', u: '/rules' };
          if (map[e.key]) navigate(map[e.key]);
          (window as any).__gPressed = 0;
        }
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [file, navigate, notify]);

  // Google's redirect lands here whether or not a budget is open.
  if (location.pathname === '/openid-cb')
    return (
      <>
        <OpenIdCallback />
        <Toasts />
      </>
    );

  if (fileLoading) return <div className="center-page muted">Loading…</div>;

  // The login page: asked for, owed a password change, or a server is set but nobody is signed in.
  const s = server.data;
  let skipped = false;
  try {
    skipped = sessionStorage.getItem(LOGIN_SKIPPED) === '1';
  } catch {}
  const mustChange = !!(s?.loggedIn && s.user?.mustChangePassword);
  const needsLogin = !!(s?.url && s.reachable && !s.loggedIn && !file && !skipped);
  if (location.pathname === '/login' || mustChange || needsLogin)
    return (
      <>
        <LoginPage />
        <Toasts />
      </>
    );

  if (!file) {
    return (
      <>
        <FileManager />
        <Toasts />
        <ConfirmHost />
        <PromptHost />
      </>
    );
  }

  return (
    <div className="app">
      <Rail />
      <Sidebar open={sidebarOpen} />
      {sidebarOpen && <div className="overlay mobile-only" style={{ zIndex: 54 }} onClick={() => setSidebarOpen(false)} />}
      <div className="main">
        <TopBar onMenu={() => setSidebarOpen(true)} onCommand={() => setCmd(true)} onHelp={() => setHelp(true)} />
        <div className="content" id="content">
          <Routes>
            <Route path="/" element={<Navigate to="/budget" replace />} />
            <Route path="/budget" element={<BudgetPage />} />
            <Route path="/accounts" element={<AccountPage />} />
            <Route path="/accounts/:id" element={<AccountPage />} />
            <Route path="/categories/:id" element={<CategoryPage />} />
            <Route path="/reports/*" element={<ReportsPage />} />
            <Route path="/schedules" element={<SchedulesPage />} />
            <Route path="/payees" element={<PayeesPage />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/user-directory" element={<UserDirectoryPage />} />
            <Route path="*" element={<Navigate to="/budget" replace />} />
          </Routes>
        </div>
      </div>
      <nav className="mobile-nav" aria-label="Primary">
        <NavLink to="/budget">
          <Icon name="budget" size={20} />
          Budget
        </NavLink>
        <NavLink to="/accounts">
          <Icon name="wallet" size={20} />
          Accounts
        </NavLink>
        <NavLink to="/schedules">
          <Icon name="calendar" size={20} />
          Schedules
        </NavLink>
        <NavLink to="/reports">
          <Icon name="reports" size={20} />
          Reports
        </NavLink>
        <a
          href="#more"
          onClick={e => {
            e.preventDefault();
            setSidebarOpen(true);
          }}
        >
          <Icon name="menu" size={20} />
          More
        </a>
      </nav>
      {cmd && <CommandBar onClose={() => setCmd(false)} />}
      {help && <ShortcutsModal onClose={() => setHelp(false)} />}
      <Toasts />
      <ConfirmHost />
      <PromptHost />
    </div>
  );
}
