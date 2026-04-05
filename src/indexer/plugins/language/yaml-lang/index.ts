/**
 * YAML Language Plugin — dialect-aware symbol extraction.
 *
 * Detects YAML dialect from filename and top-level keys, then applies
 * specialised extraction rules for:
 *   - Docker Compose
 *   - GitHub Actions
 *   - GitLab CI
 *   - Kubernetes manifests
 *   - Ansible playbooks
 *   - OpenAPI / Swagger
 *   - CircleCI
 *   - Helm charts
 *   - CloudFormation
 *   - Generic YAML (top-level keys as constants)
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function symId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

// ── Dialect detection ──────────────────────────────────────────────────────

type YamlDialect =
  | 'docker-compose'
  | 'github-actions'
  | 'gitlab-ci'
  | 'kubernetes'
  | 'ansible-playbook'
  | 'openapi'
  | 'circleci'
  | 'helm-chart'
  | 'cloudformation'
  | 'generic';

/**
 * Detect dialect by scanning first ~50 lines for top-level keys, combined
 * with filename heuristics.
 */
function detectDialect(filePath: string, lines: string[]): YamlDialect {
  const fn = filePath.toLowerCase().replace(/\\/g, '/');
  const baseName = fn.split('/').pop() ?? '';

  // Filename-based detection (highest priority)
  if (baseName === 'docker-compose.yml' || baseName === 'docker-compose.yaml' ||
      baseName === 'compose.yml' || baseName === 'compose.yaml') {
    return 'docker-compose';
  }
  if (fn.includes('.github/workflows/')) return 'github-actions';
  if (baseName === '.gitlab-ci.yml' || baseName === '.gitlab-ci.yaml') return 'gitlab-ci';
  if (fn.includes('.circleci/') && (baseName === 'config.yml' || baseName === 'config.yaml')) return 'circleci';
  if (baseName === 'chart.yaml' || baseName === 'chart.yml') return 'helm-chart';

  // Collect top-level keys from first ~50 lines
  const topKeys = new Set<string>();
  const limit = Math.min(lines.length, 50);
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    // A top-level key is a non-comment, non-list-item line starting at column 0 with "key:"
    if (line.length === 0 || line[0] === '#' || line[0] === ' ' || line[0] === '\t' || line[0] === '-') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      topKeys.add(line.slice(0, colonIdx).trim().toLowerCase());
    }
  }

  // Content-based detection
  if (topKeys.has('services') && !topKeys.has('apiversion')) return 'docker-compose';
  if (topKeys.has('on') && topKeys.has('jobs')) return 'github-actions';
  if (topKeys.has('stages')) {
    // Check for job-like keys with script: in body
    for (let i = 0; i < limit; i++) {
      const line = lines[i];
      if (line.startsWith('  script:') || line.startsWith('    script:') || line === '  script:') {
        return 'gitlab-ci';
      }
    }
    // Still likely gitlab-ci if stages is present
    return 'gitlab-ci';
  }
  if (topKeys.has('apiversion') && topKeys.has('kind')) return 'kubernetes';
  if (topKeys.has('openapi') || topKeys.has('swagger')) return 'openapi';
  if (topKeys.has('awstemplateformatversion') || (topKeys.has('resources') && hasCloudFormationResources(lines, limit))) return 'cloudformation';

  // Ansible: top-level list with "hosts:" or "- name:"
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (line.startsWith('- hosts:') || line.startsWith('- name:')) return 'ansible-playbook';
  }

  return 'generic';
}

/** Check if Resources section contains AWS resource types */
function hasCloudFormationResources(lines: string[], limit: number): boolean {
  let inResources = false;
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (line === 'Resources:') { inResources = true; continue; }
    if (inResources && line.length > 0 && line[0] !== ' ' && line[0] !== '\t') break;
    if (inResources && line.includes('Type:') && line.includes('AWS::')) return true;
  }
  return false;
}

// ── Indent tracking helpers ────────────────────────────────────────────────

function getIndent(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') n++;
    else if (line[i] === '\t') n += 2;
    else break;
  }
  return n;
}

function lineOffset(lines: string[], lineIdx: number): number {
  let off = 0;
  for (let i = 0; i < lineIdx; i++) {
    off += lines[i].length + 1; // +1 for \n
  }
  return off;
}

// ── Dialect extractors ─────────────────────────────────────────────────────

