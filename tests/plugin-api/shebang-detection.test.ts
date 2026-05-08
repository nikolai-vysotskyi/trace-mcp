import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../../src/plugin-api/registry.js';

describe('PluginRegistry — shebang fallback', () => {
  const registry = PluginRegistry.createWithDefaults();

  it('returns undefined for content without a shebang', () => {
    expect(registry.getLanguagePluginByShebang(Buffer.from('hello world'))).toBeUndefined();
    expect(registry.getLanguagePluginByShebang('')).toBeUndefined();
  });

  it('resolves common interpreters by shebang', () => {
    const cases: Array<[string, string]> = [
      ['#!/usr/bin/env python3\n...', 'python-language'],
      ['#!/usr/bin/python\n...', 'python-language'],
      ['#!/bin/bash\n...', 'bash-language'],
      ['#!/usr/bin/env bash\n...', 'bash-language'],
      ['#!/bin/sh\n...', 'bash-language'],
      ['#!/usr/bin/env zsh\n...', 'bash-language'],
      ['#!/usr/bin/env node\n...', 'typescript-language'],
      ['#!/usr/bin/env bun\n...', 'typescript-language'],
      ['#!/usr/bin/env ruby\n...', 'ruby-language'],
      ['#!/usr/bin/perl\n...', 'perl-language'],
      ['#!/usr/bin/env php\n...', 'php-language'],
      ['#!/usr/bin/env lua\n...', 'lua-language'],
      ['#!/usr/bin/env Rscript\n...', 'r-language'],
      ['#!/usr/bin/env julia\n...', 'julia-language'],
    ];

    for (const [shebang, pluginName] of cases) {
      const plugin = registry.getLanguagePluginByShebang(shebang);
      expect(plugin, `shebang ${shebang.split('\n')[0]}`).toBeDefined();
      expect(plugin?.manifest.name).toBe(pluginName);
    }
  });

  it('handles env-style shebangs with interpreter args', () => {
    // `#!/usr/bin/env -S python3 -u` — args are common; we only care about
    // the first non-flag word that is the interpreter.
    const plugin = registry.getLanguagePluginByShebang('#!/usr/bin/env python3 -u\n...');
    expect(plugin?.manifest.name).toBe('python-language');
  });

  it('returns undefined for unknown interpreters', () => {
    expect(
      registry.getLanguagePluginByShebang('#!/usr/local/bin/madeup-lang\n...'),
    ).toBeUndefined();
  });

  it('falls back to shebang when extension lookup fails', () => {
    const plugin = registry.getLanguagePluginForFileWithFallback(
      'bin/deploy',
      '#!/usr/bin/env bash\n',
    );
    expect(plugin?.manifest.name).toBe('bash-language');
  });

  it('prefers extension over shebang when both are present', () => {
    // Even if a .ts file has a node shebang, the .ts plugin must win.
    const plugin = registry.getLanguagePluginForFileWithFallback(
      'bin/cli.ts',
      '#!/usr/bin/env node\n',
    );
    expect(plugin?.manifest.name).toBe('typescript-language');
  });

  it('returns undefined when extension is unknown and no content given', () => {
    expect(registry.getLanguagePluginForFileWithFallback('bin/deploy')).toBeUndefined();
  });
});
