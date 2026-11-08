/**
 * 任务包生成（纯函数，无 IO）。
 *
 * 把 tasks/subtasks 表数据 + 派发覆盖项，确定性地打包成 grok_workflow 任务包
 * 信封（objective / acceptanceCriteria / constraints / writesPaths / context）。
 * 这里只做「打包」与「序列化为根目标文本」，不做任何规划、分解、验证——
 * 子任务分解由 Grok Workflow 的 planner 完成。
 */
import { ValidationError } from '../db/errors.js';
import type { Subtask, Task } from '../types/entities.js';
import { GROK_OBJECTIVE_MAX_CHARS, type TaskPackage } from './types.js';

export interface PackOverrides {
  objective?: string;
  expected_output?: string;
  acceptance_criteria?: string[];
  constraints?: string[];
  writes_paths?: string[];
  context?: string;
}

export interface PackTaskPackageInput {
  task: Task;
  /** 任务子项（subtasks）；缺省按无子项处理。 */
  subtasks?: Subtask[];
  runId: string;
  attempt: number;
  model?: string | null;
  gateway?: string | null;
  overrides?: PackOverrides;
}

const DEFAULT_EXPECTED_OUTPUT = '完成任务描述中声明的交付物，并在报告中逐条给出证据';

/** 派发元数据行：让被执行端知道自己的运行信封（run/attempt/资源快照）。 */
function metaLine(input: PackTaskPackageInput): string {
  const model = input.model ?? 'unset';
  const gateway = input.gateway ?? 'unset';
  return [
    `workmesh.run_id=${input.runId}`,
    `task_id=${input.task.id}`,
    `project_id=${input.task.project_id}`,
    `attempt=${input.attempt}`,
    `model=${model}`,
    `gateway=${gateway}`,
  ].join(' ');
}

function stringList(value: string[] | undefined, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${label} must be an array of strings`);
  }
  return value;
}

/** 把任务打包为 grok_workflow 任务包信封。objective 超长直接拒绝（fail fast）。 */
export function packTaskPackage(input: PackTaskPackageInput): TaskPackage {
  const overrides = input.overrides ?? {};
  const objectiveSource =
    overrides.objective !== undefined
      ? overrides.objective
      : `${input.task.title}\n\n${input.task.description}`.trim();
  if (objectiveSource.trim() === '') {
    throw new ValidationError(`task '${input.task.id}' has no objective content to dispatch`);
  }
  if (objectiveSource.length > GROK_OBJECTIVE_MAX_CHARS) {
    throw new ValidationError(
      `objective length ${objectiveSource.length} exceeds grok_workflow limit ${GROK_OBJECTIVE_MAX_CHARS}`,
    );
  }

  const acceptanceCriteria =
    overrides.acceptance_criteria ??
    [...(input.subtasks ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((subtask) => subtask.title.trim())
      .filter((title) => title !== '');

  const contextParts = [`[${metaLine(input)}]`];
  if (overrides.context !== undefined && overrides.context.trim() !== '') {
    contextParts.push(overrides.context.trim());
  }

  return {
    objective: objectiveSource,
    acceptanceCriteria: stringList(acceptanceCriteria, 'acceptance_criteria'),
    constraints: stringList(overrides.constraints, 'constraints'),
    writesPaths: stringList(overrides.writes_paths, 'writes_paths'),
    context: contextParts.join('\n'),
    expectedOutput: overrides.expected_output ?? DEFAULT_EXPECTED_OUTPUT,
    source: {
      runId: input.runId,
      taskId: input.task.id,
      projectId: input.task.project_id,
      attempt: input.attempt,
    },
  };
}

function renderList(lines: string[], heading: string): string[] {
  if (lines.length === 0) return [];
  return ['', `[${heading}]`, ...lines.map((line) => `- ${line}`)];
}

/**
 * 把任务包序列化为 grok_workflow 根目标文本（工具根入参只有 objective，
 * 因此信封字段折叠为结构化小节；空小节不渲染）。输出同样受 32k 限制约束。
 */
export function renderObjective(pkg: TaskPackage): string {
  const sections: string[] = [pkg.objective];
  sections.push(...renderList(pkg.acceptanceCriteria, '验收标准'));
  sections.push(...renderList(pkg.constraints, '约束'));
  sections.push(...renderList(pkg.writesPaths, '写入范围'));
  if (pkg.expectedOutput.trim() !== '') {
    sections.push('', '[期望产出]', pkg.expectedOutput.trim());
  }
  if (pkg.context.trim() !== '') {
    sections.push('', '[上下文]', pkg.context.trim());
  }
  const rendered = sections.join('\n');
  if (rendered.length > GROK_OBJECTIVE_MAX_CHARS) {
    throw new ValidationError(
      `rendered objective length ${rendered.length} exceeds grok_workflow limit ${GROK_OBJECTIVE_MAX_CHARS}`,
    );
  }
  return rendered;
}
