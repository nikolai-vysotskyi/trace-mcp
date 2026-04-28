/**
 * Subproject Client Scanner — discovers HTTP/gRPC/GraphQL client calls in source code.
 * Scans for fetch(), axios, HttpClient, gRPC stubs, GraphQL queries, etc.
 * Returns raw call sites that can be matched to known API endpoints.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface ScannedClientCall {
  filePath: string;
  line: number;
  callType: string;
  method: string | null;
  urlPattern: string;
  confidence: number;
}

// ════════════════════════════════════════════════════════════════════════
// PATTERNS
// ════════════════════════════════════════════════════════════════════════

interface CallPattern {
  name: string;
  regex: RegExp;
  extractMethod: (match: RegExpMatchArray) => string | null;
  extractUrl: (match: RegExpMatchArray) => string | null;
  confidence: number;
}

const CALL_PATTERNS: CallPattern[] = [
  // fetch('url') / fetch(`url`) — also matches $fetch('url') (Nuxt) since regex isn't anchored.
  {
    name: 'fetch',
    regex: /fetch\s*\(\s*['"`]([^'"`\s]+)['"`]/g,
    extractMethod: () => null,
    extractUrl: (m) => m[1],
    confidence: 0.8,
  },
  // Nuxt composables: useFetch / useLazyFetch / useAsyncData / useLazyAsyncData / useApiFetch(Mounted)
  // Also catches project-specific wrappers that match `use*Fetch*` / `use*Api*`.
  {
    name: 'nuxt-composable',
    regex:
      /\buse(?:Lazy)?(?:Async)?(?:[A-Z]\w*)?(?:Fetch|Api)(?:Mounted)?\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`\s${}]+)['"`]/g,
    extractMethod: () => null,
    extractUrl: (m) => m[1],
    confidence: 0.7,
  },
  // Next.js Route Handlers / server actions — fetch is covered above. Also `NextResponse.rewrite('/url')`.
  {
    name: 'nextjs-rewrite',
    regex: /NextResponse\.(?:rewrite|redirect)\s*\(\s*['"`]([^'"`\s]+)['"`]/g,
    extractMethod: () => null,
    extractUrl: (m) => m[1],
    confidence: 0.7,
  },
  // axios.get/post/put/patch/delete('url')
  {
    name: 'axios',
    regex: /axios\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    extractMethod: (m) => m[1].toUpperCase(),
    extractUrl: (m) => m[2],
    confidence: 0.85,
  },
  // axios({ url: 'url', method: 'GET' })
  {
    name: 'axios-config',
    regex: /axios\s*\(\s*\{[^}]*url\s*:\s*['"`]([^'"`\s]+)['"`]/g,
    extractMethod: () => null,
    extractUrl: (m) => m[1],
    confidence: 0.7,
  },
  // Http::get/post/put/patch/delete('url') (Laravel)
  {
    name: 'laravel-http',
    regex: /Http\s*::\s*(get|post|put|patch|delete|head)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    extractMethod: (m) => m[1].toUpperCase(),
    extractUrl: (m) => m[2],
    confidence: 0.85,
  },
  // $http->get/post('url') or $client->request('GET', 'url')
  {
    name: 'php-http-client',
    regex: /(?:\$\w+)\s*->\s*(get|post|put|patch|delete|request)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    extractMethod: (m) => (m[1].toUpperCase() === 'REQUEST' ? null : m[1].toUpperCase()),
    extractUrl: (m) => m[2],
    confidence: 0.6,
  },
  // requests.get/post('url') (Python) — also matches requests.Session().get(...) via the suffix.
  {
    name: 'python-requests',
    regex: /requests\.(get|post|put|patch|delete|head)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    extractMethod: (m) => m[1].toUpperCase(),
    extractUrl: (m) => m[2],
    confidence: 0.85,
  },
  // httpx.get/post (Python sync) and httpx.AsyncClient().get/post (async)
  {
    name: 'python-httpx',
    regex:
      /httpx\.(?:Async)?(?:Client\s*\([^)]*\)\.)?(get|post|put|patch|delete|head)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    extractMethod: (m) => m[1].toUpperCase(),
    extractUrl: (m) => m[2],
    confidence: 0.8,
  },
  // aiohttp: session.get/post, ClientSession().get/post (Python async)
  {
    name: 'python-aiohttp',
    regex:
      /\b(?:aiohttp\.ClientSession\s*\([^)]*\)\.|session\.)(get|post|put|patch|delete|head)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    extractMethod: (m) => m[1].toUpperCase(),
    extractUrl: (m) => m[2],
    confidence: 0.6,
  },
  // urllib: urllib.request.urlopen('url') / urllib.request.Request('url')
  {
    name: 'python-urllib',
    regex: /urllib\.request\.(?:urlopen|Request)\s*\(\s*['"`]([^'"`\s]+)['"`]/g,
    extractMethod: () => null,
    extractUrl: (m) => m[1],
    confidence: 0.7,
  },
  // http.Get/Post/Do (Go)
  {
    name: 'go-http',
    regex: /http\.(Get|Post|Head)\s*\(\s*"([^"\s]+)"/g,
    extractMethod: (m) => m[1].toUpperCase(),
    extractUrl: (m) => m[2],
    confidence: 0.8,
  },
  // HttpClient / RestTemplate (Java/Kotlin)
  {
    name: 'java-rest',
    regex: /\.(getForObject|getForEntity|postForObject|exchange)\s*\(\s*"([^"\s]+)"/g,
    extractMethod: (m) =>
      m[1].startsWith('get') ? 'GET' : m[1].startsWith('post') ? 'POST' : null,
    extractUrl: (m) => m[2],
    confidence: 0.75,
  },
  // gRPC client stubs: client.MethodName(
  {
    name: 'grpc-call',
    regex: /(?:client|stub)\s*\.\s*(\w+)\s*\(/g,
    extractMethod: () => 'gRPC',
    extractUrl: (m) => m[1],
    confidence: 0.4,
  },
  // GraphQL: query GetUser { ... } or mutation CreatePost { ... }
  // Require PascalCase name + opening brace to avoid matching PHP $query->method()
  {
    name: 'graphql-operation',
    regex: /(?:query|mutation|subscription)\s+([A-Z]\w+)\s*[({]/g,
    extractMethod: (m) => 'GraphQL',
    extractUrl: (m) => m[1],
    confidence: 0.5,
  },
];

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'tmp',
  // Exclude test directories — test HTTP calls are not production API dependencies
  'tests',
  'test',
  'spec',
  '__tests__',
  // Exclude Laravel storage
  'storage',
]);

// Files to skip entirely (generated stubs, IDE helpers, etc.)
const EXCLUDE_FILES = new Set(['_ide_helper.php', '_ide_helper_models.php', '.phpstorm.meta.php']);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.php',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.rb',
  '.rs',
  '.cs',
  '.swift',
  '.dart',
  '.vue',
  '.svelte',
]);

// ════════════════════════════════════════════════════════════════════════
// SCANNER
// ════════════════════════════════════════════════════════════════════════

/**
 * Scan a repository for HTTP/gRPC/GraphQL client calls.
 */
