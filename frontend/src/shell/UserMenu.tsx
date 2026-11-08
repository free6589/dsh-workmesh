import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useDismiss } from './useDismiss';

/** 顶栏用户菜单。单用户本地面板：无登录流程，仅提供设置入口。 */
export function UserMenu() {
  const [open, setOpen] = useState(false);
  useDismiss(open, () => setOpen(false));

  return (
    <div className="user-menu" data-dismiss-root>
      <button
        type="button"
        className="avatar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="用户菜单"
        onClick={() => setOpen((value) => !value)}
      >
        OP
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-head">
            <span className="menu-name">operator</span>
            <span className="menu-sub">本地管理员 · Workmesh v0.1</span>
          </div>
          <div className="menu-divider" />
          <NavLink
            to="/settings"
            className="menu-item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            系统设置
          </NavLink>
        </div>
      )}
    </div>
  );
}
