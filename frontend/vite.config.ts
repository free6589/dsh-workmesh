import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 后端地址：默认本地 backend（见 backend/README.md，端口 8787），可用 WORKMESH_BACKEND_URL 覆盖。 */
const backendUrl = process.env.WORKMESH_BACKEND_URL ?? 'http://127.0.0.1:8787';

/**
 * 前端数据面走 /api 前缀（去前缀后转发给 backend）：
 * /api/projects → backend /projects。/health 与 SPA 路由不冲突，直接转发。
 * 不能把 /projects 直接转发给后端——它同时也是前端 SPA 路由（/projects/:id）。
 */
const proxy = {
  '/api': {
    target: backendUrl,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
  '/health': {
    target: backendUrl,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy,
  },
  preview: {
    port: 5180,
    proxy,
  },
});
