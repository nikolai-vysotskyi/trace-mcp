/**
 * SBOM Generation — Software Bill of Materials.
 *
 * Parses package manifests and lockfiles from the project root to produce
 * CycloneDX-compatible, SPDX-compatible, or plain JSON output.
 *
 * Supports: npm, Composer, pip, Go, Cargo, Maven, Bundler.
 * Reads files in one pass — no N+1.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { validationError } from '../../errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SbomFormat = 'cyclonedx' | 'spdx' | 'json';

interface SbomComponent {
  name: string;
  version: string;
  ecosystem: string;
  license?: string;
  direct: boolean;
  resolved?: string; // resolved URL or hash
}

interface LicenseWarning {
  component: string;
  version: string;
  license: string;
  reason: string;
}

interface SbomResult {
  format: SbomFormat;
  components: SbomComponent[];
  direct_count: number;
  transitive_count: number;
  license_summary: Record<string, number>;
  license_warnings: LicenseWarning[];
}

// ---------------------------------------------------------------------------
// Copyleft / problematic licenses
// ---------------------------------------------------------------------------

const COPYLEFT_LICENSES = new Set([
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'SSPL-1.0',
  'EUPL-1.2',
]);

function checkLicenseWarning(
  name: string,
  version: string,
  license: string | undefined,
): LicenseWarning | null {
  if (!license) {
    return { component: name, version, license: 'UNKNOWN', reason: 'No license specified' };
  }
  // Check each part if it's an OR expression
  const parts = license.split(/\s+OR\s+/i);
  for (const part of parts) {
    const trimmed = part.trim().replace(/^\(|\)$/g, '');
    if (COPYLEFT_LICENSES.has(trimmed)) {
      return {
        component: name,
        version,
        license: trimmed,
        reason: 'Copyleft license — may require source disclosure',
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsers — one per ecosystem, each returns SbomComponent[]
// ---------------------------------------------------------------------------

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function readLines(filePath: string): string[] {
  try {
    return readFileSync(filePath, 'utf-8').split('\n');
  } catch {
    return [];
  }
}

/** npm: package.json + package-lock.json */
function parseNpm(root: string, includeDev: boolean, includeTransitive: boolean): SbomComponent[] {
  const pkgPath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const pkg = readJson(pkgPath) as Record<string, unknown> | null;
  if (!pkg) return [];

  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = includeDev ? ((pkg.devDependencies ?? {}) as Record<string, string>) : {};
  const directNames = new Set([...Object.keys(deps), ...Object.keys(devDeps)]);

  const components: SbomComponent[] = [];

  // Try lockfile first for exact versions
  const lock = readJson(lockPath) as Record<string, unknown> | null;
  if (lock && includeTransitive) {
    // npm lockfile v2/v3 has "packages" key
    const packages = (lock.packages ?? lock.dependencies ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [key, info] of Object.entries(packages)) {
      if (!key || key === '') continue; // root package
      const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : key;
      if (!name) continue;
      const version = String(info.version ?? '');
      const license = info.license != null ? String(info.license) : undefined;
      const isDev = info.dev === true;
      if (isDev && !includeDev) continue;
      components.push({
        name,
        version,
        ecosystem: 'npm',
        license,
        direct: directNames.has(name),
        resolved: typeof info.resolved === 'string' ? info.resolved : undefined,
      });
    }
  } else {
    // No lockfile — use manifest versions
    for (const [name, ver] of Object.entries({ ...deps, ...devDeps })) {
      components.push({
        name,
        version: ver.replace(/^[\^~>=<]/, ''),
        ecosystem: 'npm',
        direct: true,
      });
    }
  }

  return components;
}

