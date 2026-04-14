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
  // fetch('url') / fetch(`url`)
  {
    name: 'fetch',
    regex: /fetch\s*\(\s*['"`]([^'"`\s]+)['"`]/g,
    extractMethod: () => null,
    extractUrl: (m) => m[1],
    confidence: 0.8,
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
    extractMethod: (m) => m[1].toUpperCase() === 'REQUEST' ? null : m[1].toUpperCase(),
    extractUrl: (m) => m[2],
    confidence: 0.6,
  },
  // requests.get/post('url') (Python)
  {
    name: 'python-requests',
    regex: /requests\.(get|post|put|patch|delete|head)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    extractMethod: (m) => m[1].toUpperCase(),
    extractUrl: (m) => m[2],
    confidence: 0.85,
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
    extractMethod: (m) => m[1].startsWith('get') ? 'GET' : m[1].startsWith('post') ? 'POST' : null,
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
  // GraphQL: query { ... } or mutation { ... } in template literals
  {
    name: 'graphql-operation',
    regex: /(?:query|mutation|subscription)\s+(\w+)/g,
    extractMethod: (m) => 'GraphQL',
    extractUrl: (m) => m[1],
    confidence: 0.5,
  },
];

const EXCLUDE_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__',
  '.next', '.nuxt', 'coverage', '.cache', 'tmp',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.php', '.py', '.go', '.java', '.kt', '.kts',
  '.rb', '.rs', '.cs', '.swift', '.dart',
  '.vue', '.svelte',
]);

// ════════════════════════════════════════════════════════════════════════
// SCANNER
// ════════════════════════════════════════════════════════════════════════

/**
 * Scan a repository for HTTP/gRPC/GraphQL client calls.
 */
export function scanClientCalls(repoRoot: string): ScannedClientCall[] {
  const results: ScannedClientCall[] = [];
  walkAndScan(repoRoot, repoRoot, results, 0);
  logger.debug({ repoRoot, calls: results.length }, 'Client call scan completed');
  return results;
}

function walkAndScan(dir: string, repoRoot: string, results: ScannedClientCall[], depth: number): void {
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
      walkAndScan(fullPath, repoRoot, results, depth + 1);
    } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relPath = path.relative(repoRoot, fullPath);
        scanFileContent(relPath, content, results);
      } catch {
        // skip unreadable files
      }
    }
  }
}

function scanFileContent(filePath: string, content: string, results: ScannedClientCall[]): void {
  const lines = content.split('\n');

  for (const pattern of CALL_PATTERNS) {
    // Reset regex state
    pattern.regex.lastIndex = 0;
    let match;

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
