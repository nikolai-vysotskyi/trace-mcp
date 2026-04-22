// @ts-nocheck
import jwt from 'jsonwebtoken';

const SECRET = 'shared-secret';

export function issueToken(payload: Record<string, unknown>) {
  return jwt.sign(payload, SECRET, { expiresIn: '15m' });
}

export function checkToken(token: string) {
  return jwt.verify(token, SECRET);
}
