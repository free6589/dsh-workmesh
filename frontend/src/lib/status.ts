import type { ProjectAction, ProjectStatus } from './types';

export interface StatusMeta {
  label: string;
  tone: 'blue' | 'green' | 'amber' | 'violet' | 'teal' | 'gray';
  description: string;
}

export const STATUS_META: Record<ProjectStatus, StatusMeta> = {
  Planning: { label: '规划中', tone: 'blue', description: '需求与方案仍在规划' },
  Active: { label: '进行中', tone: 'green', description: '项目正在推进' },
  Paused: { label: '已暂停', tone: 'amber', description: '项目被暂停，可随时恢复' },
  Maintenance: { label: '维护中', tone: 'violet', description: '主体工作完成，仅做维护' },
  Completed: { label: '已完成', tone: 'teal', description: '目标已达成' },
  Archived: { label: '已归档', tone: 'gray', description: '只读归档，不参与调度' },
};

/** 状态操作 → 迁移后的状态。 */
export const ACTION_RESULT: Record<ProjectAction, ProjectStatus> = {
  activate: 'Active',
  resume: 'Active',
  pause: 'Paused',
  maintain: 'Maintenance',
  complete: 'Completed',
  archive: 'Archived',
};

/** 卡片上可用的状态快捷操作（编辑始终可用，Archived 只读）。 */
export type CardAction = 'pause' | 'resume' | 'archive';

export function cardActions(status: ProjectStatus): CardAction[] {
  switch (status) {
    case 'Active':
      return ['pause', 'archive'];
    case 'Paused':
    case 'Maintenance':
      return ['resume', 'archive'];
    case 'Planning':
    case 'Completed':
      return ['archive'];
    case 'Archived':
      return [];
  }
}

export interface CardActionMeta {
  label: string;
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel: string;
}

export const CARD_ACTION_META: Record<CardAction, CardActionMeta> = {
  pause: {
    label: '暂停项目',
    confirmTitle: '暂停项目',
    confirmMessage: '暂停后项目不再参与调度，任务保持现状，可随时恢复。',
    confirmLabel: '确认暂停',
  },
  resume: {
    label: '恢复项目',
    confirmTitle: '恢复项目',
    confirmMessage: '恢复后项目回到「进行中」，重新参与调度。',
    confirmLabel: '确认恢复',
  },
  archive: {
    label: '归档项目',
    confirmTitle: '归档项目',
    confirmMessage: '归档后项目转为只读，不再参与调度，且不会出现在默认筛选中。',
    confirmLabel: '确认归档',
  },
};
