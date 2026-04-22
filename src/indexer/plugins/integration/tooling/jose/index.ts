/**
 * JosePlugin — detects JWT/JWS/JWE libraries (jose, jsonwebtoken, jws, node-jose)
 * and tags files with roles for signing, verification, and JWK/key management.
 *
 * Handles three call styles:
 *   - Qualified:   `jwt.sign(...)`, `jwt.verify(...)`
 *   - Unqualified: `import { sign, verify } from 'jsonwebtoken'; sign(...); verify(...);`
 *   - Native jose: `new SignJWT(...)`, `jwtVerify(...)`, `importJWK(...)`
 *
 * Pass 2 edges:
 *   - jwk_imports:  enclosing symbol → jwks-url::<url>     (per `createRemoteJWKSet(new URL('...'))`)
 *   - jwt_verifies: enclosing symbol → jwt-issuer::<iss>   (per `issuer: '...'` when the file verifies)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

const JWT_PACKAGES = [
  'jose',
  'jsonwebtoken',
  'jws',
  'jwk-to-pem',
  'node-jose',
  '@panva/jose',
];

const SIGN_CLASS_RE =
  /new\s+(?:SignJWT|EncryptJWT|GeneralSign|FlattenedSign|CompactSign|GeneralEncrypt|FlattenedEncrypt|CompactEncrypt)\s*\(/;
const JOSE_VERIFY_RE =
  /\b(?:jwtVerify|compactVerify|flattenedVerify|generalVerify|jwtDecrypt|compactDecrypt|flattenedDecrypt|generalDecrypt|experimental_jwtDecrypt)\s*\(/;
const JOSE_KEY_RE =
  /\b(?:importJWK|importSPKI|importPKCS8|importX509|createLocalJWKSet|createRemoteJWKSet|exportJWK|exportSPKI|exportPKCS8|generateKeyPair|generateSecret|calculateJwkThumbprint|embeddedJWK)\s*\(/;

const JSONWEBTOKEN_QUALIFIED_RE =
  /\b(?:jwt|jsonwebtoken|JWT)\s*\.\s*(sign|verify|decode)\s*\(/g;

const JWT_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*['"](?:jose|jsonwebtoken|jws|jwk-to-pem|node-jose|@panva\/jose)['"]/;

const JSONWEBTOKEN_NAMED_IMPORT_RE =
  /(?:import\s*\{([^}]+)\}\s*from\s*['"]jsonwebtoken['"]|(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"]jsonwebtoken['"]\s*\))/g;

const JWKS_URL_RE =
  /createRemoteJWKSet\s*\(\s*new\s+URL\s*\(\s*['"`]([^'"`]+)['"`]/g;
const ISSUER_RE =
  /\bissuer\s*:\s*['"`]([^'"`]+)['"`]/g;
const AUDIENCE_RE =
  /\baudience\s*:\s*['"`]([^'"`]+)['"`]/g;

function parseJsonwebtokenNamedImports(source: string): Set<string> {
  const names = new Set<string>();
  JSONWEBTOKEN_NAMED_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JSONWEBTOKEN_NAMED_IMPORT_RE.exec(source)) !== null) {
    const body = m[1] ?? m[2] ?? '';
    for (const raw of body.split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0]).trim();
      if (local) names.add(local);
    }
  }
  return names;
}

function fileVerifies(source: string): boolean {
  if (JOSE_VERIFY_RE.test(source)) return true;
  JSONWEBTOKEN_QUALIFIED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JSONWEBTOKEN_QUALIFIED_RE.exec(source)) !== null) {
    if (m[1] === 'verify') return true;
  }
  const imported = parseJsonwebtokenNamedImports(source);
  if (imported.has('verify') && /\bverify\s*\(/.test(source)) return true;
  return false;
}

export class JosePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'jose',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of JWT_PACKAGES) {
        if (pkg in deps) return true;
      }
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const p of JWT_PACKAGES) {
        if (p in deps) return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'jwt_signs', category: 'jwt', description: 'JWT/JWS signing operation' },
        { name: 'jwt_verifies', category: 'jwt', description: 'JWT/JWS verification operation' },
        { name: 'jwk_imports', category: 'jwt', description: 'JWK or key material import' },
      ],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [] };

    const hasImport = JWT_IMPORT_RE.test(source);
    const hasSignClass = SIGN_CLASS_RE.test(source);
    const hasJoseVerify = JOSE_VERIFY_RE.test(source);
    const hasJoseKey = JOSE_KEY_RE.test(source);

    let hasQualifiedSign = false;
    let hasQualifiedVerify = false;
    JSONWEBTOKEN_QUALIFIED_RE.lastIndex = 0;
    let qm: RegExpExecArray | null;
    while ((qm = JSONWEBTOKEN_QUALIFIED_RE.exec(source)) !== null) {
      if (qm[1] === 'sign') hasQualifiedSign = true;
      else if (qm[1] === 'verify') hasQualifiedVerify = true;
    }

    let hasUnqualifiedSign = false;
    let hasUnqualifiedVerify = false;
    const imported = parseJsonwebtokenNamedImports(source);
    if (imported.has('sign') && /\bsign\s*\(/.test(source)) {
      hasUnqualifiedSign = true;
    }
    if (imported.has('verify') && /\bverify\s*\(/.test(source)) {
      hasUnqualifiedVerify = true;
    }

    const signs = hasSignClass || hasQualifiedSign || hasUnqualifiedSign;
    const verifies = hasJoseVerify || hasQualifiedVerify || hasUnqualifiedVerify;

    if (signs && verifies) {
      result.frameworkRole = 'jwt_auth';
    } else if (signs) {
      result.frameworkRole = 'jwt_signer';
    } else if (verifies) {
      result.frameworkRole = 'jwt_verifier';
    } else if (hasJoseKey) {
      result.frameworkRole = 'jwt_keys';
    } else if (hasImport) {
      result.frameworkRole = 'jwt_usage';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      const symbols = ctx.getSymbolsByFile(file.id);

      // JWKS remote imports — fire whenever the pattern is present (URL is specific enough).
      JWKS_URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = JWKS_URL_RE.exec(source)) !== null) {
        const line = lineOfIndex(source, m.index);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) continue;
        edges.push({
          edgeType: 'jwk_imports',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: `jwks-url::${m[1]}`,
          metadata: { url: m[1], line, file: file.path },
          resolution: 'text_matched',
        });
      }

      // Issuer references — only emit when file verifies tokens, else `issuer:` may be noise.
      if (!fileVerifies(source)) continue;

      const audiences: string[] = [];
      AUDIENCE_RE.lastIndex = 0;
      let am: RegExpExecArray | null;
      while ((am = AUDIENCE_RE.exec(source)) !== null) audiences.push(am[1]);

      ISSUER_RE.lastIndex = 0;
      while ((m = ISSUER_RE.exec(source)) !== null) {
        const line = lineOfIndex(source, m.index);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) continue;
        edges.push({
          edgeType: 'jwt_verifies',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: `jwt-issuer::${m[1]}`,
          metadata: {
            issuer: m[1],
            audiences: audiences.length > 0 ? audiences : undefined,
            line,
            file: file.path,
          },
          resolution: 'text_matched',
        });
      }
    }

    return ok(edges);
  }
}
