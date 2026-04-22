// @ts-nocheck
import { importJWK, generateKeyPair } from 'jose';

export async function loadJwk(jwk: Record<string, unknown>) {
  return importJWK(jwk, 'RS256');
}

export async function rotate() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  return { publicKey, privateKey };
}