/** Composer: composer.json + composer.lock */
function parseComposer(
  root: string,
  includeDev: boolean,
  includeTransitive: boolean,
): SbomComponent[] {
  const lockPath = path.join(root, 'composer.lock');
  const manifestPath = path.join(root, 'composer.json');
  const manifest = readJson(manifestPath) as Record<string, unknown> | null;

  const directNames = new Set<string>();
  if (manifest) {
    const req = (manifest.require ?? {}) as Record<string, string>;
    const reqDev = includeDev ? ((manifest['require-dev'] ?? {}) as Record<string, string>) : {};
    for (const name of [...Object.keys(req), ...Object.keys(reqDev)]) {
      if (!name.startsWith('php') && !name.startsWith('ext-')) {
        directNames.add(name);
      }
    }
  }

  const lock = readJson(lockPath) as Record<string, unknown> | null;
  if (!lock) {
    // Fallback to manifest
    return [...directNames].map((name) => ({
      name,
      version: '',
      ecosystem: 'composer',
      direct: true,
    }));
  }

  const components: SbomComponent[] = [];
  const packages = [
    ...((lock.packages ?? []) as Record<string, unknown>[]),
    ...(includeDev ? ((lock['packages-dev'] ?? []) as Record<string, unknown>[]) : []),
  ];

  for (const pkg of packages) {
    const name = String(pkg.name ?? '');
    if (!name) continue;
    if (!includeTransitive && !directNames.has(name)) continue;
    const license = Array.isArray(pkg.license) ? (pkg.license as string[]).join(' OR ') : undefined;
    components.push({
      name,
      version: String(pkg.version ?? ''),
      ecosystem: 'composer',
      license,
      direct: directNames.has(name),
    });
  }

  return components;
}

/** pip: requirements.txt / pyproject.toml + poetry.lock */
function parsePip(root: string, includeDev: boolean, includeTransitive: boolean): SbomComponent[] {
  const components: SbomComponent[] = [];

  // requirements.txt
  const reqPath = path.join(root, 'requirements.txt');
  if (existsSync(reqPath)) {
    for (const line of readLines(reqPath)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:[=~!><]=?\s*(.+))?/);
      if (match) {
        components.push({
          name: match[1],
          version: match[2]?.replace(/^=/, '') ?? '',
          ecosystem: 'pip',
          direct: true,
        });
      }
    }
  }

  // poetry.lock
  const poetryLock = path.join(root, 'poetry.lock');
  if (existsSync(poetryLock) && includeTransitive) {
    const content = readFileSync(poetryLock, 'utf-8');
    const directNames = new Set(components.map((c) => c.name.toLowerCase()));
    // Simple TOML-like parsing for poetry.lock
    let currentName = '';
    let currentVersion = '';
    for (const line of content.split('\n')) {
      const nameMatch = line.match(/^name\s*=\s*"([^"]+)"/);
      const versionMatch = line.match(/^version\s*=\s*"([^"]+)"/);
      if (nameMatch) currentName = nameMatch[1];
      if (versionMatch) currentVersion = versionMatch[1];
      if (line.startsWith('[[package]]') && currentName) {
        // Push previous
        if (currentName && !directNames.has(currentName.toLowerCase())) {
          components.push({
            name: currentName,
            version: currentVersion,
            ecosystem: 'pip',
            direct: false,
          });
        }
        currentName = '';
        currentVersion = '';
      }
    }
    // Push last
    if (
      currentName &&
      !new Set(components.map((c) => c.name.toLowerCase())).has(currentName.toLowerCase())
    ) {
      components.push({
        name: currentName,
        version: currentVersion,
        ecosystem: 'pip',
        direct: false,
      });
    }
  }

  return components;
}

/** Go: go.mod + go.sum */
function parseGo(root: string, _includeDev: boolean, includeTransitive: boolean): SbomComponent[] {
  const modPath = path.join(root, 'go.mod');
  if (!existsSync(modPath)) return [];

  const components: SbomComponent[] = [];
  const directNames = new Set<string>();
  let inRequire = false;

  for (const line of readLines(modPath)) {
    const trimmed = line.trim();
    if (trimmed === 'require (') {
      inRequire = true;
      continue;
    }
    if (trimmed === ')') {
      inRequire = false;
      continue;
    }

    if (inRequire || trimmed.startsWith('require ')) {
      const match = trimmed.match(/^\s*(?:require\s+)?(\S+)\s+(v\S+)/);
      if (match) {
        const indirect = trimmed.includes('// indirect');
        if (!indirect) directNames.add(match[1]);
        if (!includeTransitive && indirect) continue;
        components.push({
          name: match[1],
          version: match[2],
          ecosystem: 'go',
          direct: !indirect,
        });
      }
    }
  }

  return components;
}

