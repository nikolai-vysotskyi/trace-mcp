// @ts-nocheck
import { SignJWT, importPKCS8 } from 'jose';

const alg = 'RS256';

export async function signAccessToken(subject: string, privateKeyPem: string) {
  const key = await importPKCS8(privateKeyPem, alg);
  return new SignJWT({ sub: subject })
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
}
