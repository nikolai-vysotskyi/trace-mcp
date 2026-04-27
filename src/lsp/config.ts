/**
 * LSP server auto-detection and configuration resolution.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceMcpConfig } from '../config.js';
import { logger } from '../logger.js';

export interface LspServerSpec {
  language: string;
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
  timeoutMs: number;
}

interface KnownServer {
  language: string;
  command: string;
  args: string[];
  detect: (rootPath: string) => boolean;
  initializationOptions?: Record<string, unknown>;
}

const KNOWN_SERVERS: KnownServer[] = [
  {
    language: 'typescript',
    command: 'npx',
    args: ['typescript-language-server', '--stdio'],
    detect: (root) =>
      existsSync(join(root, 'tsconfig.json')) || existsSync(join(root, 'package.json')),
    initializationOptions: {
      preferences: { includeInlayParameterNameHints: 'none' },
    },
  },
  {
    language: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    detect: (root) =>
      existsSync(join(root, 'pyproject.toml')) ||
      existsSync(join(root, 'requirements.txt')) ||
      existsSync(join(root, 'setup.py')),
  },
  {
    language: 'go',
    command: 'gopls',
    args: ['serve'],
    detect: (root) => existsSync(join(root, 'go.mod')),
  },
  {
    language: 'rust',
    command: 'rust-analyzer',
    args: [],
    detect: (root) => existsSync(join(root, 'Cargo.toml')),
  },
];

/** Language extensions mapped to LSP language IDs */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'typescript', // tsserver handles JS too
  '.jsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/** Map trace-mcp file language string to LSP language ID */
export function fileLanguageToLspLanguage(fileLanguage: string | null): string | null {
  if (!fileLanguage) return null;
  const map: Record<string, string> = {
    typescript: 'typescript',
    javascript: 'typescript',
    python: 'python',
    go: 'go',
    rust: 'rust',
  };
  return map[fileLanguage] ?? null;
}

/** Check if a command is available on PATH */
function isCommandAvailable(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which LSP servers to start based on config + auto-detection.
 * Returns specs for servers that are both relevant and available.
 */
export function resolveServers(
  config: TraceMcpConfig,
  rootPath: string,
  indexedLanguages: Set<string>,
): LspServerSpec[] {
  const specs: LspServerSpec[] = [];
  const seen = new Set<string>();

  // 1. Explicit server configs from user
  if (config.lsp?.servers) {
    for (const [language, serverConfig] of Object.entries(config.lsp.servers)) {
      if (seen.has(language)) continue;
      seen.add(language);

      if (!isCommandAvailable(serverConfig.command)) {
        logger.info(
          { language, command: serverConfig.command },
          'LSP server command not found, skipping',
        );
        continue;
      }

      specs.push({
        language,
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        initializationOptions: serverConfig.initializationOptions as
          | Record<string, unknown>
          | undefined,
        timeoutMs: serverConfig.timeout_ms ?? 30_000,
      });
    }
  }

  // 2. Auto-detect additional servers
  if (config.lsp?.auto_detect !== false) {
    for (const known of KNOWN_SERVERS) {
      if (seen.has(known.language)) continue;
      if (!indexedLanguages.has(known.language)) continue;
      if (!known.detect(rootPath)) continue;
      if (!isCommandAvailable(known.command)) {
        logger.debug(
          { language: known.language, command: known.command },
          'LSP server not installed',
        );
        continue;
      }

      seen.add(known.language);
      specs.push({
        language: known.language,
        command: known.command,
        args: known.args,
        initializationOptions: known.initializationOptions,
        timeoutMs: config.lsp?.servers?.[known.language]?.timeout_ms ?? 30_000,
      });
    }
  }

  return specs;
}
