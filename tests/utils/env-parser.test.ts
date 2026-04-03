import { describe, it, expect } from 'vitest';
import { parseEnvFile, redactEnvFile, type EnvEntry } from '../../src/utils/env-parser.js';

describe('env-parser', () => {
  describe('parseEnvFile', () => {
    it('parses basic KEY=VALUE pairs', () => {
      const entries = parseEnvFile('APP_NAME=MyApp\nAPP_DEBUG=true\n');
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ key: 'APP_NAME', valueType: 'string', line: 1 });
      expect(entries[1]).toMatchObject({ key: 'APP_DEBUG', valueType: 'boolean', line: 2 });
    });

    it('handles empty values', () => {
      const entries = parseEnvFile('EMPTY_VAR=\n');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ key: 'EMPTY_VAR', valueType: 'empty', valueFormat: null });
    });

    it('handles quoted values', () => {
      const entries = parseEnvFile('QUOTED="hello world"\nSINGLE=\'test\'\n');
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ key: 'QUOTED', quoted: true, valueType: 'string' });
      expect(entries[1]).toMatchObject({ key: 'SINGLE', quoted: true, valueType: 'string' });
    });

    it('strips inline comments for unquoted values', () => {
      const entries = parseEnvFile('PORT=3000 # default port\n');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ key: 'PORT', valueType: 'number', valueFormat: 'integer' });
    });

    it('preserves comments as context', () => {
      const entries = parseEnvFile('# Database configuration\nDB_HOST=localhost\n');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        key: 'DB_HOST',
        comment: 'Database configuration',
      });
    });

    it('handles export prefix', () => {
      const entries = parseEnvFile('export API_KEY=abc123\n');
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('API_KEY');
    });

    it('skips blank lines and resets comments', () => {
      const entries = parseEnvFile('# Section 1\n\nKEY=value\n');
      expect(entries).toHaveLength(1);
      expect(entries[0].comment).toBeNull();
    });

    it('accumulates multi-line comments', () => {
      const entries = parseEnvFile('# Line 1\n# Line 2\nKEY=value\n');
      expect(entries).toHaveLength(1);
      expect(entries[0].comment).toBe('Line 1 Line 2');
    });
  });

  describe('type inference', () => {
    const infer = (value: string): Pick<EnvEntry, 'valueType' | 'valueFormat'> => {
      const entries = parseEnvFile(`KEY=${value}\n`);
      return { valueType: entries[0].valueType, valueFormat: entries[0].valueFormat };
    };

    it('detects booleans', () => {
      expect(infer('true')).toMatchObject({ valueType: 'boolean' });
      expect(infer('false')).toMatchObject({ valueType: 'boolean' });
      expect(infer('yes')).toMatchObject({ valueType: 'boolean' });
      expect(infer('no')).toMatchObject({ valueType: 'boolean' });
      expect(infer('on')).toMatchObject({ valueType: 'boolean' });
      expect(infer('off')).toMatchObject({ valueType: 'boolean' });
    });

    it('detects integers', () => {
      expect(infer('3000')).toMatchObject({ valueType: 'number', valueFormat: 'integer' });
      expect(infer('-1')).toMatchObject({ valueType: 'number', valueFormat: 'integer' });
    });

    it('detects floats', () => {
      expect(infer('3.14')).toMatchObject({ valueType: 'number', valueFormat: 'float' });
    });

    it('detects URLs', () => {
      expect(infer('https://example.com')).toMatchObject({ valueType: 'string', valueFormat: 'url' });
      expect(infer('redis://localhost:6379')).toMatchObject({ valueType: 'string', valueFormat: 'url' });
      expect(infer('mysql://user:pass@host/db')).toMatchObject({ valueType: 'string', valueFormat: 'url' });
      expect(infer('mongodb+srv://cluster.example.net')).toMatchObject({ valueType: 'string', valueFormat: 'url' });
    });

    it('detects emails', () => {
      expect(infer('user@example.com')).toMatchObject({ valueType: 'string', valueFormat: 'email' });
    });

    it('detects IPs', () => {
      expect(infer('192.168.1.1')).toMatchObject({ valueType: 'string', valueFormat: 'ip' });
    });

    it('detects host:port', () => {
      expect(infer('localhost:6379')).toMatchObject({ valueType: 'string', valueFormat: 'host:port' });
    });

    it('detects UUIDs', () => {
      expect(infer('550e8400-e29b-41d4-a716-446655440000')).toMatchObject({ valueType: 'string', valueFormat: 'uuid' });
    });

    it('detects paths', () => {
      expect(infer('/var/log/app')).toMatchObject({ valueType: 'string', valueFormat: 'path' });
    });

    it('detects JSON', () => {
      expect(infer('{"key":"val"}')).toMatchObject({ valueType: 'string', valueFormat: 'json' });
      expect(infer('[1,2,3]')).toMatchObject({ valueType: 'string', valueFormat: 'json' });
    });

    it('detects CSV', () => {
      expect(infer('a,b,c')).toMatchObject({ valueType: 'string', valueFormat: 'csv' });
    });

    it('detects durations', () => {
      expect(infer('30s')).toMatchObject({ valueType: 'string', valueFormat: 'duration' });
      expect(infer('500ms')).toMatchObject({ valueType: 'string', valueFormat: 'duration' });
      expect(infer('5m')).toMatchObject({ valueType: 'string', valueFormat: 'duration' });
    });

    it('detects semver', () => {
      expect(infer('1.2.3')).toMatchObject({ valueType: 'string', valueFormat: 'semver' });
      expect(infer('v2.0.0-beta.1')).toMatchObject({ valueType: 'string', valueFormat: 'semver' });
    });

    it('detects hex strings', () => {
      expect(infer('0xdeadbeef')).toMatchObject({ valueType: 'string', valueFormat: 'hex' });
      expect(infer('abcdef0123456789')).toMatchObject({ valueType: 'string', valueFormat: 'hex' });
    });

    it('returns plain string for unrecognized formats', () => {
      expect(infer('just-a-string')).toMatchObject({ valueType: 'string', valueFormat: null });
    });
  });

  describe('redactEnvFile', () => {
    it('replaces values with type hints', () => {
      const input = [
        '# App config',
        'APP_NAME=MyApp',
        'APP_DEBUG=true',
        'APP_URL=https://example.com',
        'DB_PORT=5432',
        'EMPTY=',
        '',
        '# Secrets',
        'API_KEY=sk_test_1234567890abcdef',
      ].join('\n');

      const result = redactEnvFile(input);
      const lines = result.split('\n');

      expect(lines[0]).toBe('# App config');
      expect(lines[1]).toBe('APP_NAME=<string>');
      expect(lines[2]).toBe('APP_DEBUG=<boolean>');
      expect(lines[3]).toBe('APP_URL=<string:url>');
      expect(lines[4]).toBe('DB_PORT=<number:integer>');
      expect(lines[5]).toBe('EMPTY=<empty>');
      expect(lines[6]).toBe('');
      expect(lines[7]).toBe('# Secrets');
      expect(lines[8]).toBe('API_KEY=<string>');
    });

    it('never leaks actual values', () => {
      const input = 'SECRET_KEY=super-secret-password-123\nDB_PASSWORD=hunter2\n';
      const result = redactEnvFile(input);
      expect(result).not.toContain('super-secret-password-123');
      expect(result).not.toContain('hunter2');
    });
  });

  describe('isEnvFile (via source-reader)', () => {
    // Test the utility indirectly through a realistic .env file scenario
    it('parses a realistic .env file', () => {
      const realistic = [
        '# Application',
        'APP_NAME=trace-mcp',
        'APP_ENV=production',
        'APP_KEY=base64:abc123def456ghi789jkl012mno345pq=',
        'APP_DEBUG=false',
        'APP_URL=https://trace-mcp.dev',
        '',
        '# Database',
        'DB_CONNECTION=mysql',
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_DATABASE=trace',
        'DB_USERNAME=root',
        'DB_PASSWORD=',
        '',
        '# Redis',
        'REDIS_HOST=redis.internal:6379',
        'REDIS_PASSWORD=null',
        '',
        '# Mail',
        'MAIL_FROM_ADDRESS=no-reply@trace-mcp.dev',
        '',
        '# Misc',
        'LOG_CHANNEL=stack',
        'BROADCAST_DRIVER=pusher',
        'CACHE_TTL=3600',
        'ALLOWED_ORIGINS=http://localhost:3000,https://app.trace-mcp.dev',
        'SESSION_LIFETIME=120',
        'VITE_APP_VERSION=2.1.0',
      ].join('\n');

      const entries = parseEnvFile(realistic);
      expect(entries.length).toBe(20);

      // Verify some specific type inferences
      const byKey = new Map(entries.map((e) => [e.key, e]));

      expect(byKey.get('APP_DEBUG')!.valueType).toBe('boolean');
      expect(byKey.get('APP_URL')!.valueFormat).toBe('url');
      expect(byKey.get('DB_HOST')!.valueFormat).toBe('ip');
      expect(byKey.get('DB_PORT')!.valueFormat).toBe('integer');
      expect(byKey.get('DB_PASSWORD')!.valueType).toBe('empty');
      expect(byKey.get('REDIS_HOST')!.valueFormat).toBe('host:port');
      expect(byKey.get('MAIL_FROM_ADDRESS')!.valueFormat).toBe('email');
      expect(byKey.get('CACHE_TTL')!.valueFormat).toBe('integer');
      // ALLOWED_ORIGINS starts with http:// so URL wins over CSV — expected
      expect(byKey.get('ALLOWED_ORIGINS')!.valueFormat).toBe('url');
      expect(byKey.get('VITE_APP_VERSION')!.valueFormat).toBe('semver');

      // Verify comments are attached
      expect(byKey.get('APP_NAME')!.comment).toBe('Application');
      expect(byKey.get('DB_CONNECTION')!.comment).toBe('Database');
      expect(byKey.get('REDIS_HOST')!.comment).toBe('Redis');
    });
  });
});