/** Cargo: Cargo.toml + Cargo.lock */
function parseCargo(
  root: string,
  _includeDev: boolean,
  includeTransitive: boolean,
): SbomComponent[] {
  const lockPath = path.join(root, 'Cargo.lock');
  if (!existsSync(lockPath)) {
    // Fallback to Cargo.toml
    const tomlPath = path.join(root, 'Cargo.toml');
    if (!existsSync(tomlPath)) return [];
    const components: SbomComponent[] = [];
    let inDeps = false;
    for (const line of readLines(tomlPath)) {
      if (line.match(/^\[(?:dev-)?dependencies\]/)) {
        inDeps = true;
        continue;
      }
      if (line.startsWith('[')) {
        inDeps = false;
        continue;
      }
      if (inDeps) {
        const match = line.match(/^(\S+)\s*=\s*(?:"([^"]+)"|{.*version\s*=\s*"([^"]+)")/);
        if (match) {
          components.push({
            name: match[1],
            version: match[2] ?? match[3] ?? '',
            ecosystem: 'cargo',
            direct: true,
          });
        }
      }
    }
    return components;
  }

  const components: SbomComponent[] = [];
  let currentName = '';
  let currentVersion = '';
  let currentChecksum = '';
  for (const line of readLines(lockPath)) {
    if (line.startsWith('[[package]]')) {
      if (currentName) {
        components.push({
          name: currentName,
          version: currentVersion,
          ecosystem: 'cargo',
          direct: false, // Cargo.lock doesn't distinguish direct/transitive
          resolved: currentChecksum || undefined,
        });
      }
      currentName = '';
      currentVersion = '';
      currentChecksum = '';
      continue;
    }
    const nameMatch = line.match(/^name\s*=\s*"([^"]+)"/);
    const versionMatch = line.match(/^version\s*=\s*"([^"]+)"/);
    const checksumMatch = line.match(/^checksum\s*=\s*"([^"]+)"/);
    if (nameMatch) currentName = nameMatch[1];
    if (versionMatch) currentVersion = versionMatch[1];
    if (checksumMatch) currentChecksum = checksumMatch[1];
  }
  if (currentName) {
    components.push({
      name: currentName,
      version: currentVersion,
      ecosystem: 'cargo',
      direct: false,
      resolved: currentChecksum || undefined,
    });
  }

  if (!includeTransitive) {
    // Read Cargo.toml to identify direct deps
    const tomlPath = path.join(root, 'Cargo.toml');
    if (existsSync(tomlPath)) {
      const directNames = new Set<string>();
      let inDeps = false;
      for (const line of readLines(tomlPath)) {
        if (line.match(/^\[(?:dev-)?dependencies\]/)) {
          inDeps = true;
          continue;
        }
        if (line.startsWith('[')) {
          inDeps = false;
          continue;
        }
        if (inDeps) {
          const match = line.match(/^(\S+)\s*=/);
          if (match) directNames.add(match[1]);
        }
      }
      for (const c of components) c.direct = directNames.has(c.name);
      return components.filter((c) => c.direct);
    }
  }

  return components;
}

/** Bundler: Gemfile + Gemfile.lock */
function parseBundler(
  root: string,
  _includeDev: boolean,
  includeTransitive: boolean,
): SbomComponent[] {
  const lockPath = path.join(root, 'Gemfile.lock');
  if (!existsSync(lockPath)) return [];

  const components: SbomComponent[] = [];
  let inSpecs = false;

  for (const line of readLines(lockPath)) {
    if (line.trim() === 'specs:') {
      inSpecs = true;
      continue;
    }
    if (inSpecs && line.match(/^\S/)) {
      inSpecs = false;
    }

    if (inSpecs) {
      // Direct deps have 4 spaces, transitive have 6+
      const match = line.match(/^(\s{4})(\S+)\s+\(([^)]+)\)/);
      if (match) {
        components.push({
          name: match[2],
          version: match[3],
          ecosystem: 'bundler',
          direct: true,
        });
        continue;
      }
      if (includeTransitive) {
        const transMatch = line.match(/^\s{6,}(\S+)\s+\(([^)]+)\)/);
        if (transMatch) {
          components.push({
            name: transMatch[1],
            version: transMatch[2],
            ecosystem: 'bundler',
            direct: false,
          });
        }
      }
    }
  }

  return components;
}