export function scanClientCalls(repoRoot: string): ScannedClientCall[] {
  const results: ScannedClientCall[] = [];
  walkRepo(repoRoot, (relPath, content) => scanFileContent(relPath, content, results));
  logger.debug({ repoRoot, calls: results.length }, 'Client call scan completed');
  return results;
}

/**
 * Scan a repository for URL-like string literals that match known endpoint paths.
 * Used as a post-step to capture calls made through factory helpers / composables
 * where the URL string sits in a lookup table rather than inline with the fetcher.
 *
 * @param repoRoot         Repo to scan.
 * @param knownEndpoints   Endpoints to match against (pre-filter to cross-service
 *                         endpoints in the same project_group for best results).
 */
export function scanEndpointLiterals(
  repoRoot: string,
  knownEndpoints: Array<{ method: string | null; path: string }>,
): ScannedClientCall[] {
  if (knownEndpoints.length === 0) return [];

  // Normalize endpoint path: strip params, collapse trailing slashes. Matches the
  // normalization used by findBestEndpointMatch() so hits line up downstream.
  const normalize = (p: string): string =>
    p
      .replace(/\{[^}]+\}/g, '{*}')
      .replace(/:\w+/g, '{*}')
      .replace(/\[[^\]]+\]/g, '{*}')
      .replace(/\/+$/, '');

  const endpointSet = new Set<string>();
  for (const ep of knownEndpoints) {
    const norm = normalize(ep.path);
    if (norm && norm !== '/' && norm.length > 1) endpointSet.add(norm);
  }
  if (endpointSet.size === 0) return [];

  // Literal URL regex: '/path', "/path", `/path` — must start with `/` and contain
  // characters typical for URL paths (not arbitrary text).
  const urlLiteralRegex = /['"`](\/[a-zA-Z0-9_\-./{}:$[\]]+)['"`]/g;

  const results: ScannedClientCall[] = [];
  walkRepo(repoRoot, (relPath, content) => {
    urlLiteralRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = urlLiteralRegex.exec(content)) !== null) {
      const literal = match[1];
      const norm = normalize(literal);
      if (!endpointSet.has(norm)) continue;

      // Line number
      let lineNum = 1;
      for (let i = 0; i < match.index && i < content.length; i++) {
        if (content[i] === '\n') lineNum++;
      }

      results.push({
        filePath: relPath,
        line: lineNum,
        callType: 'literal-match',
        method: null,
        urlPattern: literal,
        confidence: 0.5,
      });
    }
  });

  logger.debug({ repoRoot, calls: results.length }, 'Endpoint literal scan completed');
  return results;
}

