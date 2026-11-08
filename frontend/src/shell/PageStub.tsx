import { Link } from 'react-router-dom';

/**
 * 预注册路由的占位页。页面模块按约定放在 src/pages/<dir>/index.tsx 并默认导出组件，
 * 模块文件出现后此占位自动被替换，无需修改路由。
 */
export function PageStub({ moduleDir }: { moduleDir: string }) {
  return (
    <div className="page-stub">
      <div className="stub-card">
        <p className="stub-kicker">占位页 · Placeholder</p>
        <h2>该页面由对应模块任务实现</h2>
        <p className="stub-desc">
          路由已在壳层预注册，约定实现路径为{' '}
          <code>frontend/src/pages/{moduleDir}/index.tsx</code>
          ；按约定默认导出页面组件后，占位自动替换，无需修改路由。
        </p>
        <Link className="btn btn-default" to="/">
          返回项目总览
        </Link>
      </div>
    </div>
  );
}
