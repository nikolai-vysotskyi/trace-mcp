/**
 * PinoPlugin — detects logging libraries (pino, winston, bunyan, log4js)
 * and extracts logger creation patterns and log-level usage.
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

const LOGGING_PACKAGES = ['pino', 'winston', 'bunyan', 'log4js', 'pino-pretty', 'pino-http'];

// pino(), pino({...}), createLogger({...}), winston.createLogger(...)
const LOGGER_CREATE_RE =
  /(?:pino|createLogger|getLogger|winston\.createLogger|bunyan\.createLogger)\s*\(/g;

// logger.info(...), logger.warn(...), logger.error(...), logger.debug(...), logger.fatal(...)
const LOG_CALL_RE = /(?:logger|log)\s*\.\s*(trace|debug|info|warn|error|fatal)\s*\(/g;

// level: 'info', level: 'debug'
const _LOG_LEVEL_RE = /level\s*:\s*['"](\w+)['"]/g;

// Pino child logger: logger.child({...})
const CHILD_LOGGER_RE = /\.child\s*\(\s*\{/g;

// Import detection
const LOGGING_IMPORT_RE = /(?:import|require)\s*(?:\(|{)?\s*.*(?:pino|winston|bunyan|log4js)\b/;

export class PinoPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'pino',
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
      for (const pkg of LOGGING_PACKAGES) {
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
      for (const p of LOGGING_PACKAGES) {
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
        { name: 'logger_creates', category: 'logging', description: 'Logger instance creation' },
        { name: 'logger_child', category: 'logging', description: 'Child logger derivation' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    const hasImport = LOGGING_IMPORT_RE.test(source);
    const hasCreation = LOGGER_CREATE_RE.test(source);
    const hasChildLogger = CHILD_LOGGER_RE.test(source);
    const hasLogCalls = LOG_CALL_RE.test(source);

    if (hasCreation) {
      result.frameworkRole = 'logger_config';
    } else if (hasChildLogger) {
      result.frameworkRole = 'logger_child';
    } else if (hasImport) {
      result.frameworkRole = 'logger_usage';
    } else if (hasLogCalls) {
      result.frameworkRole = 'logger_usage';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
