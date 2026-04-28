/**
 * laravel/socialite extraction.
 *
 * Extracts:
 * - Socialite provider usage in controllers/services
 * - Custom Socialite provider classes (extending AbstractProvider)
 * - OAuth callback route detection
 * - Provider configuration from services.php
 */
import type { RawEdge } from '../../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface SocialiteUsageInfo {
  providers: SocialiteProvider[];
  customProviders: CustomSocialiteProvider[];
}

interface SocialiteProvider {
  name: string;
  line: number;
  usageType: 'redirect' | 'callback' | 'stateless' | 'scopes' | 'other';
}

interface CustomSocialiteProvider {
  className: string;
  fqn: string;
  providerName: string | null;
}

// ─── Detection ───────────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const _CLASS_NAME_RE = /class\s+(\w+)/;

// Socialite::driver('github')->redirect() or Socialite::driver('github')->user()
const SOCIALITE_DRIVER_RE = /Socialite::driver\(\s*['"](\w+)['"]\s*\)\s*->\s*(\w+)/g;

// Custom provider: class MyProvider extends AbstractProvider
const CUSTOM_PROVIDER_RE =
  /class\s+(\w+)\s+extends\s+(?:[\w\\]*\\)?(?:AbstractProvider|AbstractUser)/;

// ─── Extraction ──────────────────────────────────────────────

/**
 * Extract Socialite usage from PHP source code.
 */
export function extractSocialiteUsage(
  source: string,
  _filePath: string,
): SocialiteUsageInfo | null {
  const providers: SocialiteProvider[] = [];
  const customProviders: CustomSocialiteProvider[] = [];

  // Detect Socialite::driver() calls
  const driverRe = new RegExp(SOCIALITE_DRIVER_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = driverRe.exec(source)) !== null) {
    const name = match[1];
    const method = match[2];
    const line = source.substring(0, match.index).split('\n').length;
    let usageType: SocialiteProvider['usageType'] = 'other';

    if (method === 'redirect') usageType = 'redirect';
    else if (method === 'user') usageType = 'callback';
    else if (method === 'stateless') usageType = 'stateless';
    else if (method === 'scopes') usageType = 'scopes';

    providers.push({ name, line, usageType });
  }

  // Detect custom providers
  const customMatch = source.match(CUSTOM_PROVIDER_RE);
  if (customMatch) {
    const nsMatch = source.match(NAMESPACE_RE);
    const namespace = nsMatch?.[1] ?? '';
    const className = customMatch[1];
    const fqn = namespace ? `${namespace}\\${className}` : className;

    // Try to extract provider name from PROVIDER_NAME or identifier constant
    const providerName = extractProviderName(source);

    customProviders.push({ className, fqn, providerName });
  }

  if (providers.length === 0 && customProviders.length === 0) return null;

  return { providers, customProviders };
}

// ─── Edge builders ───────────────────────────────────────────

export function buildSocialiteEdges(info: SocialiteUsageInfo, filePath: string): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const provider of info.providers) {
    edges.push({
      edgeType: 'socialite_uses_provider',
      metadata: {
        provider: provider.name,
        usageType: provider.usageType,
        filePath,
        line: provider.line,
      },
    });
  }

  for (const custom of info.customProviders) {
    edges.push({
      edgeType: 'socialite_custom_provider',
      metadata: {
        classFqn: custom.fqn,
        providerName: custom.providerName,
      },
    });
  }

  return edges;
}

// ─── Internal helpers ────────────────────────────────────────

function extractProviderName(source: string): string | null {
  // Check for static $name or IDENTIFIER constant
  const nameRe = /(?:protected\s+static\s+\$name|const\s+IDENTIFIER)\s*=\s*['"](\w+)['"]/;
  return source.match(nameRe)?.[1] ?? null;
}
