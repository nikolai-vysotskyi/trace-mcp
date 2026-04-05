import type { MyResult } from './errors';
import { configError } from './errors';
import { dbError } from './errors';

export function loadConfig(): MyResult<string> {
  try {
    return { ok: true, value: 'loaded' };
  } catch {
    const e = configError('failed');
    return { ok: false, error: e };
  }
}

export function loadDb(): MyResult<string> {
  try {
    return { ok: true, value: 'connected' };
  } catch {
    const e = dbError('failed');
    return { ok: false, error: e };
  }
}
