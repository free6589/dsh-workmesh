import { lazy, Suspense } from 'react';
import type { ComponentType } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ProjectsProvider } from '../lib/store';
import { AppShell } from './AppShell';
import { NAV_ITEMS } from './nav-items';
import { PageStub } from './PageStub';
import OverviewPage from '../pages/overview/OverviewPage';

/**
 * 页面模块注册表：按约定扫描 src/pages/*/index.tsx。
 * 各页面由独立任务实现（project / resources / tasks / runs / settings），
 * 这里只预注册路由与模块路径；模块未落地时渲染占位页。
 */
const pageModules = import.meta.glob('../pages/*/index.tsx') as Record<
  string,
  () => Promise<{ default: ComponentType }>
>;

function ModulePage({ moduleDir }: { moduleDir: string }) {
  const loader = pageModules[`../pages/${moduleDir}/index.tsx`];
  if (!loader) return <PageStub moduleDir={moduleDir} />;
  const Page = lazy(loader);
  return (
    <Suspense fallback={<div className="page-loading">加载中…</div>}>
      <Page />
    </Suspense>
  );
}

function NotFoundPage() {
  return (
    <div className="page-stub">
      <div className="stub-card">
        <p className="stub-kicker">404</p>
        <h2>地址不存在</h2>
        <p className="stub-desc">从顶部导航前往五个主入口。</p>
      </div>
    </div>
  );
}

export function AppRoot() {
  return (
    <BrowserRouter>
      <ProjectsProvider>
        <AppShell>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/projects/:id" element={<ModulePage moduleDir="project" />} />
            {NAV_ITEMS.filter((item) => item.to !== '/').map((item) => (
              <Route
                key={item.to}
                path={item.to}
                element={<ModulePage moduleDir={item.moduleDir} />}
              />
            ))}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </AppShell>
      </ProjectsProvider>
    </BrowserRouter>
  );
}
