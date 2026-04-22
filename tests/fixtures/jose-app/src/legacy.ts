// @ts-nocheck
import { sign, verify } from 'jsonwebtoken';

const SECRET = 'shared-secret';

export function issueToken(payload: Record<string, unknown>) {
  return sign(payload, SECRET, { expiresIn: '15m' });
}

export function checkToken(token: string) {
  return verify(token, SECRET);
}