function walkRepo(repoRoot: string, onFile: (relPath: string, content: string) => void): void {
  walkAndInvoke(repoRoot, repoRoot, onFile, 0);
}

function walkAndInvoke(
  dir: string,
  repoRoot: string,
  onFile: (relPath: string, content: string) => void,
  depth: number,
): void {
  if (depth > 10) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndInvoke(fullPath, repoRoot, onFile, depth + 1);
    } else if (
      entry.isFile() &&
      CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      !EXCLUDE_FILES.has(entry.name)
    ) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relPath = path.relative(repoRoot, fullPath);
        onFile(relPath, content);
      } catch {
        // skip unreadable files
      }
    }
  }
}

function scanFileContent(filePath: string, content: string, results: ScannedClientCall[]): void {
  const _lines = content.split('\n');

  for (const pattern of CALL_PATTERNS) {
    // Reset regex state
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.regex.exec(content)) !== null) {
      const url = pattern.extractUrl(match);
      if (!url) continue;

      // Skip obviously internal paths and relative imports
      if (url.startsWith('./') || url.startsWith('../') || url.startsWith('#')) continue;
      // Must look like an API path or URL
      if (!url.startsWith('/') && !url.startsWith('http') && !url.includes('.')) {
        // For gRPC/GraphQL, method names are OK
        if (pattern.name !== 'grpc-call' && pattern.name !== 'graphql-operation') continue;
      }
      // Skip overly generic URLs — root path '/' matches every project
      if (url === '/' || url === '') continue;

      // Find line number
      const charIndex = match.index;
      let lineNum = 1;
      for (let i = 0; i < charIndex && i < content.length; i++) {
        if (content[i] === '\n') lineNum++;
      }

      results.push({
        filePath,
        line: lineNum,
        callType: pattern.name,
        method: pattern.extractMethod(match),
        urlPattern: url,
        confidence: pattern.confidence,
      });
    }
  }
}
