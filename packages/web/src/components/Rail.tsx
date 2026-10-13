import { NavLink } from 'react-router-dom';
import { Icon } from './Icon';

const ITEMS: [string, string, string][] = [
  ['/budget', 'budget', 'Budget'],
  ['/accounts', 'wallet', 'Accounts'],
  ['/schedules', 'calendar', 'Schedules'],
  ['/reports', 'reports', 'Reports'],
  ['/payees', 'payees', 'Payees'],
  ['/rules', 'rules', 'Rules'],
  ['/tags', 'tag', 'Tags'],
];

/** Narrow icon rail on the far left (desktop). */
export function Rail() {
  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-logo">
        <img src="/icon.svg" width={26} height={26} alt="inthiseconomygenz.id" />
      </div>
      <div className="rail-nav">
        {ITEMS.map(([to, icon, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => `rail-btn ${isActive ? 'active' : ''}`} aria-label={label} data-tip={label}>
            <Icon name={icon} size={18} />
          </NavLink>
        ))}
      </div>
      <NavLink to="/settings" className={({ isActive }) => `rail-btn ${isActive ? 'active' : ''}`} aria-label="Settings" data-tip="Settings">
        <Icon name="settings" size={18} />
      </NavLink>
    </nav>
  );
}
