import { describe, expect, it } from 'vitest';
import {
  detectSecrets,
  escapeRegExp,
  isBinaryBuffer,
  isSensitiveFile,
  validateArtisanCommand,
  validateFileSize,
  validatePath,
} from '../../src/utils/security.js';

describe('security', () => {
  describe('path traversal', () => {
    const root = '/projects/my-app';

    it('allows paths within root', () => {
      const result = validatePath('app/Models/User.php', root);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('/projects/my-app/app/Models/User.php');
    });

    it('blocks path traversal with ..', () => {
      const result = validatePath('../../../etc/passwd', root);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('SECURITY_VIOLATION');
    });

    it('blocks path traversal with encoded ..', () => {
      const result = validatePath('app/../../etc/passwd', root);
      expect(result.isErr()).toBe(true);
    });

    it('allows root path itself', () => {
      const result = validatePath('.', root);
      expect(result.isOk()).toBe(true);
    });

    it('allows nested paths', () => {
      const result = validatePath('app/Http/Controllers/Auth/LoginController.php', root);
      expect(result.isOk()).toBe(true);
    });

    it('blocks absolute paths outside root', () => {
      const result = validatePath('/etc/passwd', root);
      expect(result.isErr()).toBe(true);
    });

    it('blocks paths with null bytes', () => {
      const result = validatePath('app/Models/User.php\0/../../../etc/passwd', root);
      // path.resolve strips after null byte on some platforms, but the resolved
      // path should either stay in root or be blocked
      if (result.isOk()) {
        expect(result._unsafeUnwrap().startsWith(root)).toBe(true);
      } else {
        expect(result._unsafeUnwrapErr().code).toBe('SECURITY_VIOLATION');
      }
    });

    it('blocks double-encoded traversal', () => {
      const result = validatePath('app/..%2f..%2f..%2fetc/passwd', root);
      // %2f is not decoded by path.resolve, so this stays in root — that's fine
      if (result.isOk()) {
        expect(result._unsafeUnwrap().startsWith(`${root}/`)).toBe(true);
      }
    });

    it('handles empty path as root', () => {
      const result = validatePath('', root);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('/projects/my-app');
    });

    it('blocks traversal disguised in middle segments', () => {
      const result = validatePath('app/Models/../../../../../../etc/shadow', root);
      expect(result.isErr()).toBe(true);
    });

    it('allows paths with .. that stay within root', () => {
      const result = validatePath('app/Models/../Services/UserService.php', root);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('/projects/my-app/app/Services/UserService.php');
    });

    it('blocks root prefix attack (rootpath substring)', () => {
      // If root is /projects/my-app, /projects/my-app-evil should be blocked
      const result = validatePath('/projects/my-app-evil/file.ts', '/projects/my-app');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('secret detection', () => {
    it('detects password patterns', () => {
      const result = detectSecrets('DB_PASSWORD=secret123');
      expect(result.found).toBe(true);
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('detects api key patterns', () => {
      const result = detectSecrets('STRIPE_API_KEY=sk_test_xxx');
      expect(result.found).toBe(true);
    });

    it('passes clean content', () => {
      const result = detectSecrets('public function getUsers(): array {}');
      expect(result.found).toBe(false);
    });

    it('uses custom patterns', () => {
      const result = detectSecrets('MY_CUSTOM_VAR=value', ['custom_var']);
      expect(result.found).toBe(true);
    });

    it('skips invalid regex in custom patterns', () => {
      const result = detectSecrets('some content', ['[invalid', 'password']);
      // should not throw, should still match 'password' pattern
      expect(result.found).toBe(false); // content doesn't contain 'password'
    });

    it('detects multiple secret patterns', () => {
      const result = detectSecrets('DB_PASSWORD=x API_KEY=y TOKEN=z');
      expect(result.found).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(3);
    });

    it('returns empty matches for empty content', () => {
      const result = detectSecrets('');
      expect(result.found).toBe(false);
      expect(result.matches).toEqual([]);
    });

    it('is case insensitive', () => {
      expect(detectSecrets('PASSWORD=x').found).toBe(true);
      expect(detectSecrets('Password=x').found).toBe(true);
      expect(detectSecrets('pAsSwOrD=x').found).toBe(true);
    });
  });

  describe('file size validation', () => {
    it('allows files within limit', () => {
      const result = validateFileSize(500_000);
      expect(result.isOk()).toBe(true);
    });

    it('blocks files exceeding limit', () => {
      const result = validateFileSize(2_000_000);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('SECURITY_VIOLATION');
    });

    it('respects custom limit', () => {
      const result = validateFileSize(100, 50);
      expect(result.isErr()).toBe(true);
    });

    it('allows file exactly at limit', () => {
      const result = validateFileSize(1_048_576); // exactly 1MB
      expect(result.isOk()).toBe(true);
    });

    it('blocks file 1 byte over limit', () => {
      const result = validateFileSize(1_048_577);
      expect(result.isErr()).toBe(true);
    });

    it('allows zero-size file', () => {
      const result = validateFileSize(0);
      expect(result.isOk()).toBe(true);
    });
  });

  describe('artisan whitelist', () => {
    it('allows whitelisted commands', () => {
      expect(validateArtisanCommand('route:list').isOk()).toBe(true);
      expect(validateArtisanCommand('model:show').isOk()).toBe(true);
      expect(validateArtisanCommand('event:list').isOk()).toBe(true);
    });

    it('blocks non-whitelisted commands', () => {
      const result = validateArtisanCommand('migrate:fresh');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('SECURITY_VIOLATION');
    });

    it('blocks arbitrary commands', () => {
      expect(validateArtisanCommand('tinker').isErr()).toBe(true);
      expect(validateArtisanCommand('db:seed').isErr()).toBe(true);
    });
  });

  describe('escapeRegExp', () => {
    it('escapes all regex metacharacters', () => {
      const input = '.*+?^${}()|[]\\';
      const escaped = escapeRegExp(input);
      // The escaped string should match the literal input
      const re = new RegExp(escaped);
      expect(re.test(input)).toBe(true);
    });

    it('leaves alphanumeric strings unchanged', () => {
      expect(escapeRegExp('hello123')).toBe('hello123');
    });

    it('escapes dots and asterisks', () => {
      expect(escapeRegExp('file.ts')).toBe('file\\.ts');
      expect(escapeRegExp('a*b')).toBe('a\\*b');
    });

    it('prevents ReDoS from malicious input', () => {
      // This pattern would cause catastrophic backtracking if unescaped
      const malicious = '(a+)+b';
      const escaped = escapeRegExp(malicious);
      const re = new RegExp(`^${escaped}$`);
      // Should match the literal string, not behave as a nested quantifier
      expect(re.test('(a+)+b')).toBe(true);
      expect(re.test('aaaaab')).toBe(false);
    });
  });

  describe('sensitive file detection', () => {
    // Env files
    it('blocks .env files', () => {
      expect(isSensitiveFile('.env')).toBe(true);
      expect(isSensitiveFile('.env.local')).toBe(true);
      expect(isSensitiveFile('.env.production')).toBe(true);
      expect(isSensitiveFile('config/.env')).toBe(true);
    });

    // Certificates & keys
    it('blocks certificate and key files', () => {
      expect(isSensitiveFile('server.pem')).toBe(true);
      expect(isSensitiveFile('private.key')).toBe(true);
      expect(isSensitiveFile('cert.p12')).toBe(true);
      expect(isSensitiveFile('store.pfx')).toBe(true);
      expect(isSensitiveFile('ca.crt')).toBe(true);
      expect(isSensitiveFile('root.cer')).toBe(true);
    });

    // Keystores
    it('blocks keystore files', () => {
      expect(isSensitiveFile('debug.keystore')).toBe(true);
      expect(isSensitiveFile('release.jks')).toBe(true);
    });

    // Credential files
    it('blocks credential and token files', () => {
      expect(isSensitiveFile('app.credentials')).toBe(true);
      expect(isSensitiveFile('auth.token')).toBe(true);
      expect(isSensitiveFile('api.secrets')).toBe(true);
      expect(isSensitiveFile('credentials.json')).toBe(true);
      expect(isSensitiveFile('service-account-prod.json')).toBe(true);
      expect(isSensitiveFile('service-account.json')).toBe(true);
    });

    // SSH keys
    it('blocks SSH key files', () => {
      expect(isSensitiveFile('id_rsa')).toBe(true);
      expect(isSensitiveFile('id_rsa.pub')).toBe(true);
      expect(isSensitiveFile('id_ed25519')).toBe(true);
      expect(isSensitiveFile('id_ed25519.pub')).toBe(true);
      expect(isSensitiveFile('id_dsa')).toBe(true);
      expect(isSensitiveFile('id_ecdsa')).toBe(true);
    });

    // Auth config files
    it('blocks auth config files', () => {
      expect(isSensitiveFile('.htpasswd')).toBe(true);
      expect(isSensitiveFile('.netrc')).toBe(true);
      expect(isSensitiveFile('.npmrc')).toBe(true);
      expect(isSensitiveFile('.pypirc')).toBe(true);
    });

    // Broad *secret* pattern
    it('blocks files with "secret" in the name', () => {
      expect(isSensitiveFile('app-secret.yml')).toBe(true);
      expect(isSensitiveFile('secrets.yaml')).toBe(true);
    });

    // Doc exemption for *secret*
    it('allows documentation files with "secret" in the name', () => {
      expect(isSensitiveFile('secrets-handling.md')).toBe(false);
      expect(isSensitiveFile('secret-rotation.rst')).toBe(false);
      expect(isSensitiveFile('managing-secrets.txt')).toBe(false);
      expect(isSensitiveFile('secrets.html')).toBe(false);
    });

    // Safe files that should NOT be blocked
    it('allows normal source files', () => {
      expect(isSensitiveFile('app/Models/User.php')).toBe(false);
      expect(isSensitiveFile('src/index.ts')).toBe(false);
      expect(isSensitiveFile('package.json')).toBe(false);
      expect(isSensitiveFile('config/database.php')).toBe(false);
      expect(isSensitiveFile('README.md')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(isSensitiveFile('.ENV')).toBe(true);
      expect(isSensitiveFile('ID_RSA')).toBe(true);
      expect(isSensitiveFile('Server.PEM')).toBe(true);
    });

    it('handles *.env pattern', () => {
      expect(isSensitiveFile('production.env')).toBe(true);
      expect(isSensitiveFile('staging.env')).toBe(true);
    });
  });

  describe('binary buffer detection', () => {
    it('detects null bytes as binary', () => {
      const buf = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]); // "Hel\0o"
      expect(isBinaryBuffer(buf)).toBe(true);
    });

    it('allows pure text content', () => {
      const buf = Buffer.from('export function hello() { return "world"; }', 'utf-8');
      expect(isBinaryBuffer(buf)).toBe(false);
    });

    it('allows empty buffer', () => {
      const buf = Buffer.alloc(0);
      expect(isBinaryBuffer(buf)).toBe(false);
    });

    it('detects null byte at start', () => {
      const buf = Buffer.from([0x00, 0x48, 0x65, 0x6c, 0x6f]);
      expect(isBinaryBuffer(buf)).toBe(true);
    });

    it('detects null byte at 8KB boundary', () => {
      // Null byte right at the end of the scan window
      const buf = Buffer.alloc(8192, 0x41); // 8KB of 'A'
      buf[8191] = 0x00;
      expect(isBinaryBuffer(buf)).toBe(true);
    });

    it('ignores null bytes beyond 8KB', () => {
      // Null byte just past the scan window
      const buf = Buffer.alloc(9000, 0x41); // 9KB of 'A'
      buf[8192] = 0x00;
      expect(isBinaryBuffer(buf)).toBe(false);
    });

    it('detects PNG header as binary', () => {
      // PNG magic bytes
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      expect(isBinaryBuffer(buf)).toBe(true);
    });

    it('allows UTF-8 text with multibyte characters', () => {
      const buf = Buffer.from('const привет = "мир"; // Юникод', 'utf-8');
      expect(isBinaryBuffer(buf)).toBe(false);
    });
  });
});
