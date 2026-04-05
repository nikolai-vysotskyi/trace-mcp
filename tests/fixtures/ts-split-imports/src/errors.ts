export type MyError = { code: string; message: string };
export type MyResult<T> = { ok: boolean; value?: T; error?: MyError };

export function parseError(msg: string): MyError {
  return { code: 'PARSE', message: msg };
}

export function configError(msg: string): MyError {
  return { code: 'CONFIG', message: msg };
}

export function dbError(msg: string): MyError {
  return { code: 'DB', message: msg };
}
