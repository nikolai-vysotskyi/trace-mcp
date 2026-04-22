// @ts-nocheck
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://example.com/.well-known/jwks.json'));

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: 'https://example.com',
    audience: 'my-api',
  });
  return payload;
}
