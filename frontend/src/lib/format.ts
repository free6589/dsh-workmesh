/** 相对时间：<1min 刚刚，<1h N 分钟前，<24h N 小时前，<7d N 天前，其余显示日期。 */
export function relativeTime(isoString: string, now = Date.now()): string {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return isoString;
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(then).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** 进度展示：0–100 整数 + 百分号。 */
export function pct(value: number): string {
  return `${Math.min(100, Math.max(0, Math.round(value)))}%`;
}