function extractDockerCompose(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  let inServices = false;
  let serviceIndent = -1;
  let currentService = '';
  let currentServiceIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    // Detect services: block
    if (indent === 0 && trimmed.startsWith('services:')) {
      inServices = true;
      serviceIndent = -1;
      continue;
    }
    if (indent === 0 && !trimmed.startsWith('services:')) {
      inServices = false;
      continue;
    }

    if (!inServices) continue;

    // First indented line under services: determines service indent level
    if (serviceIndent === -1 && indent > 0) {
      serviceIndent = indent;
    }

    // Service name
    if (indent === serviceIndent && trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const svcName = trimmed.slice(0, colonIdx).trim();
      if (svcName && !svcName.startsWith('-') && !svcName.startsWith('#')) {
        currentService = svcName;
        currentServiceIndent = indent;
        add(svcName, 'class', lineOffset(lines, i), { yamlKind: 'service' });
      }
      continue;
    }

    if (currentService && indent > currentServiceIndent) {
      // image:
      if (trimmed.startsWith('image:')) {
        const val = trimmed.slice(6).trim();
        if (val) add(`${currentService}:image`, 'constant', lineOffset(lines, i), { yamlKind: 'image', value: val });
      }
      // ports:
      if (trimmed.startsWith('- ') && lookBackForKey(lines, i, 'ports')) {
        const portVal = trimmed.slice(2).trim().replace(/['"]/g, '');
        if (portVal) add(`${currentService}:${portVal}`, 'constant', lineOffset(lines, i), { yamlKind: 'port', value: portVal });
      }
      // depends_on entries
      if (trimmed.startsWith('- ') && lookBackForKey(lines, i, 'depends_on')) {
        const dep = trimmed.slice(2).trim().replace(/['"]/g, '');
        if (dep) {
          edges.push({
            sourceSymbolId: symId(filePath, currentService, 'class'),
            targetSymbolId: symId(filePath, dep, 'class'),
            edgeType: 'depends_on',
            metadata: { dialect: 'docker-compose' },
          });
        }
      }
      // volumes: entries (named or bind mount)
      if (trimmed.startsWith('- ') && lookBackForKey(lines, i, 'volumes')) {
        const vol = trimmed.slice(2).trim().replace(/['"]/g, '');
        if (vol) {
          const hostPath = vol.split(':')[0];
          add(`${currentService}:vol:${hostPath}`, 'constant', lineOffset(lines, i), { yamlKind: 'volume', value: vol, service: currentService });
        }
      }
      // networks: entries
      if (trimmed.startsWith('- ') && lookBackForKey(lines, i, 'networks')) {
        const net = trimmed.slice(2).trim().replace(/['"]/g, '');
        if (net) {
          add(`${currentService}:net:${net}`, 'constant', lineOffset(lines, i), { yamlKind: 'network', value: net, service: currentService });
        }
      }
      // environment: key=value entries
      if (trimmed.startsWith('- ') && lookBackForKey(lines, i, 'environment')) {
        const envEntry = trimmed.slice(2).trim().replace(/['"]/g, '');
        const eqIdx = envEntry.indexOf('=');
        if (eqIdx > 0) {
          const envKey = envEntry.slice(0, eqIdx);
          add(`${currentService}:env:${envKey}`, 'variable', lineOffset(lines, i), { yamlKind: 'envVar', key: envKey, service: currentService });
        }
      }
    }
  }

  // Top-level volumes and networks (outside services)
  let inTopVolumes = false;
  let inTopNetworks = false;
  let topBlockIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    if (indent === 0 && trimmed.startsWith('volumes:')) {
      inTopVolumes = true;
      inTopNetworks = false;
      topBlockIndent = -1;
      continue;
    }
    if (indent === 0 && trimmed.startsWith('networks:')) {
      inTopNetworks = true;
      inTopVolumes = false;
      topBlockIndent = -1;
      continue;
    }
    if (indent === 0) {
      inTopVolumes = false;
      inTopNetworks = false;
      continue;
    }

    if (topBlockIndent === -1 && indent > 0) topBlockIndent = indent;

    if (indent === topBlockIndent && trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const name = trimmed.slice(0, colonIdx).trim();
      if (name && !name.startsWith('#')) {
        if (inTopVolumes) {
          add(name, 'variable', lineOffset(lines, i), { yamlKind: 'volumeDef' });
        }
        if (inTopNetworks) {
          add(name, 'variable', lineOffset(lines, i), { yamlKind: 'networkDef' });
        }
      }
    }
  }
}

function lookBackForKey(lines: string[], idx: number, key: string): boolean {
  for (let i = idx - 1; i >= 0 && i >= idx - 5; i--) {
    const t = lines[i].trimStart();
    if (t.startsWith(key + ':')) return true;
    if (t.length > 0 && !t.startsWith('-') && !t.startsWith('#')) return false;
  }
  return false;
}

function extractGitHubActions(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  let inJobs = false;
  let jobIndent = -1;
  let currentJob = '';
  let inSteps = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    if (indent === 0 && trimmed.startsWith('jobs:')) {
      inJobs = true;
      jobIndent = -1;
      continue;
    }
    if (indent === 0 && !trimmed.startsWith('jobs:')) {
      inJobs = false;
      continue;
    }

    if (!inJobs) continue;

    if (jobIndent === -1 && indent > 0) jobIndent = indent;

    // Job name at job indent level
    if (indent === jobIndent && trimmed.includes(':') && !trimmed.startsWith('-')) {
      const colonIdx = trimmed.indexOf(':');
      const jobName = trimmed.slice(0, colonIdx).trim();
      if (jobName) {
        currentJob = jobName;
        inSteps = false;
        add(jobName, 'function', lineOffset(lines, i), { yamlKind: 'job' });
      }
      continue;
    }

    // Steps detection
    if (trimmed === 'steps:') {
      inSteps = true;
      continue;
    }

    if (inSteps && indent > jobIndent) {
      // Step name
      if (trimmed.startsWith('- name:')) {
        const stepName = trimmed.slice(7).trim().replace(/^['"]|['"]$/g, '');
        if (stepName) {
          add(stepName, 'constant', lineOffset(lines, i), { yamlKind: 'step', job: currentJob });
        }
      }
      // uses:
      if (trimmed.startsWith('uses:') || trimmed.startsWith('- uses:')) {
        const usesVal = trimmed.replace(/^-?\s*uses:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
        if (usesVal) {
          edges.push({ edgeType: 'imports', metadata: { module: usesVal, dialect: 'github-actions' } });
        }
      }
    }
  }
}

function extractGitLabCI(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  // Extract stages
  let inStages = false;
  const reservedKeys = new Set(['stages', 'variables', 'default', 'include', 'image', 'services', 'before_script', 'after_script', 'cache', 'workflow']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    if (indent === 0 && trimmed === 'stages:') {
      inStages = true;
      continue;
    }

    if (inStages && indent > 0 && trimmed.startsWith('- ')) {
      const stageName = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, '');
      if (stageName) add(stageName, 'constant', lineOffset(lines, i), { yamlKind: 'stage' });
      continue;
    }

    if (indent === 0) {
      inStages = false;
      // Top-level key that's not reserved = job name
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        if (key && !key.startsWith('.') && !reservedKeys.has(key)) {
          add(key, 'function', lineOffset(lines, i), { yamlKind: 'job' });
        }
      }
    }
  }
}

function extractKubernetes(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  let kind = '';
  let metadataName = '';
  let inMetadata = false;
  let inContainers = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    if (indent === 0 && trimmed.startsWith('kind:')) {
      kind = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '');
      if (kind) add(kind, 'type', lineOffset(lines, i), { yamlKind: 'k8sKind' });
    }

    if (indent === 0 && trimmed === 'metadata:') {
      inMetadata = true;
      inContainers = false;
      continue;
    }

    if (inMetadata && indent > 0 && trimmed.startsWith('name:')) {
      metadataName = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '');
      if (metadataName) add(metadataName, 'constant', lineOffset(lines, i), { yamlKind: 'k8sName', kind });
      inMetadata = false;
    }

    if (indent === 0) {
      inMetadata = false;
      inContainers = false;
    }

    // Container names and images
    if (trimmed === 'containers:' || trimmed === '- containers:') {
      inContainers = true;
      continue;
    }

    if (inContainers) {
      if (trimmed.startsWith('- name:')) {
        const cName = trimmed.slice(7).trim().replace(/^['"]|['"]$/g, '');
        if (cName) add(cName, 'constant', lineOffset(lines, i), { yamlKind: 'container' });
      }
      if (trimmed.startsWith('image:')) {
        const img = trimmed.slice(6).trim().replace(/^['"]|['"]$/g, '');
        if (img) add(img, 'constant', lineOffset(lines, i), { yamlKind: 'containerImage' });
      }
    }

    // Volume mounts
    if (trimmed.startsWith('- mountPath:')) {
      const mp = trimmed.slice(12).trim().replace(/^['"]|['"]$/g, '');
      if (mp) add(`mount:${mp}`, 'variable', lineOffset(lines, i), { yamlKind: 'volumeMount', kind, resource: metadataName });
    }

    // configMapRef / secretRef (may be prefixed with "- ")
    if (trimmed.startsWith('configMapRef:') || trimmed.startsWith('- configMapRef:') || trimmed.startsWith('configMapKeyRef:') || trimmed.startsWith('- configMapKeyRef:')) {
      // Look ahead for name:
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const next = lines[j].trimStart();
        if (next.startsWith('name:')) {
          const ref = next.slice(5).trim().replace(/^['"]|['"]$/g, '');
          if (ref) {
            add(`configMap:${ref}`, 'constant', lineOffset(lines, i), { yamlKind: 'configMapRef', resource: metadataName });
            edges.push({
              sourceSymbolId: symId(filePath, metadataName || kind, 'constant'),
              targetSymbolId: symId(filePath, `configMap:${ref}`, 'constant'),
              edgeType: 'depends_on',
              metadata: { dialect: 'kubernetes', refKind: 'configMap' },
            });
          }
          break;
        }
      }
    }
    if (trimmed.startsWith('secretRef:') || trimmed.startsWith('- secretRef:') || trimmed.startsWith('secretKeyRef:') || trimmed.startsWith('- secretKeyRef:')) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const next = lines[j].trimStart();
        if (next.startsWith('name:')) {
          const ref = next.slice(5).trim().replace(/^['"]|['"]$/g, '');
          if (ref) {
            add(`secret:${ref}`, 'constant', lineOffset(lines, i), { yamlKind: 'secretRef', resource: metadataName });
            edges.push({
              sourceSymbolId: symId(filePath, metadataName || kind, 'constant'),
              targetSymbolId: symId(filePath, `secret:${ref}`, 'constant'),
              edgeType: 'depends_on',
              metadata: { dialect: 'kubernetes', refKind: 'secret' },
            });
          }
          break;
        }
      }
    }

    // Service selector → creates edge to matching deployment
    if (kind === 'Service' && trimmed.startsWith('app:') && lookBackForKey(lines, i, 'selector')) {
      const selectorApp = trimmed.slice(4).trim().replace(/^['"]|['"]$/g, '');
      if (selectorApp && metadataName) {
        add(`selector:${selectorApp}`, 'constant', lineOffset(lines, i), { yamlKind: 'serviceSelector', service: metadataName, app: selectorApp });
      }
    }
  }
}

function extractAnsible(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;

    // Play name (top-level - name:)
    if (trimmed.startsWith('- name:') && getIndent(line) === 0) {
      const name = trimmed.slice(7).trim().replace(/^['"]|['"]$/g, '');
      if (name) add(name, 'constant', lineOffset(lines, i), { yamlKind: 'play' });
    }

    // Task name (indented - name:)
    if (trimmed.startsWith('- name:') && getIndent(line) > 0) {
      const name = trimmed.slice(7).trim().replace(/^['"]|['"]$/g, '');
      if (name) add(name, 'function', lineOffset(lines, i), { yamlKind: 'task' });
    }

    // Role references
    if (trimmed.startsWith('- role:')) {
      const role = trimmed.slice(7).trim().replace(/^['"]|['"]$/g, '');
      if (role) edges.push({ edgeType: 'imports', metadata: { module: role, dialect: 'ansible-playbook' } });
    }
    // roles: list entries
    if (trimmed.startsWith('- ') && lookBackForKey(lines, i, 'roles')) {
      const val = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, '');
      // Could be a map (- role: name) or simple string
      if (val && !val.includes(':')) {
        edges.push({ edgeType: 'imports', metadata: { module: val, dialect: 'ansible-playbook' } });
      }
    }
  }
}

function extractOpenAPI(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  let inPaths = false;
  let pathsIndent = -1;
  let currentPath = '';
  let currentPathIndent = -1;
  let inSchemas = false;
  let schemasIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    // paths:
    if (indent === 0 && trimmed.startsWith('paths:')) {
      inPaths = true;
      inSchemas = false;
      pathsIndent = -1;
      continue;
    }

    // components: or definitions:
    if (indent === 0) {
      if (trimmed.startsWith('components:') || trimmed.startsWith('definitions:')) {
        inPaths = false;
        inSchemas = false;
        // schemas will be nested under components
      } else if (!trimmed.startsWith(' ')) {
        inPaths = false;
        inSchemas = false;
      }
    }

    // schemas: (under components or top-level definitions)
    if (trimmed === 'schemas:') {
      inSchemas = true;
      schemasIndent = -1;
      inPaths = false;
      continue;
    }

    // Extract paths
    if (inPaths) {
      if (pathsIndent === -1 && indent > 0) pathsIndent = indent;

      // Path entry (e.g., /users:)
      if (indent === pathsIndent && trimmed.includes(':')) {
        const colonIdx = trimmed.indexOf(':');
        currentPath = trimmed.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
        currentPathIndent = indent;
        continue;
      }

      // HTTP method under path
      if (currentPath && indent > currentPathIndent) {
        const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          const method = trimmed.slice(0, colonIdx).trim().toLowerCase();
          if (methods.includes(method)) {
            const label = `${method.toUpperCase()} ${currentPath}`;
            add(label, 'function', lineOffset(lines, i), { yamlKind: 'endpoint', method: method.toUpperCase(), path: currentPath });
          }
        }
      }
    }

    // Extract schemas
    if (inSchemas) {
      if (schemasIndent === -1 && indent > 0) schemasIndent = indent;
      if (indent === schemasIndent && trimmed.includes(':')) {
        const colonIdx = trimmed.indexOf(':');
        const schemaName = trimmed.slice(0, colonIdx).trim();
        if (schemaName) add(schemaName, 'type', lineOffset(lines, i), { yamlKind: 'schema' });
      }
    }
  }
}

function extractCircleCI(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  let inJobs = false;
  let jobIndent = -1;
  let inOrbs = false;
  let orbIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    if (indent === 0 && trimmed.startsWith('jobs:')) {
      inJobs = true;
      inOrbs = false;
      jobIndent = -1;
      continue;
    }
    if (indent === 0 && trimmed.startsWith('orbs:')) {
      inOrbs = true;
      inJobs = false;
      orbIndent = -1;
      continue;
    }
    if (indent === 0 && trimmed.includes(':')) {
      inJobs = false;
      inOrbs = false;
      continue;
    }

    if (inJobs) {
      if (jobIndent === -1 && indent > 0) jobIndent = indent;
      if (indent === jobIndent && trimmed.includes(':')) {
        const colonIdx = trimmed.indexOf(':');
        const jobName = trimmed.slice(0, colonIdx).trim();
        if (jobName) add(jobName, 'function', lineOffset(lines, i), { yamlKind: 'job' });
      }
    }

    if (inOrbs) {
      if (orbIndent === -1 && indent > 0) orbIndent = indent;
      if (indent === orbIndent && trimmed.includes(':')) {
        const colonIdx = trimmed.indexOf(':');
        const orbAlias = trimmed.slice(0, colonIdx).trim();
        const orbRef = trimmed.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (orbRef) {
          edges.push({ edgeType: 'imports', metadata: { module: orbRef, alias: orbAlias, dialect: 'circleci' } });
        }
      }
    }
  }
}

function extractHelmChart(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  let inDependencies = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    if (indent === 0 && trimmed.startsWith('name:')) {
      const val = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '');
      if (val) add(val, 'constant', lineOffset(lines, i), { yamlKind: 'chartName' });
    }
    if (indent === 0 && trimmed.startsWith('version:')) {
      const val = trimmed.slice(8).trim().replace(/^['"]|['"]$/g, '');
      if (val) add(val, 'constant', lineOffset(lines, i), { yamlKind: 'chartVersion' });
    }
    if (indent === 0 && trimmed.startsWith('dependencies:')) {
      inDependencies = true;
      continue;
    }
    if (indent === 0 && !trimmed.startsWith('dependencies:')) {
      inDependencies = false;
    }

    if (inDependencies && trimmed.startsWith('- name:')) {
      const depName = trimmed.slice(7).trim().replace(/^['"]|['"]$/g, '');
      if (depName) {
        add(depName, 'constant', lineOffset(lines, i), { yamlKind: 'helmDep' });
        edges.push({ edgeType: 'imports', metadata: { module: depName, dialect: 'helm-chart' } });
      }
    }
  }
}

function extractCloudFormation(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  let inResources = false;
  let resourceIndent = -1;
  let currentResource = '';
  let currentResourceIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;
    const indent = getIndent(line);

    if (indent === 0 && trimmed.startsWith('Resources:')) {
      inResources = true;
      resourceIndent = -1;
      continue;
    }
    if (indent === 0 && !trimmed.startsWith('Resources:') && trimmed.includes(':')) {
      inResources = false;
      continue;
    }

    if (!inResources) continue;

    if (resourceIndent === -1 && indent > 0) resourceIndent = indent;

    // Logical resource ID
    if (indent === resourceIndent && trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const resName = trimmed.slice(0, colonIdx).trim();
      if (resName) {
        currentResource = resName;
        currentResourceIndent = indent;
        add(resName, 'class', lineOffset(lines, i), { yamlKind: 'cfnResource' });
      }
      continue;
    }

    // Type: under resource
    if (currentResource && indent > currentResourceIndent && trimmed.startsWith('Type:')) {
      const resType = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '');
      if (resType) add(`${currentResource}:${resType}`, 'type', lineOffset(lines, i), { yamlKind: 'cfnResourceType', resource: currentResource, type: resType });
    }
  }
}

function extractGenericYaml(filePath: string, lines: string[], symbols: RawSymbol[], edges: RawEdge[], seen: Set<string>, add: AddFn): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 || line[0] === '#' || line[0] === ' ' || line[0] === '\t' || line[0] === '-') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      // Validate: must start with a letter/underscore, no spaces => standard YAML key
      if (key && /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(key)) {
        add(key, 'constant', lineOffset(lines, i), { yamlKind: 'topLevelKey' });
      }
    }
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

type AddFn = (name: string, kind: SymbolKind, offset: number, meta?: Record<string, unknown>) => void;

// ── Main plugin ────────────────────────────────────────────────────────────

export class YamlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'yaml-language',
    version: '2.0.0',
    priority: 8,
  };

  supportedExtensions = ['.yaml', '.yml'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    try {
      const source = content.toString('utf-8');
      const lines = source.split('\n');
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const seen = new Set<string>();

      const add: AddFn = (name: string, kind: SymbolKind, offset: number, meta?: Record<string, unknown>) => {
        if (!name) return;
        const id = symId(filePath, name, kind);
        if (seen.has(id)) return;
        seen.add(id);
        symbols.push({
          symbolId: id, name, kind, fqn: name,
          byteStart: offset, byteEnd: offset + name.length,
          lineStart: lineAt(source, offset), lineEnd: lineAt(source, offset),
          metadata: meta,
        });
      };

      const dialect = detectDialect(filePath, lines);

      switch (dialect) {
        case 'docker-compose':
          extractDockerCompose(filePath, lines, symbols, edges, seen, add);
          break;
        case 'github-actions':
          extractGitHubActions(filePath, lines, symbols, edges, seen, add);
          break;
        case 'gitlab-ci':
          extractGitLabCI(filePath, lines, symbols, edges, seen, add);
          break;
        case 'kubernetes':
          extractKubernetes(filePath, lines, symbols, edges, seen, add);
          break;
        case 'ansible-playbook':
          extractAnsible(filePath, lines, symbols, edges, seen, add);
          break;
        case 'openapi':
          extractOpenAPI(filePath, lines, symbols, edges, seen, add);
          break;
        case 'circleci':
          extractCircleCI(filePath, lines, symbols, edges, seen, add);
          break;
        case 'helm-chart':
          extractHelmChart(filePath, lines, symbols, edges, seen, add);
          break;
        case 'cloudformation':
          extractCloudFormation(filePath, lines, symbols, edges, seen, add);
          break;
        case 'generic':
        default:
          extractGenericYaml(filePath, lines, symbols, edges, seen, add);
          break;
      }

      return ok({
        language: 'yaml',
        status: 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        metadata: dialect !== 'generic' ? { yamlDialect: dialect } : undefined,
      });
    } catch {
      // Never throw — return empty result on any error
      return ok({
        language: 'yaml',
        status: 'ok',
        symbols: [],
      });
    }
  }
}
