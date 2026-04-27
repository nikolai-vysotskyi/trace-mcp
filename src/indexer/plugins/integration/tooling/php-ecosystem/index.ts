/**
 * PhpEcosystemPlugin — lightweight marker detection for popular standalone
 * PHP packages that don't warrant their own dedicated plugin:
 *
 *   - google/apiclient              → Google API client usage (Google_Client / Google\Client)
 *   - google/analytics-data         → Google Analytics Data API
 *   - google/auth                   → Google Auth library
 *   - laravel/ai                    → Laravel AI prompt/chain invocations (Prism / Ai facade)
 *   - symfony/dom-crawler           → Symfony DomCrawler parsing
 *   - doctrine/dbal                 → Doctrine DBAL connection / query builder usage
 *   - guzzlehttp/guzzle             → Guzzle HTTP client usage
 *   - maatwebsite/excel             → Laravel Excel import/export usage
 *   - meilisearch/meilisearch-php   → Meilisearch PHP client usage
 *   - intervention/image            → Intervention Image processing
 *   - league/flysystem-aws-s3-v3    → Flysystem S3 adapter
 *   - amocrm/amocrm-api-library     → amoCRM API client
 *   - reinink/advanced-eloquent     → Advanced Eloquent extensions
 *   - spatie/laravel-translation-loader → DB-backed translation loader
 *   - titasgailius/search-relations → Nova search relations
 *   - yoomoney/yookassa-sdk-php     → YooKassa payment SDK
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
  'google/analytics-data',
  'google/auth',
  'laravel/ai',
  'prism-php/prism',
  'echolabsdev/prism',
  'symfony/dom-crawler',
  'doctrine/dbal',
  'guzzlehttp/guzzle',
  'maatwebsite/excel',
  'meilisearch/meilisearch-php',
  'intervention/image',
  'intervention/image-laravel',
  'league/csv',
  'league/flysystem-aws-s3-v3',
  'amocrm/amocrm-api-library',
  'reinink/advanced-eloquent',
  'spatie/laravel-translation-loader',
  'titasgailius/search-relations',
  'yoomoney/yookassa-sdk-php',
];

/**
 * Detection strategy: each role has an array of "any-of" regex patterns.
 * First role with a matching pattern wins (file gets a single frameworkRole).
 *
 * Patterns favor broad FQN matches (e.g. `\bGuzzleHttp\\`) because these
 * unambiguously cover imports, type hints, DocBlock references, and inline
 * `\FullyQualified\Name` usage in one shot. Method-name patterns are only
 * used when the method is distinctive enough to survive as a standalone
 * signal without the namespace context (e.g. `fetchAssociative` is unique
 * to Doctrine DBAL 3+).
 */
interface DetectorRule {
  role: string;
  patterns: RegExp[];
}

const DETECTORS: DetectorRule[] = [
  // More specific Google detectors first (Analytics Data, Auth) so they win
  // before the generic Google\Client|Service fallback.
  {
    role: 'google_analytics_data_usage',
    patterns: [/\bGoogle\\Analytics\\Data\\/],
  },
  {
    role: 'google_auth_usage',
    patterns: [/\bGoogle\\Auth\\/],
  },
  {
    role: 'google_api_client',
    patterns: [/\bGoogle_Client\b/, /\bGoogle\\(?:Client|Service)\b/],
  },
  {
    role: 'laravel_ai_call',
    patterns: [
      /use\s+(?:Prism\\Prism\\Prism|EchoLabs\\Prism|Laravel\\Ai|Illuminate\\Support\\Facades\\Ai)\b/,
      /(?:Prism::|Ai::|->ai\(\)->|->prompt\()\s*(?:text|chat|embeddings|complete|generate|stream)?\s*\(?/,
    ],
  },
  {
    role: 'dom_crawler_usage',
    patterns: [/\bSymfony\\Component\\DomCrawler\\/, /new\s+Crawler\s*\(/],
  },
  {
    role: 'doctrine_dbal_usage',
    patterns: [
      // Broad FQN — covers imports, type hints (`DBAL\Connection $conn`), DocBlock refs
      /\bDoctrine\\DBAL\\/,
      // Static factory — unique to DBAL
      /\bDriverManager::getConnection\b/,
      // DBAL 3+ fetch methods — distinctive names, safe as standalone signal
      /->(?:fetchAssociative|fetchAllAssociative|fetchAllKeyValue|fetchAllAssociativeIndexed|fetchAllNumeric|fetchAllFirstColumn|fetchNumeric|fetchFirstColumn)\s*\(/,
      // Common DBAL execution methods (executeQuery/Statement/Update) — catch DI-injected $conn
      /->(?:executeQuery|executeStatement|executeUpdate)\s*\(/,
      // Query builder entrypoint
      /->createQueryBuilder\s*\(\s*\)/,
    ],
  },
  {
    role: 'guzzle_http_client',
    patterns: [
      // Broad FQN — covers `use GuzzleHttp\...`, `\GuzzleHttp\ClientInterface $http`, DocBlocks
      /\bGuzzleHttp\\/,
      // Distinctive class used in Guzzle config arrays
      /\bRequestOptions::/,
    ],
  },
  {
    role: 'maatwebsite_excel_usage',
    patterns: [
      // Broad FQN — covers Facades\Excel, Concerns\FromCollection, Events\, Row, etc.
      /\bMaatwebsite\\Excel\\/,
      // Facade — gated on Maatwebsite package being in composer.json (checked in detect())
      /\bExcel::(?:import|export|download|store|queue|queueImport|queueExport|toArray|toCollection|raw)\s*\(/,
    ],
  },
  {
    role: 'meilisearch_client',
    patterns: [
      // Broad FQN — covers v1+ (Meilisearch) and pre-v1 (MeiliSearch) casing
      /\bMeili[Ss]earch\\/,
    ],
  },
  {
    role: 'intervention_image_usage',
    // Covers both `intervention/image` core (`Intervention\Image\`) and the
    // Laravel bridge (`intervention/image-laravel`, which exposes the same FQN
    // plus its Laravel `ImageManager` facade resolver).
    patterns: [/\bIntervention\\Image\\/],
  },
  {
    role: 'league_csv_usage',
    patterns: [
      /\bLeague\\Csv\\/,
      // Common static constructors distinctive to league/csv
      /\b(?:Reader|Writer)::(?:createFromPath|createFromString|createFromStream|createFromFileObject)\s*\(/,
    ],
  },
  {
    role: 'flysystem_s3_adapter_usage',
    patterns: [/\bLeague\\Flysystem\\AwsS3V3\\/, /\bAwsS3V3Adapter\b/],
  },
  {
    role: 'amocrm_api_usage',
    patterns: [/\bAmoCRM\\/],
  },
  {
    role: 'advanced_eloquent_usage',
    patterns: [/\bReinink\\AdvancedEloquent\\/],
  },
  {
    role: 'spatie_translation_loader_usage',
    patterns: [/\bSpatie\\TranslationLoader\\/],
  },
  {
    role: 'search_relations_usage',
    patterns: [/\bTitasgailius\\SearchRelations\\/],
  },
  {
    role: 'yookassa_usage',
    patterns: [/\bYooKassa\\/],
  },
];

function detectRole(source: string): string | undefined {
  for (const { role, patterns } of DETECTORS) {
    for (const pattern of patterns) {
      if (pattern.test(source)) return role;
    }
  }
  return undefined;
}

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
    version: '1.2.0',
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

    const role = detectRole(source);
    if (role) {
      result.frameworkRole = role;
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
