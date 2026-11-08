/**
 * 执行平面公共出口（backend/src/exec）。
 *
 * 职责：派发 → 跟踪 → 落库 → 重试/阻塞 → 反馈调度器。
 * 规划/执行/验证/重试/汇总由 Grok Workflow（执行端）完成，不在此实现。
 */
export * from './types.js';
export * from './pack.js';
export * from './report.js';
export * from './executor.js';
export * from './service.js';
export * from './router.js';
