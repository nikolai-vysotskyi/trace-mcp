/**
 * PhpEcosystemPlugin — lightweight marker detection for popular standalone
 * PHP packages that don't warrant their own dedicated plugin:
 *
 *   - google/apiclient      → Google API client usage (Google_Client / Google\Client)
 *   - laravel/ai            → Laravel AI prompt/chain invocations (Prism / Ai facade)
 *   - symfony/dom-crawler   → Symfony DomCrawler parsing
 *
 * Tags files via `frameworkRole` only. No edge extraction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

const TRACKED_PACKAGES = [
  'google/apiclient',
  'google/apiclient-services',
  'laravel/ai',
  'prism-php/prism',
  'echolabsdev/prism',
  'symfony/dom-crawler',
];

// google/apiclient
const GOOGLE_CLIENT_IMPORT_RE = /use\s+(?:Google_Client|Google\\Client|Google\\Service\\)/;
const GOOGLE_CLIENT_NEW_RE = /new\s+(?:Google_Client|Google\\Client)\s*\(/;

// laravel/ai (echolabsdev/prism or laravel/ai) — cover common facades/classes
const LARAVEL_AI_IMPORT_RE =
  /use\s+(?:Prism\\Prism\\Prism|EchoLabs\\Prism|Laravel\\Ai|Illuminate\\Support\\Facades\\Ai)\b/;
const LARAVEL_AI_CALL_RE =
  /(?:Prism::|Ai::|->ai\(\)->|->prompt\()\s*(?:text|chat|embeddings|complete|generate|stream)?\s*\(?/;

// symfony/dom-crawler
const DOM_CRAWLER_IMPORT_RE = /use\s+Symfony\\Component\\DomCrawler\\Crawler\b/;
const DOM_CRAWLER_NEW_RE = /new\s+Crawler\s*\(/;

function hasAnyTrackedPackage(require: Record<string, string> | undefined): boolean {
  if (!require) return false;
  for (const pkg of TRACKED_PACKAGES) {
    if (pkg in require) return true;
  }
  return false;
}

export class PhpEcosystemPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'php-ecosystem',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  private enabled = false;

  detect(ctx: ProjectContext): boolean {
    if (ctx.composerJson) {
      const require = ctx.composerJson.require as Record<string, string> | undefined;
      if (hasAnyTrackedPackage(require)) {
        this.enabled = true;
        return true;
      }
    }

    // Fallback: read composer.json from disk.
    try {
      const composerPath = path.join(ctx.rootPath, 'composer.json');
      const content = fs.readFileSync(composerPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (hasAnyTrackedPackage(parsed.require as Record<string, string> | undefined)) {
        this.enabled = true;
        return true;
      }
    } catch {
      // ignore — no composer.json or unparseable
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!this.enabled || language !== 'php') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    if (GOOGLE_CLIENT_IMPORT_RE.test(source) || GOOGLE_CLIENT_NEW_RE.test(source)) {
      result.frameworkRole = 'google_api_client';
    } else if (LARAVEL_AI_IMPORT_RE.test(source) || LARAVEL_AI_CALL_RE.test(source)) {
      result.frameworkRole = 'laravel_ai_call';
    } else if (DOM_CRAWLER_IMPORT_RE.test(source) || DOM_CRAWLER_NEW_RE.test(source)) {
      result.frameworkRole = 'dom_crawler_usage';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
