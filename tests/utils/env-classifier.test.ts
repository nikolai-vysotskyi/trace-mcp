import { describe, expect, it } from 'vitest';
import {
  classifyEnvFile,
  detectManagedEmitter,
  MANAGED_EMITTER_ALLOWLIST,
} from '../../src/utils/env-classifier.js';

describe('env-classifier', () => {
  describe('classifyEnvFile', () => {
    it('returns not-env for non-.env paths', () => {
      const result = classifyEnvFile('/abs/src/index.ts');
      expect(result.tier).toBe('not-env');
    });

    it('classifies .env.example as template by filename alone', () => {
      const result = classifyEnvFile('/abs/repo/.env.example');
      expect(result.tier).toBe('template');
    });

    it('classifies .env.sample, .env.template, .env.defaults as template', () => {
      expect(classifyEnvFile('/abs/.env.sample').tier).toBe('template');
      expect(classifyEnvFile('/abs/.env.template').tier).toBe('template');
      expect(classifyEnvFile('/abs/.env.defaults').tier).toBe('template');
      expect(classifyEnvFile('/abs/.env.docs').tier).toBe('template');
    });

    it('classifies a bare .env without head bytes as user-secret', () => {
      const result = classifyEnvFile('/abs/repo/.env');
      expect(result.tier).toBe('user-secret');
    });

    it('classifies .env.local as user-secret', () => {
      expect(classifyEnvFile('/abs/.env.local').tier).toBe('user-secret');
      expect(classifyEnvFile('/abs/.env.production').tier).toBe('user-secret');
    });

    it('recognises trace-mcp-managed file via header marker', () => {
      const head =
        '# Managed by trace-mcp postinstall — do not edit by hand.\nTRACE_MCP_VERSION="1.39.3"\n';
      const result = classifyEnvFile('/Users/x/.trace-mcp/launcher.env', head);
      expect(result.tier).toBe('managed');
      expect(result.reasons.join(' ')).toContain('trace-mcp');
    });

    it('ignores managed-by-claim from emitters not in the allowlist', () => {
      const head = '# Managed by attacker\nAWS_SECRET_KEY=sk-abc123\n';
      const result = classifyEnvFile('/tmp/fake.env', head);
      expect(result.tier).toBe('user-secret');
    });

    it('ignores a managed marker that is not on the first non-blank line', () => {
      // Smuggling protection: a real managed file declares its emitter at the top.
      const head = 'KEY=value\n# Managed by trace-mcp\n';
      const result = classifyEnvFile('/tmp/x.env', head);
      expect(result.tier).toBe('user-secret');
    });

    it('skips blank lines when looking for the marker', () => {
      const head = '\n\n# Managed by trace-mcp\nKEY=value\n';
      const result = classifyEnvFile('/tmp/x.env', head);
      expect(result.tier).toBe('managed');
    });

    it('template name wins over managed header (defense in depth)', () => {
      // If a file is named .env.example we trust the name; we don't downgrade
      // it just because someone added a managed-by header.
      const head = '# Managed by trace-mcp\nKEY=value\n';
      const result = classifyEnvFile('/abs/.env.example', head);
      expect(result.tier).toBe('template');
    });
  });

  describe('detectManagedEmitter', () => {
    it('extracts emitter name when in allowlist', () => {
      expect(detectManagedEmitter('# Managed by trace-mcp\n')).toBe('trace-mcp');
    });

    it('returns undefined for unknown emitters', () => {
      expect(detectManagedEmitter('# Managed by something-else\n')).toBeUndefined();
    });

    it('returns undefined when the first non-blank line is not a marker', () => {
      expect(detectManagedEmitter('KEY=value\n# Managed by trace-mcp\n')).toBeUndefined();
    });

    it('allowlist contains trace-mcp as the only entry initially', () => {
      expect(MANAGED_EMITTER_ALLOWLIST).toContain('trace-mcp');
    });
  });
});
