import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { openDatabase } from './sqlite.js';
import { appliedMigrations, runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  try {
    const before = appliedMigrations(db);
    const applied = runMigrations(db);
    console.log(`[migrate] db=${config.dbPath}`);
    console.log(`[migrate] already applied: ${before.length > 0 ? before.join(', ') : '(none)'}`);
    console.log(`[migrate] newly applied: ${applied.length > 0 ? applied.join(', ') : '(none)'}`);
  } finally {
    db.close();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
