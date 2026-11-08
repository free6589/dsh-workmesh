import { Hono } from 'hono';

// 示例路由：演示自动加载约定（本文件位于 backend/src/routes/，
// 因此自动挂载为 GET /ping，入口代码无需任何注册）。
// 新任务的路由照此复制即可；本文件可随时删除。
const router = new Hono();

router.get('/', (c) => c.json({ pong: true, route: '/ping' }));

export default router;
