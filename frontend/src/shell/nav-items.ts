export interface NavItem {
  to: string;
  label: string;
  /** 根路径需要 end 才不会一直命中。 */
  end?: boolean;
  /** 对应 src/pages/<moduleDir>/index.tsx 的页面模块目录。 */
  moduleDir: string;
}

/** 顶部横向主导航的唯一事实源。刻意不放常驻左侧导航栏。 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '项目总览', end: true, moduleDir: 'overview' },
  { to: '/resources', label: '模型资源', moduleDir: 'resources' },
  { to: '/tasks', label: '任务中心', moduleDir: 'tasks' },
  { to: '/runs', label: '运行记录', moduleDir: 'runs' },
  { to: '/settings', label: '系统设置', moduleDir: 'settings' },
];
