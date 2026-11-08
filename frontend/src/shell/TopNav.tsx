import { Link, NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './nav-items';
import { RunStatusBadge } from './RunStatusBadge';
import { UserMenu } from './UserMenu';
import { IconLogo, IconSearch } from './icons';

export function TopNav({ onOpenSearch }: { onOpenSearch: () => void }) {
  return (
    <header className="topnav">
      <Link to="/" className="brand" aria-label="Workmesh 项目总览">
        <IconLogo />
        <span className="brand-name">Workmesh</span>
        <span className="brand-badge">控制平面</span>
      </Link>

      <nav className="topnav-tabs" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `topnav-tab${isActive ? ' is-active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="topnav-actions">
        <button
          type="button"
          className="search-trigger"
          onClick={onOpenSearch}
          aria-label="全局搜索（Ctrl+K）"
          title="全局搜索（Ctrl+K）"
        >
          <IconSearch />
          <span className="search-trigger-text">搜索</span>
          <kbd>Ctrl K</kbd>
        </button>
        <RunStatusBadge />
        <UserMenu />
      </div>
    </header>
  );
}
