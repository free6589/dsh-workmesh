import { ACTION_RESULT } from './status';
import type { ProjectAction, ProjectInput, ProjectSummary } from './types';

/**
 * 演示数据存储：后端不可达时，项目总览仍可完整体验（CRUD + 六态筛选）。
 * 数据持久化在 localStorage，key 带版本号；读取失败时重新播种。
 */

const STORAGE_KEY = 'workmesh.demo.projects.v1';

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

function seed(): ProjectSummary[] {
  return [
    {
      id: 'demo-gateway',
      name: '模型网关整合',
      goal: '把 Agent2API、Bifrost 与独立图像渠道统一成一套模型目录与路由策略，让所有任务用同一套网关密钥调用模型。',
      status: 'Active',
      progress: 62,
      moduleCount: 4,
      totalTasks: 24,
      inProgressTasks: 6,
      blockedTasks: 1,
      currentStage: '阶段三 · 网关密钥与请求报表',
      nextSteps: '接入 Bifrost 请求报表，产出第一版用量周报。',
      lastActivity: '完成任务「报表聚合接口」并合并到主干',
      lastActivityAt: iso(2),
      createdAt: iso(24 * 21),
      updatedAt: iso(2),
    },
    {
      id: 'demo-workmesh',
      name: 'Workmesh 控制平面',
      goal: '搭建项目 / 任务 / Agent / 模型四域的管理面板与全局调度器，单进程 + SQLite，部署在 VPS。',
      status: 'Active',
      progress: 38,
      moduleCount: 5,
      totalTasks: 31,
      inProgressTasks: 5,
      blockedTasks: 0,
      currentStage: '阶段二 · 前端骨架与项目总览',
      nextSteps: '项目总览合入后，接任务中心与项目详情页。',
      lastActivity: '项目卡片 CRUD 联调',
      lastActivityAt: iso(5),
      createdAt: iso(24 * 14),
      updatedAt: iso(5),
    },
    {
      id: 'demo-eval',
      name: 'Agent 评测集建设',
      goal: '为常用执行流（勘察、实现、验证）构建可复用的评测集与评分脚本。',
      status: 'Planning',
      progress: 0,
      moduleCount: 2,
      totalTasks: 9,
      inProgressTasks: 0,
      blockedTasks: 0,
      currentStage: '尚未开题',
      nextSteps: '确定评分维度与样本来源。',
      lastActivity: '创建项目',
      lastActivityAt: iso(30),
      createdAt: iso(30),
      updatedAt: iso(30),
    },
    {
      id: 'demo-canvas',
      name: '画布批量生图流水线',
      goal: '无限画布上按队列批量生图，支持失败重试与画廊归档。',
      status: 'Paused',
      progress: 45,
      moduleCount: 3,
      totalTasks: 14,
      inProgressTasks: 0,
      blockedTasks: 2,
      currentStage: '阶段二 · 队列与重试',
      nextSteps: '等上游生图渠道额度恢复后再继续。',
      lastActivity: '因渠道额度不足暂停',
      lastActivityAt: iso(24 * 3),
      createdAt: iso(24 * 40),
      updatedAt: iso(24 * 3),
    },
    {
      id: 'demo-infra',
      name: '部署机基础设施巡检',
      goal: 'systemd 单元、SQLite 备份、日志轮转的例行巡检与告警。',
      status: 'Maintenance',
      progress: 90,
      moduleCount: 3,
      totalTasks: 12,
      inProgressTasks: 1,
      blockedTasks: 0,
      currentStage: '例行维护',
      nextSteps: '补一份备份恢复演练手册。',
      lastActivity: '完成 10 月备份恢复演练',
      lastActivityAt: iso(24 * 6),
      createdAt: iso(24 * 60),
      updatedAt: iso(24 * 6),
    },
    {
      id: 'demo-archive',
      name: '旧机数据归档迁移',
      goal: '把 Bifrost 旧机的 shim、Caddy 与 token-usage 归档迁到 bifrost-mirror 留档。',
      status: 'Completed',
      progress: 100,
      moduleCount: 4,
      totalTasks: 18,
      inProgressTasks: 0,
      blockedTasks: 0,
      currentStage: '已交付',
      nextSteps: '无',
      lastActivity: '全部任务完成并通过验收',
      lastActivityAt: iso(24 * 12),
      createdAt: iso(24 * 90),
      updatedAt: iso(24 * 12),
    },
    {
      id: 'demo-legacy',
      name: '旧版调度看板原型',
      goal: '第一版调度看板的静态 HTML 原型，已被 Workmesh 取代。',
      status: 'Archived',
      progress: 70,
      moduleCount: 2,
      totalTasks: 8,
      inProgressTasks: 0,
      blockedTasks: 0,
      currentStage: '已归档',
      nextSteps: '无',
      lastActivity: '归档项目',
      lastActivityAt: iso(24 * 40),
      createdAt: iso(24 * 120),
      updatedAt: iso(24 * 40),
    },
  ];
}

function writeAll(list: ProjectSummary[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 隐私模式等场景下持久化失败不影响本次会话。
  }
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value &&
    'status' in value &&
    'updatedAt' in value
  );
}

function readAll(): ProjectSummary[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(isProjectSummary)) {
        return parsed;
      }
    }
  } catch {
    // 解析失败则重新播种。
  }
  const seeded = seed();
  writeAll(seeded);
  return seeded;
}

function requireIndex(list: ProjectSummary[], id: string): number {
  const index = list.findIndex((project) => project.id === id);
  if (index < 0) throw new Error(`演示数据中不存在项目 ${id}`);
  return index;
}

const ACTION_LABEL: Record<ProjectAction, string> = {
  activate: '恢复项目',
  resume: '恢复项目',
  pause: '暂停了项目',
  maintain: '转入维护',
  complete: '标记为完成',
  archive: '归档了项目',
};

export const demoStore = {
  list(): ProjectSummary[] {
    return [...readAll()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  },
  create(input: ProjectInput): ProjectSummary {
    const now = new Date().toISOString();
    const project: ProjectSummary = {
      id: `demo-${Date.now().toString(36)}`,
      ...input,
      lastActivity: '创建项目',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    writeAll([project, ...readAll()]);
    return project;
  },
  update(id: string, input: ProjectInput): ProjectSummary {
    const list = readAll();
    const index = requireIndex(list, id);
    const now = new Date().toISOString();
    const updated: ProjectSummary = {
      ...list[index],
      ...input,
      lastActivity: '更新了项目信息',
      lastActivityAt: now,
      updatedAt: now,
    };
    list[index] = updated;
    writeAll(list);
    return updated;
  },
  transition(id: string, action: ProjectAction): ProjectSummary {
    const list = readAll();
    const index = requireIndex(list, id);
    const now = new Date().toISOString();
    const updated: ProjectSummary = {
      ...list[index],
      status: ACTION_RESULT[action],
      lastActivity: ACTION_LABEL[action],
      lastActivityAt: now,
      updatedAt: now,
    };
    list[index] = updated;
    writeAll(list);
    return updated;
  },
};
