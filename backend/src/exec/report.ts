/**
 * grok_workflow 报告处理（纯函数，无 IO）。
 *
 * 只做三件事：
 *  1. 宽松解析工具产出的结构化报告（缺字段记 parseWarnings，不静默丢弃）；
 *  2. 状态映射：completed → succeeded，partial/failed → failed（run 级语义）；
 *  3. 落库前脱敏：报告与事件载荷里不出现密钥样字符串。
 * 报告内容由 Grok Workflow 的验证/汇总环节生成，本模块不评估其正确性。
 */
import type {
  ParsedReport,
  TerminalRunStatus,
  WorkflowReport,
  WorkflowReportDeliverable,
  WorkflowReportEvidence,
  WorkflowReportStatus,
  WorkflowReportTest,
} from './types.js';

const REPORT_STATUSES: readonly string[] = ['completed', 'partial', 'failed'];
const TEST_STATUSES: readonly string[] = ['passed', 'failed', 'not_run'];

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

/** 宽松解析 grok_workflow 报告；畸形输入返回带 parseWarnings 的空报告。 */
export function parseWorkflowReport(raw: unknown): ParsedReport {
  const warnings: string[] = [];
  const empty: ParsedReport = {
    summary: '',
    status: undefined,
    deliverables: [],
    evidence: [],
    testsRun: [],
    filesChanged: [],
    uncertainties: [],
    parseWarnings: warnings,
  };
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('report is not a JSON object');
    return empty;
  }
  const obj = raw as Record<string, unknown>;

  const summary = asString(obj['summary']);
  if (summary === null) warnings.push('summary is missing or not a string');

  const statusValue = asString(obj['status']);
  const status =
    statusValue !== null && REPORT_STATUSES.includes(statusValue)
      ? (statusValue as Exclude<WorkflowReportStatus, undefined>)
      : undefined;
  if (status === undefined) warnings.push(`status is missing or unknown: ${String(obj['status'])}`);

  const deliverables: WorkflowReportDeliverable[] = [];
  for (const item of asObjectArray(obj['deliverables'])) {
    const description = asString(item['description']);
    const locator = asString(item['locator']);
    if (description === null || locator === null) {
      warnings.push('deliverables item missing description/locator');
      continue;
    }
    deliverables.push({ description, locator });
  }

  const evidence: WorkflowReportEvidence[] = [];
  for (const item of asObjectArray(obj['evidence'])) {
    const claim = asString(item['claim']);
    const source = asString(item['source']);
    if (claim === null || source === null) {
      warnings.push('evidence item missing claim/source');
      continue;
    }
    evidence.push({ claim, source });
  }

  const testsRun: WorkflowReportTest[] = [];
  for (const item of asObjectArray(obj['testsRun'])) {
    const command = asString(item['command']);
    const testStatus = asString(item['status']);
    const detail = asString(item['detail']);
    if (command === null || detail === null || testStatus === null || !TEST_STATUSES.includes(testStatus)) {
      warnings.push('testsRun item missing command/detail or has unknown status');
      continue;
    }
    testsRun.push({ command, status: testStatus as WorkflowReportTest['status'], detail });
  }

  const filesChanged = Array.isArray(obj['filesChanged'])
    ? (obj['filesChanged'] as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  if (!Array.isArray(obj['filesChanged'])) warnings.push('filesChanged is missing or not an array');

  const uncertainties = Array.isArray(obj['uncertainties'])
    ? (obj['uncertainties'] as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  if (!Array.isArray(obj['uncertainties'])) warnings.push('uncertainties is missing or not an array');

  return {
    summary: summary ?? '',
    status,
    deliverables,
    evidence,
    testsRun,
    filesChanged,
    uncertainties,
    parseWarnings: warnings,
  };
}

/** run 级状态映射：只有 completed 算成功；partial/failed/不可解析都按失败处理。 */
export function mapReportStatusToRunStatus(status: WorkflowReportStatus): TerminalRunStatus {
  return status === 'completed' ? 'succeeded' : 'failed';
}

// ---------- 落库前脱敏 ----------

type RedactRule = readonly [RegExp, string];

const SECRET_RULES: readonly RedactRule[] = [
  [/sk-[A-Za-z0-9]{16,}/g, '***redacted***'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '***redacted***'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '***redacted***'],
  [/AKIA[0-9A-Z]{16}/g, '***redacted***'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer ***redacted***'],
  [
    /((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|authorization)\s*[:=]\s*)(["']?)[A-Za-z0-9._~+/=-]{8,}\2/gi,
    '$1$2***redacted***$2',
  ],
];

/** 对任意文本做密钥样字符串脱敏；无密钥样内容时原样返回。 */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 报告整体脱敏（summary/交付物/证据/测试/文件清单/不确定项）。 */
export function redactReport(report: ParsedReport): ParsedReport {
  return {
    ...report,
    summary: redactText(report.summary),
    deliverables: report.deliverables.map((item) => ({
      description: redactText(item.description),
      locator: redactText(item.locator),
    })),
    evidence: report.evidence.map((item) => ({
      claim: redactText(item.claim),
      source: redactText(item.source),
    })),
    testsRun: report.testsRun.map((item) => ({
      command: redactText(item.command),
      status: item.status,
      detail: redactText(item.detail),
    })),
    filesChanged: report.filesChanged.map(redactText),
    uncertainties: report.uncertainties.map(redactText),
    parseWarnings: report.parseWarnings,
  };
}

/** 从混合文本中提取最后一个可解析的 JSON 对象（dsh headless 输出可能带前后缀文字）。 */
export function extractJsonReport(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // 继续扫描嵌入的 JSON 对象
  }
  let last: unknown = null;
  const maxCandidates = 256;
  let candidates = 0;
  for (let i = 0; i < trimmed.length && candidates <= maxCandidates; i += 1) {
    if (trimmed[i] !== '{') continue;
    const end = findBalancedEnd(trimmed, i);
    if (end === null) continue;
    candidates += 1;
    try {
      last = JSON.parse(trimmed.slice(i, end + 1)) as unknown;
    } catch {
      continue;
    }
  }
  return last;
}

/** 返回从 start 处 '{' 开始的平衡块结束下标（考虑字符串与转义），不成对返回 null。 */
function findBalancedEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

export type { WorkflowReport };
