/**
 * Heuristic domain classifier — path-based and name-based domain inference.
 * No AI required. Works offline.
 */

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface DomainSuggestion {
  domainPath: string[];  // e.g. ['payments', 'refunds']
  confidence: number;    // 0..1
  reason: string;
}

export interface ClassifiableSymbol {
  id: number;
  name: string;
  kind: string;
  fqn: string | null;
  filePath: string;
  frameworkRole?: string | null;
}

// ════════════════════════════════════════════════════════════════════════
// COMMON DOMAIN PATTERNS
// ════════════════════════════════════════════════════════════════════════

const DIRECTORY_DOMAIN_MAP: Record<string, string> = {
  auth: 'authentication',
  authentication: 'authentication',
  login: 'authentication',
  billing: 'billing',
  payment: 'payments',
  payments: 'payments',
  checkout: 'payments',
  subscription: 'subscriptions',
  subscriptions: 'subscriptions',
  user: 'users',
  users: 'users',
  account: 'users',
  accounts: 'users',
  profile: 'users',
  notification: 'notifications',
  notifications: 'notifications',
  email: 'notifications',
  admin: 'admin',
  dashboard: 'admin',
  order: 'orders',
  orders: 'orders',
  product: 'products',
  products: 'products',
  catalog: 'products',
  inventory: 'inventory',
  shipping: 'shipping',
  delivery: 'shipping',
  search: 'search',
  report: 'reporting',
  reports: 'reporting',
  reporting: 'reporting',
  analytics: 'analytics',
  settings: 'settings',
  config: 'configuration',
  configuration: 'configuration',
  api: 'api',
  webhook: 'webhooks',
  webhooks: 'webhooks',
  integration: 'integrations',
  integrations: 'integrations',
  sync: 'integrations',
  queue: 'messaging',
  job: 'messaging',
  jobs: 'messaging',
  event: 'events',
  events: 'events',
  cache: 'infrastructure',
  database: 'infrastructure',
  storage: 'infrastructure',
  upload: 'media',
  media: 'media',
  image: 'media',
  file: 'media',
  security: 'security',
  permission: 'security',
  role: 'security',
  test: 'testing',
  tests: 'testing',
  spec: 'testing',
  migration: 'database',
  migrations: 'database',
  seed: 'database',
  seeders: 'database',
};

const NAME_DOMAIN_PATTERNS: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /\b(?:auth|login|logout|session|token|credential)/i, domain: 'authentication' },
  { pattern: /\b(?:payment|billing|invoice|charge|refund|subscription)/i, domain: 'payments' },
  { pattern: /\b(?:user|account|profile|registration|signup)/i, domain: 'users' },
  { pattern: /\b(?:notification|notify|alert|email|sms|push)/i, domain: 'notifications' },
  { pattern: /\b(?:order|cart|checkout|purchase)/i, domain: 'orders' },
  { pattern: /\b(?:product|catalog|item|sku|inventory)/i, domain: 'products' },
  { pattern: /\b(?:shipping|delivery|tracking|fulfillment)/i, domain: 'shipping' },
  { pattern: /\b(?:search|filter|query)/i, domain: 'search' },
  { pattern: /\b(?:report|analytics|metric|statistic|dashboard)/i, domain: 'reporting' },
  { pattern: /\b(?:admin|management|moderate)/i, domain: 'admin' },
  { pattern: /\b(?:webhook|callback|integration|sync)/i, domain: 'integrations' },
  { pattern: /\b(?:queue|job|worker|dispatch)/i, domain: 'messaging' },
  { pattern: /\b(?:cache|redis|memcache)/i, domain: 'infrastructure' },
  { pattern: /\b(?:upload|media|image|attachment)/i, domain: 'media' },
  { pattern: /\b(?:permission|role|acl|policy|gate)/i, domain: 'security' },
  { pattern: /\b(?:test|spec|mock|stub|fixture)/i, domain: 'testing' },
  { pattern: /\b(?:migration|schema|seed)/i, domain: 'database' },
  { pattern: /\b(?:config|setting|preference)/i, domain: 'configuration' },
  { pattern: /\b(?:logging|audit|trace|monitor)/i, domain: 'observability' },
];

// ════════════════════════════════════════════════════════════════════════
// CLASSIFIERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Classify a symbol by its file path — looks at directory segments.
 */
export function classifyByPath(filePath: string): DomainSuggestion[] {
  const segments = filePath.toLowerCase().split('/').filter(Boolean);
  const suggestions: DomainSuggestion[] = [];

  for (const seg of segments) {
    const domain = DIRECTORY_DOMAIN_MAP[seg];
    if (domain) {
      suggestions.push({
        domainPath: [domain],
        confidence: 0.7,
        reason: `Directory segment '${seg}' maps to domain '${domain}'`,
      });
    }
  }

  return suggestions;
}

/**
 * Classify a symbol by its name using regex patterns.
 */
export function classifyByName(name: string, kind: string): DomainSuggestion[] {
  const suggestions: DomainSuggestion[] = [];

  for (const { pattern, domain } of NAME_DOMAIN_PATTERNS) {
    if (pattern.test(name)) {
      suggestions.push({
        domainPath: [domain],
        confidence: 0.5,
        reason: `Symbol name '${name}' matches pattern for '${domain}'`,
      });
    }
  }

  return suggestions;
}

/**
 * Classify a batch of symbols using heuristics.
 * Returns Map<symbolId, best DomainSuggestion>.
 */
export function classifyBatch(
  symbols: ClassifiableSymbol[],
  customHints?: Record<string, string[]>,
): Map<number, DomainSuggestion> {
  const result = new Map<number, DomainSuggestion>();

  for (const sym of symbols) {
    const pathSuggestions = classifyByPath(sym.filePath);
    const nameSuggestions = classifyByName(sym.name, sym.kind);

    // Check custom hints
    const customSuggestions: DomainSuggestion[] = [];
    if (customHints) {
      for (const [domain, patterns] of Object.entries(customHints)) {
        for (const pattern of patterns) {
          if (matchGlob(sym.filePath, pattern)) {
            customSuggestions.push({
              domainPath: [domain],
              confidence: 0.9,
              reason: `Custom hint: '${pattern}' → '${domain}'`,
            });
          }
        }
      }
    }

    // Pick best suggestion (highest confidence)
    const all = [...customSuggestions, ...pathSuggestions, ...nameSuggestions];
    if (all.length > 0) {
      all.sort((a, b) => b.confidence - a.confidence);
      result.set(sym.id, all[0]);
    }
  }

  return result;
}

/**
 * Infer a domain taxonomy from a set of symbols using heuristics only.
 * Returns unique domain names discovered.
 */
export function inferTaxonomyHeuristic(
  symbols: ClassifiableSymbol[],
  customHints?: Record<string, string[]>,
): Array<{ name: string; description: string }> {
  const domainCounts = new Map<string, number>();

  for (const sym of symbols) {
    const classifications = classifyBatch([sym], customHints);
    const suggestion = classifications.get(sym.id);
    if (suggestion) {
      const domain = suggestion.domainPath[0];
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }
  }

  return [...domainCounts.entries()]
    .filter(([, count]) => count >= 2) // only domains with 2+ symbols
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => ({
      name,
      description: `Business domain: ${name}`,
    }));
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function matchGlob(filePath: string, pattern: string): boolean {
  // Escape regex metacharacters, then convert glob wildcards
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\\\*\\\*/g, '.*')              // ** → .*
    .replace(/\\\*/g, '[^/]*');              // * → [^/]*
  const regex = new RegExp('^' + escaped + '$');
  return regex.test(filePath);
}
