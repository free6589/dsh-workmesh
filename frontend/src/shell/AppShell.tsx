import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { GlobalSearch } from './GlobalSearch';
import { TopNav } from './TopNav';

/**
 * 全局壳层：顶部横向主导航 + 内容区。刻意没有常驻左侧导航栏——
 * DSH 本身已有左侧栏，Workmesh 再放左栏会压缩工作区域。
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <TopNav onOpenSearch={() => setSearchOpen(true)} />
      <main className="app-main">{children}</main>
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