/** Maven: pom.xml (basic parsing) */
function parseMaven(
  root: string,
  _includeDev: boolean,
  _includeTransitive: boolean,
): SbomComponent[] {
  const pomPath = path.join(root, 'pom.xml');
  if (!existsSync(pomPath)) return [];

  const content = readFileSync(pomPath, 'utf-8');
  const components: SbomComponent[] = [];

  // Match <dependency> blocks
  const depRegex =
    /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>\s*(?:<version>([^<]+)<\/version>)?/gs;
  let match: RegExpExecArray | null;
  while ((match = depRegex.exec(content)) !== null) {
    components.push({
      name: `${match[1]}:${match[2]}`,
      version: match[3] ?? '',
      ecosystem: 'maven',
      direct: true,
    });
  }

  return components;
}

// ---------------------------------------------------------------------------
// CycloneDX / SPDX formatters
// ---------------------------------------------------------------------------

function toCycloneDx(components: SbomComponent[]): object {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    components: components.map((c) => ({
      type: 'library',
      name: c.name,
      version: c.version,
      purl: `pkg:${c.ecosystem}/${encodeURIComponent(c.name)}@${c.version}`,
      ...(c.license ? { licenses: [{ license: { id: c.license } }] } : {}),
    })),
  };
}

function toSpdx(components: SbomComponent[]): object {
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    packages: components.map((c, i) => ({
      SPDXID: `SPDXRef-Package-${i}`,
      name: c.name,
      versionInfo: c.version,
      downloadLocation: c.resolved ?? 'NOASSERTION',
      ...(c.license
        ? { licenseConcluded: c.license, licenseDeclared: c.license }
        : { licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION' }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateSbom(
  projectRoot: string,
  opts: {
    format?: SbomFormat;
    includeDev?: boolean;
    includeTransitive?: boolean;
  },
): TraceMcpResult<SbomResult & { formatted?: object }> {
  const format = opts.format ?? 'json';
  const includeDev = opts.includeDev ?? false;
  const includeTransitive = opts.includeTransitive ?? true;

  // Collect from all ecosystems
  const allComponents: SbomComponent[] = [];

  const parsers = [
    parseNpm,
    parseComposer,
    parsePip,
    parseGo,
    parseCargo,
    parseBundler,
    parseMaven,
  ];

  for (const parser of parsers) {
    const components = parser(projectRoot, includeDev, includeTransitive);
    allComponents.push(...components);
  }

  if (allComponents.length === 0) {
    return err(
      validationError(
        'No package manifests found (package.json, composer.json, requirements.txt, go.mod, Cargo.toml, Gemfile.lock, pom.xml)',
      ),
    );
  }

  // Deduplicate by name+ecosystem
  const seen = new Set<string>();
  const deduped: SbomComponent[] = [];
  for (const c of allComponents) {
    const key = `${c.ecosystem}:${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  // Compute stats
  const directCount = deduped.filter((c) => c.direct).length;
  const transitiveCount = deduped.length - directCount;

  // License summary
  const licenseSummary: Record<string, number> = {};
  const warnings: LicenseWarning[] = [];
  for (const c of deduped) {
    const lic = c.license ?? 'UNKNOWN';
    licenseSummary[lic] = (licenseSummary[lic] ?? 0) + 1;
    const warning = checkLicenseWarning(c.name, c.version, c.license);
    if (warning) warnings.push(warning);
  }

  const result: SbomResult & { formatted?: object } = {
    format,
    components: deduped,
    direct_count: directCount,
    transitive_count: transitiveCount,
    license_summary: licenseSummary,
    license_warnings: warnings,
  };

  if (format === 'cyclonedx') {
    result.formatted = toCycloneDx(deduped);
  } else if (format === 'spdx') {
    result.formatted = toSpdx(deduped);
  }

  return ok(result);
}
