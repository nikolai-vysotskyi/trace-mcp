import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

// Project loading must not run this SQLite write on the daemon's event loop.
// An auto-checkpoint may happen inside sqlite3_step, well beyond busy_timeout.
const workerSource = `
  // eval workers run as CommonJS even though the parent module is ESM.
  const load = require;
  const { parentPort, workerData } = load('node:worker_threads');
  const Database = load(workerData.sqliteModule);
  let db;
  try {
    db = new Database(workerData.dbPath);
    db.pragma('busy_timeout = 5000');
    db.prepare("INSERT OR REPLACE INTO server_state (key, value) VALUES ('pid', ?)")
      .run(String(workerData.pid));
    db.prepare("INSERT OR REPLACE INTO server_state (key, value) VALUES ('started_at', ?)")
      .run(workerData.startedAt);
    parentPort.postMessage(null);
  } catch (error) {
    parentPort.postMessage(String(error));
  } finally {
    db?.close();
  }
`;

export function writeServerPidOffThread(dbPath: string): Promise<void> {
  const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { sqliteModule, dbPath, pid: process.pid, startedAt: new Date().toISOString() },
    });
    let settled = false;
    worker.once('message', (error: string | null) => {
      settled = true;
      if (error) reject(new Error(error));
      else resolve();
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`PID registration worker exited with code ${code}`));
    });
  });
}
