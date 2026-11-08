import { PROJECT_STATUSES } from './types';
import type { ProjectAction, ProjectInput, ProjectSummary } from './types';

/**
 * backend API client。
 *
 * dev 下由 Vite 代理：/api/* → backend /*（去前缀）、/health → backend /health。
 * 生产由宿主（backend 静态托管）提供同名映射；可用 VITE_API_BASE 覆盖前缀。
 * 后端字段契约见 backend/src/routes/projects.ts。
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';
const HEALTH_PATH = '/health';

async function requestJson<T>(path: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

/** ---------- 后端 DTO（snake_case，与 backend 对齐） ---------- */

interface ServerProjectView {
  id: string;
  name: string;
  description: string;
  /** lifecycle 六态（后端 toView 已归一）。 */
  status: string;
  storage_status: string;
  created_at: string;
  updated_at: string;
}

interface ServerStats {
  modules: number;
  total_tasks: number;
  in_progress_tasks: number;
  blocked_tasks: number;
  current_phase: { id: string; name: string; module_id: string } | null;
  /** 0–1 的小数。 */
  progress: number;
}

/** ---------- 映射 ---------- */

function normalizeStatus(raw: string): ProjectSummary['status'] {
  if ((PROJECT_STATUSES as readonly string[]).includes(raw)) {
    return raw as ProjectSummary['status'];
  }
  // 兜底：lifecycle 行缺失时按粗粒度投影推断（与后端 effectiveLifecycle 对齐）。
  return raw === 'archived' ? 'Archived' : 'Planning';
}

function mapProject(project: ServerProjectView, stats?: ServerStats): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    goal: project.description,
    status: normalizeStatus(project.status),
    progress: Math.round((stats?.progress ?? 0) * 100),
    moduleCount: stats?.modules ?? 0,
    totalTasks: stats?.total_tasks ?? 0,
    inProgressTasks: stats?.in_progress_tasks ?? 0,
    blockedTasks: stats?.blocked_tasks ?? 0,
    currentStage: stats?.current_phase?.name ?? null,
    nextSteps: null,
    lastActivity: null,
    lastActivityAt: project.updated_at,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

/** ---------- 对外 API ---------- */

/** 拉取项目总览：列表 + 逐项目统计（统计失败不阻断整页）。 */
export async function listOverview(): Promise<ProjectSummary[]> {
  const { projects } = await requestJson<{ projects: ServerProjectView[] }>(
    `${API_BASE}/projects`,
  );
  const settled = await Promise.allSettled(
    projects.map((project) =>
      requestJson<ServerStats>(`${API_BASE}/projects/${project.id}/stats`),
    ),
  );
  return projects.map((project, index) => {
    const result = settled[index];
    return mapProject(project, result.status === 'fulfilled' ? result.value : undefined);
  });
}

export async function createProject(input: ProjectInput): Promise<void> {
  await requestJson(`${API_BASE}/projects`, {
    method: 'POST',
    body: JSON.stringify({ name: input.name, description: input.goal }),
  });
}

/** 后端 PATCH 只接受 name/description（状态走 actions 接口），其余字段为前端扩展。 */
export async function updateProject(id: string, input: ProjectInput): Promise<void> {
  await requestJson(`${API_BASE}/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: input.name, description: input.goal }),
  });
}

export async function transitionProject(id: string, action: ProjectAction): Promise<void> {
  await requestJson(`${API_BASE}/projects/${encodeURIComponent(id)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface HealthCheck {
  health: 'ok' | 'degraded';
  detail: string;
}

/** 轮询后端 /health（backend/src/health.ts：ok=200，degraded=503）。 */
export async function pollHealth(): Promise<HealthCheck> {
  const data = await requestJson<{ status?: string }>(HEALTH_PATH, undefined, 3000);
  const health = data.status === 'ok' ? 'ok' : 'degraded';
  return { health, detail: `GET ${HEALTH_PATH} → ${data.status ?? 'unknown'}` };
}
