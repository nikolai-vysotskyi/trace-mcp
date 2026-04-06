/**
 * Laravel Pennant feature flag extraction.
 *
 * Extracts:
 * - Feature::define('name', ...) → definition sites
 * - Feature::active('name') / Feature::when('name', ...) → usage sites
 * - @feature('name') Blade directive → blade usage
 * - Route middleware features:new-dashboard → route gate
 * - #[FeatureGate('name')] PHP 8 attribute → method gate
 */
import type { RawEdge } from '../../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

interface PennantFeatureDefinition {
  name: string;
  /** File + line where Feature::define() is called */
  location: string;
  line: number;
}

interface PennantFeatureUsage {
  name: string;
  usageType: 'active' | 'when' | 'value' | 'for' | 'blade' | 'middleware' | 'attribute';
  line: number;
}

// ─── Definition extraction ────────────────────────────────────

/**
 * Extract Feature::define() calls from a PHP source file.
 */
export function extractFeatureDefinitions(
  source: string,
  filePath: string,
): PennantFeatureDefinition[] {
  const definitions: PennantFeatureDefinition[] = [];

  // Feature::define('feature-name', function/class)
  const re = /Feature::define\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const line = lineAt(source, match.index);
    definitions.push({ name: match[1], location: filePath, line });
  }

  return definitions;
}

// ─── Usage extraction ─────────────────────────────────────────

/**
 * Extract Feature::active/when/value/for() usages from a PHP source file.
 * Also detects #[FeatureGate('name')] attributes.
 */
export function extractFeatureUsages(source: string): PennantFeatureUsage[] {
  const usages: PennantFeatureUsage[] = [];

  // Feature::active('name'), Feature::inactive('name')
  const activeRe = /Feature::(?:active|inactive)\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = activeRe.exec(source)) !== null) {
    usages.push({ name: match[1], usageType: 'active', line: lineAt(source, match.index) });
  }

  // Feature::when('name', ...)
  const whenRe = /Feature::when\(\s*['"]([^'"]+)['"]/g;
  while ((match = whenRe.exec(source)) !== null) {
    usages.push({ name: match[1], usageType: 'when', line: lineAt(source, match.index) });
  }

  // Feature::value('name')
  const valueRe = /Feature::value\(\s*['"]([^'"]+)['"]/g;
  while ((match = valueRe.exec(source)) !== null) {
    usages.push({ name: match[1], usageType: 'value', line: lineAt(source, match.index) });
  }

  // Feature::for($user)->active('name')
  const forRe = /Feature::for\(.*?\)->(?:active|inactive|when|value)\(\s*['"]([^'"]+)['"]/g;
  while ((match = forRe.exec(source)) !== null) {
    usages.push({ name: match[1], usageType: 'for', line: lineAt(source, match.index) });
  }

  // #[FeatureGate('name')]
  const attrRe = /#\[FeatureGate\(\s*['"]([^'"]+)['"]/g;
  while ((match = attrRe.exec(source)) !== null) {
    usages.push({ name: match[1], usageType: 'attribute', line: lineAt(source, match.index) });
  }

  return usages;
}

/**
 * Extract @feature('name') ... @endfeature from a Blade template.
 */
export function extractFeatureBladeUsages(source: string): PennantFeatureUsage[] {
  const usages: PennantFeatureUsage[] = [];

  const re = /@feature\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    usages.push({ name: match[1], usageType: 'blade', line: lineAt(source, match.index) });
  }

  return usages;
}

/**
 * Extract feature flag names from route middleware: features:name1,name2
 */
export function extractFeatureMiddlewareUsages(source: string): PennantFeatureUsage[] {
  const usages: PennantFeatureUsage[] = [];

  // ->middleware('features:flag-name') or ->middleware(['features:flag1', 'features:flag2'])
  const re = /['"]features:([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    // May be comma-separated: 'features:flag1,flag2'
    const flags = match[1].split(',');
    for (const flag of flags) {
      usages.push({ name: flag.trim(), usageType: 'middleware', line: lineAt(source, match.index) });
    }
  }

  return usages;
}

// ─── Edge builders ────────────────────────────────────────────

export function buildPennantEdges(
  definitions: PennantFeatureDefinition[],
  usages: PennantFeatureUsage[],
  filePath: string,
): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const def of definitions) {
    edges.push({
      edgeType: 'feature_defined_in',
      metadata: { featureName: def.name, filePath: def.location, line: def.line },
    });
  }

  for (const usage of usages) {
    edges.push({
      edgeType: 'feature_checked_by',
      metadata: {
        featureName: usage.name,
        filePath,
        line: usage.line,
        usageType: usage.usageType,
      },
    });
  }

  return edges;
}

// ─── Helper ───────────────────────────────────────────────────

function lineAt(source: string, offset: number): number {
  return source.substring(0, offset).split('\n').length;
}
