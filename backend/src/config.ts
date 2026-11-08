import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BackendConfig {
  /** SQLite 数据库文件路径，':memory:' 表示内存库。 */
  dbPath: string;
  port: number;
  host: string;
  version: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion(): string {
  try {
    const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 配置来源为环境变量：
 * - BACKEND_DB_PATH  数据库文件路径（缺省 <backend>/data/app.db）
 * - BACKEND_PORT     监听端口（回退 PORT；缺省 8787）
 * - BACKEND_HOST     监听地址（缺省 127.0.0.1）
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const rawDbPath = env['BACKEND_DB_PATH']?.trim();
  const dbPath = rawDbPath !== undefined && rawDbPath !== '' ? rawDbPath : join(packageRoot, 'data', 'app.db');
  const rawPort = Number.parseInt(env['BACKEND_PORT'] ?? env['PORT'] ?? '8787', 10);
  return {
    dbPath,
    port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 8787,
    host: env['BACKEND_HOST']?.trim() || '127.0.0.1',
    version: readVersion(),
  };
}

export { packageRoot };
