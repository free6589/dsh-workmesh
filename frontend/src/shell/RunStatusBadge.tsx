import { useEffect, useState } from 'react';
import { pollHealth } from '../lib/api';
import { cx } from '../lib/cx';
import type { RunHealth, RunStatusSnapshot } from '../lib/types';

const POLL_MS = 15_000;

const META: Record<RunHealth, { label: string }> = {
  ok: { label: '运行中' },
  degraded: { label: '降级' },
  offline: { label: '未连接' },
};

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 运行状态指示：轮询后端 /health（15s），三态。 */
export function RunStatusBadge() {
  const [snapshot, setSnapshot] = useState<RunStatusSnapshot>({
    health: 'offline',
    detail: '尚未检查',
    checkedAt: new Date().toISOString(),
  });

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const result = await pollHealth();
        if (!cancelled) {
          setSnapshot({ ...result, checkedAt: new Date().toISOString() });
        }
      } catch {
        if (!cancelled) {
          setSnapshot({
            health: 'offline',
            detail: '无法连接后端服务',
            checkedAt: new Date().toISOString(),
          });
        }
      }
    };
    void check();
    const timer = window.setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <span
      className={cx('run-badge', `run-${snapshot.health}`)}
      role="status"
      title={`后端健康检查 · ${snapshot.detail} · 检查于 ${formatClock(snapshot.checkedAt)}`}
    >
      <span className="run-dot" aria-hidden="true" />
      <span className="run-label">{META[snapshot.health].label}</span>
    </span>
  );
}
