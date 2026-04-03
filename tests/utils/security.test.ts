import { describe, it, expect } from 'vitest';
import { validatePath, detectSecrets, validateFileSize, validateArtisanCommand, escapeRegExp } from '../../src/utils/security.js';

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
});
