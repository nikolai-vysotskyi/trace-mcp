/**
 * YAML Language Plugin — structural AST-based, dialect-aware symbol extraction.
 *
 * Uses the `yaml` package (parseDocument) for structural AST parsing with proper
 * source ranges, then walks the AST tree to extract symbols. This replaces the
 * fragile line-by-line regex+indent tracking approach.
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
import {
  type Document,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Pair,
  parseAllDocuments,
  parseDocument,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type { TraceMcpResult } from '../../../../errors.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
  SymbolKind,
} from '../../../../plugin-api/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function symId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

type AddFn = (
  name: string,
  kind: SymbolKind,
  offset: number,
  endOffset: number,
  meta?: Record<string, unknown>,
) => void;

// ── YAML AST helpers ─────────────────────────────────────────────────────

type YNode = ReturnType<Document['get']>;

/** Get string value from a scalar node */
function scalarVal(node: YNode): string | undefined {
  if (isScalar(node)) return String(node.value);
  return undefined;
}

/** Get the start offset of a YAML node */
function nodeStart(node: YNode): number {
  if (node && typeof node === 'object' && 'range' in node) {
    const range = (node as { range?: [number, number, number] }).range;
    if (range) return range[0];
  }
  return 0;
}

/** Get the end offset of a YAML node */
function nodeEnd(node: YNode): number {
  if (node && typeof node === 'object' && 'range' in node) {
    const range = (node as { range?: [number, number, number] }).range;
    if (range) return range[2];
  }
  return 0;
}

/** Get key string from a Pair */
function pairKey(pair: Pair): string | undefined {
  return scalarVal(pair.key as YNode);
}

/** Get value string from a Pair (only if value is a scalar) */
function pairVal(pair: Pair): string | undefined {
  return scalarVal(pair.value as YNode);
}

/** Get start offset of a Pair's key */
function pairStart(pair: Pair): number {
  return nodeStart(pair.key as YNode);
}

/** Get end offset of a Pair (end of its value, or key if no value) */
function pairEnd(pair: Pair): number {
  const valEnd = nodeEnd(pair.value as YNode);
  return valEnd > 0 ? valEnd : nodeEnd(pair.key as YNode);
}

/** Get a child map entry by key name from a YAMLMap */
function getMapPair(map: YAMLMap, key: string): Pair | undefined {
  for (const item of map.items) {
    if (isPair(item) && pairKey(item) === key) return item;
  }
  return undefined;
}

/** Get the value of a key from a YAMLMap, as a string */
function getMapScalar(map: YAMLMap, key: string): string | undefined {
  const pair = getMapPair(map, key);
  return pair ? pairVal(pair) : undefined;
}

/** Get the value of a key from a YAMLMap, as a YAMLMap */
function getMapMap(map: YAMLMap, key: string): YAMLMap | undefined {
  const pair = getMapPair(map, key);
  if (pair && isMap(pair.value)) return pair.value as YAMLMap;
  return undefined;
}

/** Get the value of a key from a YAMLMap, as a YAMLSeq */
function getMapSeq(map: YAMLMap, key: string): YAMLSeq | undefined {
  const pair = getMapPair(map, key);
  if (pair && isSeq(pair.value)) return pair.value as YAMLSeq;
  return undefined;
}

/** Compute line number from offset in source */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** Get all key names from a YAMLMap */
function getKeyNames(map: YAMLMap): Set<string> {
  const keys = new Set<string>();
  for (const item of map.items) {
    if (isPair(item)) {
      const k = pairKey(item);
      if (k) keys.add(k);
    }
  }
  return keys;
}

// ── Dialect detection ──────────────────────────────────────────────────────

type YamlDialect =
  | 'docker-compose'
  | 'github-actions'
  | 'gitlab-ci'
  | 'kubernetes'
  | 'kustomize'
  | 'ansible-playbook'
  | 'openapi'
  | 'circleci'
  | 'helm-chart'
  | 'cloudformation'
  | 'generic';

/**
 * Detect dialect using filename heuristics and top-level AST keys.
 */
function detectDialect(filePath: string, doc: Document): YamlDialect {
  const fn = filePath.toLowerCase().replace(/\\/g, '/');
  const baseName = fn.split('/').pop() ?? '';

  // Filename-based detection (highest priority)
  if (
    baseName === 'docker-compose.yml' ||
    baseName === 'docker-compose.yaml' ||
    baseName === 'compose.yml' ||
    baseName === 'compose.yaml'
  ) {
    return 'docker-compose';
  }
  if (fn.includes('.github/workflows/')) return 'github-actions';
  if (baseName === '.gitlab-ci.yml' || baseName === '.gitlab-ci.yaml') return 'gitlab-ci';
  if (fn.includes('.circleci/') && (baseName === 'config.yml' || baseName === 'config.yaml'))
    return 'circleci';
  if (baseName === 'chart.yaml' || baseName === 'chart.yml') return 'helm-chart';
  if (baseName === 'kustomization.yaml' || baseName === 'kustomization.yml') return 'kustomize';

  const contents = doc.contents;

  // Root is a sequence -> check for Ansible
  if (isSeq(contents)) {
    for (const item of contents.items) {
      if (isMap(item)) {
        const keys = getKeyNames(item);
        if (keys.has('hosts') || keys.has('name')) return 'ansible-playbook';
      }
    }
    return 'generic';
  }

  if (!isMap(contents)) return 'generic';

  const topKeyNames = new Set([...getKeyNames(contents)].map((k) => k.toLowerCase()));

  // Content-based detection
  if (topKeyNames.has('services') && !topKeyNames.has('apiversion')) return 'docker-compose';
  if (topKeyNames.has('on') && topKeyNames.has('jobs')) return 'github-actions';
  if (topKeyNames.has('stages')) return 'gitlab-ci';
  // Kustomize before Kubernetes — a kustomization carries `kind: Kustomization`
  // (with or without an apiVersion) and lists resources/bases/components.
  if (getMapScalar(contents, 'kind') === 'Kustomization') return 'kustomize';
  if (topKeyNames.has('apiversion') && topKeyNames.has('kind')) return 'kubernetes';
  if (topKeyNames.has('openapi') || topKeyNames.has('swagger')) return 'openapi';

  // CloudFormation
  if (topKeyNames.has('awstemplateformatversion')) return 'cloudformation';
  const resourcesMap = getMapMap(contents, 'Resources');
  if (resourcesMap) {
    for (const resPair of resourcesMap.items) {
      if (isPair(resPair) && isMap(resPair.value)) {
        const typeVal = getMapScalar(resPair.value as YAMLMap, 'Type');
        if (typeVal?.includes('AWS::')) return 'cloudformation';
      }
    }
  }

  return 'generic';
}

// ── Dialect extractors ─────────────────────────────────────────────────────

function extractDockerCompose(
  filePath: string,
  rootMap: YAMLMap,
  edges: RawEdge[],
  add: AddFn,
): void {
  // Services
  const servicesMap = getMapMap(rootMap, 'services');
  if (servicesMap) {
    for (const svcPair of servicesMap.items) {
      if (!isPair(svcPair)) continue;
      const svcName = pairKey(svcPair);
      if (!svcName) continue;

      add(svcName, 'class', pairStart(svcPair), pairEnd(svcPair), { yamlKind: 'service' });

      if (!isMap(svcPair.value)) continue;
      const svcMap = svcPair.value as YAMLMap;

      // image:
      const imagePair = getMapPair(svcMap, 'image');
      if (imagePair) {
        const imageVal = pairVal(imagePair);
        if (imageVal)
          add(`${svcName}:image`, 'constant', pairStart(imagePair), pairEnd(imagePair), {
            yamlKind: 'image',
            value: imageVal,
          });
      }

      // build: — cross-link the service to the Dockerfile / build context it
      // is built from, so impact analysis reaches the Dockerfile.
      const buildPair = getMapPair(svcMap, 'build');
      if (buildPair) {
        let buildRef: string | undefined;
        let context: string | undefined;
        if (isScalar(buildPair.value)) {
          // Short form: build: ./path
          buildRef = pairVal(buildPair);
          context = buildRef;
        } else if (isMap(buildPair.value)) {
          // Long form: build: { context: ./path, dockerfile: Dockerfile.prod }
          const buildMap = buildPair.value as YAMLMap;
          context = getMapScalar(buildMap, 'context');
          const dockerfile = getMapScalar(buildMap, 'dockerfile');
          if (context && dockerfile) {
            // Join context + dockerfile so the edge points at the actual file.
            buildRef = `${context.replace(/\/$/, '')}/${dockerfile}`;
          } else {
            buildRef = dockerfile ?? context;
          }
        }
        if (buildRef) {
          add(`${svcName}:build`, 'constant', pairStart(buildPair), pairEnd(buildPair), {
            yamlKind: 'build',
            value: buildRef,
            context,
            service: svcName,
          });
          edges.push({
            sourceSymbolId: symId(filePath, svcName, 'class'),
            targetSymbolId: symId(filePath, `${svcName}:build`, 'constant'),
            edgeType: 'imports',
            metadata: {
              dialect: 'docker-compose',
              buildLink: true,
              module: buildRef,
              context,
            },
          });
        }
      }

      // ports:
      const portsSeq = getMapSeq(svcMap, 'ports');
      if (portsSeq) {
        for (const item of portsSeq.items) {
          const portVal = scalarVal(item as YNode);
          if (portVal)
            add(
              `${svcName}:${portVal}`,
              'constant',
              nodeStart(item as YNode),
              nodeEnd(item as YNode),
              { yamlKind: 'port', value: portVal },
            );
        }
      }

      // depends_on:
      const depsPair = getMapPair(svcMap, 'depends_on');
      if (depsPair) {
        // depends_on can be a sequence or a mapping
        if (isSeq(depsPair.value)) {
          for (const item of (depsPair.value as YAMLSeq).items) {
            const dep = scalarVal(item as YNode);
            if (dep) {
              edges.push({
                sourceSymbolId: symId(filePath, svcName, 'class'),
                targetSymbolId: symId(filePath, dep, 'class'),
                edgeType: 'depends_on',
                metadata: { dialect: 'docker-compose' },
              });
            }
          }
        } else if (isMap(depsPair.value)) {
          for (const depPair of (depsPair.value as YAMLMap).items) {
            if (!isPair(depPair)) continue;
            const dep = pairKey(depPair);
            if (dep) {
              edges.push({
                sourceSymbolId: symId(filePath, svcName, 'class'),
                targetSymbolId: symId(filePath, dep, 'class'),
                edgeType: 'depends_on',
                metadata: { dialect: 'docker-compose' },
              });
            }
          }
        }
      }

      // volumes:
      const volsSeq = getMapSeq(svcMap, 'volumes');
      if (volsSeq) {
        for (const item of volsSeq.items) {
          const vol = scalarVal(item as YNode);
          if (vol) {
            const hostPath = vol.split(':')[0];
            add(
              `${svcName}:vol:${hostPath}`,
              'constant',
              nodeStart(item as YNode),
              nodeEnd(item as YNode),
              { yamlKind: 'volume', value: vol, service: svcName },
            );
          }
        }
      }

      // networks:
      const netsSeq = getMapSeq(svcMap, 'networks');
      if (netsSeq) {
        for (const item of netsSeq.items) {
          const net = scalarVal(item as YNode);
          if (net)
            add(
              `${svcName}:net:${net}`,
              'constant',
              nodeStart(item as YNode),
              nodeEnd(item as YNode),
              { yamlKind: 'network', value: net, service: svcName },
            );
        }
      }
      // networks can also be a mapping
      const netsMap = getMapMap(svcMap, 'networks');
      if (netsMap) {
        for (const netPair of netsMap.items) {
          if (!isPair(netPair)) continue;
          const net = pairKey(netPair);
          if (net)
            add(`${svcName}:net:${net}`, 'constant', pairStart(netPair), pairEnd(netPair), {
              yamlKind: 'network',
              value: net,
              service: svcName,
            });
        }
      }

      // environment:
      const envPair = getMapPair(svcMap, 'environment');
      if (envPair) {
        // Mapping form: KEY: value
        if (isMap(envPair.value)) {
          for (const ePair of (envPair.value as YAMLMap).items) {
            if (!isPair(ePair)) continue;
            const envKey = pairKey(ePair);
            if (envKey)
              add(`${svcName}:env:${envKey}`, 'variable', pairStart(ePair), pairEnd(ePair), {
                yamlKind: 'envVar',
                key: envKey,
                service: svcName,
              });
          }
        }
        // Sequence form: - KEY=value
        if (isSeq(envPair.value)) {
          for (const item of (envPair.value as YAMLSeq).items) {
            const envEntry = scalarVal(item as YNode);
            if (envEntry) {
              const eqIdx = envEntry.indexOf('=');
              if (eqIdx > 0) {
                const envKey = envEntry.slice(0, eqIdx);
                add(
                  `${svcName}:env:${envKey}`,
                  'variable',
                  nodeStart(item as YNode),
                  nodeEnd(item as YNode),
                  { yamlKind: 'envVar', key: envKey, service: svcName },
                );
              }
            }
          }
        }
      }
    }
  }

  // Top-level volumes
  const volumesMap = getMapMap(rootMap, 'volumes');
  if (volumesMap) {
    for (const pair of volumesMap.items) {
      if (!isPair(pair)) continue;
      const name = pairKey(pair);
      if (name) add(name, 'variable', pairStart(pair), pairEnd(pair), { yamlKind: 'volumeDef' });
    }
  }

  // Top-level networks
  const networksMap = getMapMap(rootMap, 'networks');
  if (networksMap) {
    for (const pair of networksMap.items) {
      if (!isPair(pair)) continue;
      const name = pairKey(pair);
      if (name) add(name, 'variable', pairStart(pair), pairEnd(pair), { yamlKind: 'networkDef' });
    }
  }
}

function extractGitHubActions(
  filePath: string,
  rootMap: YAMLMap,
  edges: RawEdge[],
  add: AddFn,
): void {
  const jobsMap = getMapMap(rootMap, 'jobs');
  if (!jobsMap) return;

  for (const jobPair of jobsMap.items) {
    if (!isPair(jobPair)) continue;
    const jobName = pairKey(jobPair);
    if (!jobName) continue;

    add(jobName, 'function', pairStart(jobPair), pairEnd(jobPair), { yamlKind: 'job' });

    if (!isMap(jobPair.value)) continue;
    const jobMap = jobPair.value as YAMLMap;

    // Steps
    const stepsSeq = getMapSeq(jobMap, 'steps');
    if (!stepsSeq) continue;

    for (const item of stepsSeq.items) {
      if (!isMap(item)) continue;
      const stepMap = item as YAMLMap;

      // Step name
      const namePair = getMapPair(stepMap, 'name');
      if (namePair) {
        const stepName = pairVal(namePair);
        if (stepName)
          add(stepName, 'constant', nodeStart(item as YNode), nodeEnd(item as YNode), {
            yamlKind: 'step',
            job: jobName,
          });
      }

      // uses:
      const usesPair = getMapPair(stepMap, 'uses');
      if (usesPair) {
        const usesVal = pairVal(usesPair);
        if (usesVal) {
          edges.push({
            edgeType: 'imports',
            metadata: { module: usesVal, dialect: 'github-actions' },
          });
        }
      }
    }
  }
}

function extractGitLabCI(filePath: string, rootMap: YAMLMap, edges: RawEdge[], add: AddFn): void {
  const reservedKeys = new Set([
    'stages',
    'variables',
    'default',
    'include',
    'image',
    'services',
    'before_script',
    'after_script',
    'cache',
    'workflow',
  ]);

  // Extract stages
  const stagesSeq = getMapSeq(rootMap, 'stages');
  if (stagesSeq) {
    for (const item of stagesSeq.items) {
      const stageName = scalarVal(item as YNode);
      if (stageName)
        add(stageName, 'constant', nodeStart(item as YNode), nodeEnd(item as YNode), {
          yamlKind: 'stage',
        });
    }
  }

  // Top-level keys that are not reserved = job names
  for (const pair of rootMap.items) {
    if (!isPair(pair)) continue;
    const key = pairKey(pair);
    if (key && !key.startsWith('.') && !reservedKeys.has(key)) {
      add(key, 'function', pairStart(pair), pairEnd(pair), { yamlKind: 'job' });
    }
  }
}

function extractKubernetes(filePath: string, rootMap: YAMLMap, edges: RawEdge[], add: AddFn): void {
  // kind:
  let kind = '';
  const kindPair = getMapPair(rootMap, 'kind');
  if (kindPair) {
    kind = pairVal(kindPair) ?? '';
    if (kind) add(kind, 'type', pairStart(kindPair), pairEnd(kindPair), { yamlKind: 'k8sKind' });
  }

  // metadata.name + namespace
  let metadataName = '';
  let namespace = '';
  const metaMap = getMapMap(rootMap, 'metadata');
  if (metaMap) {
    const namePair = getMapPair(metaMap, 'name');
    if (namePair) {
      metadataName = pairVal(namePair) ?? '';
      if (metadataName)
        add(metadataName, 'constant', pairStart(namePair), pairEnd(namePair), {
          yamlKind: 'k8sName',
          kind,
        });
    }
    namespace = getMapScalar(metaMap, 'namespace') ?? '';
  }

  // First-class Resource node — one cohesive graph entity per K8s object,
  // capturing kind + name + namespace. This is the node find_usages /
  // get_change_impact traverse, and the source of dependency edges below.
  let resourceSymbolId: string | undefined;
  if (metadataName) {
    resourceSymbolId = symId(filePath, metadataName, 'class');
    const namePair = metaMap ? getMapPair(metaMap, 'name') : undefined;
    const resStart = namePair ? pairStart(namePair) : kindPair ? pairStart(kindPair) : 0;
    const resEnd = namePair ? pairEnd(namePair) : kindPair ? pairEnd(kindPair) : 0;
    add(metadataName, 'class', resStart, resEnd, {
      yamlKind: 'k8sResource',
      k8sKind: kind,
      namespace: namespace || undefined,
    });
  }

  // Walk the entire tree for containers, volume mounts, configMapRef, secretRef, selectors
  walkK8sNode(filePath, rootMap, kind, metadataName, resourceSymbolId, edges, add);
}

/** Recursively walk Kubernetes AST nodes for nested structures */
function walkK8sNode(
  filePath: string,
  node: YNode,
  kind: string,
  metadataName: string,
  resourceSymbolId: string | undefined,
  edges: RawEdge[],
  add: AddFn,
): void {
  if (isMap(node)) {
    const map = node as YAMLMap;

    // containers:
    const containersSeq = getMapSeq(map, 'containers');
    if (containersSeq) {
      for (const item of containersSeq.items) {
        if (!isMap(item)) continue;
        const containerMap = item as YAMLMap;
        const cName = getMapScalar(containerMap, 'name');
        if (cName) {
          const cNamePair = getMapPair(containerMap, 'name')!;
          add(cName, 'constant', pairStart(cNamePair), pairEnd(cNamePair), {
            yamlKind: 'container',
          });
        }
        const cImage = getMapScalar(containerMap, 'image');
        if (cImage) {
          const cImagePair = getMapPair(containerMap, 'image')!;
          add(cImage, 'constant', pairStart(cImagePair), pairEnd(cImagePair), {
            yamlKind: 'containerImage',
          });
        }
      }
    }

    // volumeMounts entries
    const vmSeq = getMapSeq(map, 'volumeMounts');
    if (vmSeq) {
      for (const item of vmSeq.items) {
        if (!isMap(item)) continue;
        const vmMap = item as YAMLMap;
        const mp = getMapScalar(vmMap, 'mountPath');
        if (mp) {
          const mpPair = getMapPair(vmMap, 'mountPath')!;
          add(`mount:${mp}`, 'variable', pairStart(mpPair), pairEnd(mpPair), {
            yamlKind: 'volumeMount',
            kind,
            resource: metadataName,
          });
        }
      }
    }

    // configMapRef / configMapKeyRef
    for (const refKey of ['configMapRef', 'configMapKeyRef']) {
      const refMap = getMapMap(map, refKey);
      if (refMap) {
        const ref = getMapScalar(refMap, 'name');
        if (ref) {
          const refPair = getMapPair(map, refKey)!;
          add(`configMap:${ref}`, 'constant', pairStart(refPair), pairEnd(refPair), {
            yamlKind: 'configMapRef',
            resource: metadataName,
          });
          edges.push({
            sourceSymbolId: resourceSymbolId ?? symId(filePath, metadataName || kind, 'constant'),
            targetSymbolId: symId(filePath, `configMap:${ref}`, 'constant'),
            edgeType: 'depends_on',
            metadata: { dialect: 'kubernetes', refKind: 'configMap' },
          });
        }
      }
    }

    // secretRef / secretKeyRef
    for (const refKey of ['secretRef', 'secretKeyRef']) {
      const refMap = getMapMap(map, refKey);
      if (refMap) {
        const ref = getMapScalar(refMap, 'name');
        if (ref) {
          const refPair = getMapPair(map, refKey)!;
          add(`secret:${ref}`, 'constant', pairStart(refPair), pairEnd(refPair), {
            yamlKind: 'secretRef',
            resource: metadataName,
          });
          edges.push({
            sourceSymbolId: resourceSymbolId ?? symId(filePath, metadataName || kind, 'constant'),
            targetSymbolId: symId(filePath, `secret:${ref}`, 'constant'),
            edgeType: 'depends_on',
            metadata: { dialect: 'kubernetes', refKind: 'secret' },
          });
        }
      }
    }

    // Service selector with app: label
    if (kind === 'Service') {
      const selectorMap = getMapMap(map, 'selector');
      if (selectorMap) {
        const appPair = getMapPair(selectorMap, 'app');
        if (appPair) {
          const selectorApp = pairVal(appPair);
          if (selectorApp && metadataName) {
            add(`selector:${selectorApp}`, 'constant', pairStart(appPair), pairEnd(appPair), {
              yamlKind: 'serviceSelector',
              service: metadataName,
              app: selectorApp,
            });
          }
        }
      }
    }

    // Recurse into all map values
    for (const pair of map.items) {
      if (isPair(pair)) {
        walkK8sNode(
          filePath,
          pair.value as YNode,
          kind,
          metadataName,
          resourceSymbolId,
          edges,
          add,
        );
      }
    }
  } else if (isSeq(node)) {
    for (const item of (node as YAMLSeq).items) {
      walkK8sNode(filePath, item as YNode, kind, metadataName, resourceSymbolId, edges, add);
    }
  }
}

/**
 * Kustomize (kustomization.yaml) — a Module node plus IMPORTS edges to every
 * referenced resource / base / overlay / component / patch so the dependency
 * graph traverses from an overlay down into the manifests it composes.
 */
function extractKustomize(filePath: string, rootMap: YAMLMap, edges: RawEdge[], add: AddFn): void {
  // Module node — the kustomization itself. Name it after its directory so
  // overlays/prod/kustomization.yaml becomes a distinguishable graph node.
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const dirName = segments.length >= 2 ? segments[segments.length - 2] : 'kustomization';
  const moduleName = `kustomization:${dirName}`;

  const kindPair = getMapPair(rootMap, 'kind');
  const moduleStart = kindPair ? pairStart(kindPair) : 0;
  const moduleEnd = kindPair ? pairEnd(kindPair) : 0;
  const moduleId = symId(filePath, moduleName, 'namespace');
  add(moduleName, 'namespace', moduleStart, moduleEnd, {
    yamlKind: 'kustomization',
    dir: dirName,
  });

  // Keys whose sequence entries are path references to other manifests/modules.
  const refKeys = ['resources', 'bases', 'components', 'patchesStrategicMerge', 'crds'];
  for (const refKey of refKeys) {
    const seq = getMapSeq(rootMap, refKey);
    if (!seq) continue;
    for (const item of seq.items) {
      const ref = scalarVal(item as YNode);
      if (!ref) continue;
      add(`ref:${ref}`, 'constant', nodeStart(item as YNode), nodeEnd(item as YNode), {
        yamlKind: 'kustomizeRef',
        refKind: refKey,
        value: ref,
      });
      // Target the per-ref constant symbol (distinct per path) so multiple
      // resource entries do NOT collapse into one self-loop under
      // `INSERT OR IGNORE`. The IaC import resolver later rewrites this edge to
      // point at the actual manifest/module node once all files are indexed.
      edges.push({
        sourceSymbolId: moduleId,
        targetSymbolId: symId(filePath, `ref:${ref}`, 'constant'),
        edgeType: 'imports',
        metadata: { dialect: 'kustomize', module: ref, refKind: refKey },
      });
    }
  }

  // patches: can be a sequence of objects with a `path` key.
  const patchesSeq = getMapSeq(rootMap, 'patches');
  if (patchesSeq) {
    for (const item of patchesSeq.items) {
      if (!isMap(item)) continue;
      const p = getMapScalar(item as YAMLMap, 'path');
      if (!p) continue;
      const pathPair = getMapPair(item as YAMLMap, 'path')!;
      add(`ref:${p}`, 'constant', pairStart(pathPair), pairEnd(pathPair), {
        yamlKind: 'kustomizeRef',
        refKind: 'patches',
        value: p,
      });
      edges.push({
        sourceSymbolId: moduleId,
        targetSymbolId: symId(filePath, `ref:${p}`, 'constant'),
        edgeType: 'imports',
        metadata: { dialect: 'kustomize', module: p, refKind: 'patches' },
      });
    }
  }
}

function extractAnsible(filePath: string, doc: Document, edges: RawEdge[], add: AddFn): void {
  const contents = doc.contents;
  if (!isSeq(contents)) return;

  for (const item of contents.items) {
    if (!isMap(item)) continue;
    const playMap = item as YAMLMap;

    // Play name (top-level - name:)
    const namePair = getMapPair(playMap, 'name');
    if (namePair) {
      const name = pairVal(namePair);
      if (name)
        add(name, 'constant', nodeStart(item as YNode), nodeEnd(item as YNode), {
          yamlKind: 'play',
        });
    }

    // Tasks
    const tasksSeq = getMapSeq(playMap, 'tasks');
    if (tasksSeq) {
      for (const taskItem of tasksSeq.items) {
        if (!isMap(taskItem)) continue;
        const taskMap = taskItem as YAMLMap;
        const taskNamePair = getMapPair(taskMap, 'name');
        if (taskNamePair) {
          const taskName = pairVal(taskNamePair);
          if (taskName)
            add(taskName, 'function', nodeStart(taskItem as YNode), nodeEnd(taskItem as YNode), {
              yamlKind: 'task',
            });
        }
      }
    }

    // Roles
    const rolesSeq = getMapSeq(playMap, 'roles');
    if (rolesSeq) {
      for (const roleItem of rolesSeq.items) {
        // Simple string role
        const roleText = scalarVal(roleItem as YNode);
        if (roleText && !roleText.includes(':')) {
          edges.push({
            edgeType: 'imports',
            metadata: { module: roleText, dialect: 'ansible-playbook' },
          });
          continue;
        }

        // Mapping form: - role: name
        if (isMap(roleItem)) {
          const roleName = getMapScalar(roleItem as YAMLMap, 'role');
          if (roleName)
            edges.push({
              edgeType: 'imports',
              metadata: { module: roleName, dialect: 'ansible-playbook' },
            });
        }
      }
    }
  }
}

function extractOpenAPI(filePath: string, rootMap: YAMLMap, edges: RawEdge[], add: AddFn): void {
  // Paths
  const pathsMap = getMapMap(rootMap, 'paths');
  if (pathsMap) {
    for (const pathPair of pathsMap.items) {
      if (!isPair(pathPair)) continue;
      const pathName = pairKey(pathPair);
      if (!pathName || !isMap(pathPair.value)) continue;

      const methodMap = pathPair.value as YAMLMap;
      const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

      for (const mPair of methodMap.items) {
        if (!isPair(mPair)) continue;
        const method = pairKey(mPair)?.toLowerCase();
        if (!method || !methods.includes(method)) continue;
        if (!isMap(mPair.value)) continue;

        const opMap = mPair.value as YAMLMap;
        const operationId = getMapScalar(opMap, 'operationId');
        const summary = getMapScalar(opMap, 'summary');
        const tagsSeq = getMapSeq(opMap, 'tags');
        const tags: string[] = [];
        if (tagsSeq) {
          for (const t of tagsSeq.items) {
            const tv = scalarVal(t);
            if (tv) tags.push(tv);
          }
        }

        const meta: Record<string, unknown> = {
          yamlKind: 'endpoint',
          method: method.toUpperCase(),
          path: pathName,
        };
        if (operationId) meta.operationId = operationId;
        if (summary) meta.summary = summary;
        if (tags.length > 0) meta.tags = tags;

        const label = `${method.toUpperCase()} ${pathName}`;
        add(label, 'function', pairStart(mPair), pairEnd(mPair), meta);

        // operationId is what handler code references — make it findable by find_usages.
        if (operationId) {
          add(operationId, 'function', pairStart(mPair), pairEnd(mPair), {
            yamlKind: 'operationId',
            method: method.toUpperCase(),
            path: pathName,
            tags: tags.length > 0 ? tags : undefined,
          });
        }

        // $ref edges from this operation (request/response schemas)
        collectRefs(opMap, edges);
      }
    }
  }

  // Schemas -- under components.schemas
  const componentsMap = getMapMap(rootMap, 'components');
  if (componentsMap) {
    const schemasMap = getMapMap(componentsMap, 'schemas');
    if (schemasMap) extractSchemas(schemasMap, edges, add);
  }

  // Swagger 2.0 definitions
  const definitionsMap = getMapMap(rootMap, 'definitions');
  if (definitionsMap) extractSchemas(definitionsMap, edges, add);
}

function extractSchemas(schemasMap: YAMLMap, edges: RawEdge[], add: AddFn): void {
  for (const pair of schemasMap.items) {
    if (!isPair(pair)) continue;
    const schemaName = pairKey(pair);
    if (!schemaName) continue;
    add(schemaName, 'type', pairStart(pair), pairEnd(pair), { yamlKind: 'schema' });
    // Walk schema body for $ref dependencies (Schema → Schema imports edges).
    if (isMap(pair.value) || isSeq(pair.value)) {
      collectRefs(pair.value as YAMLMap | YAMLSeq, edges, schemaName);
    }
  }
}

/**
 * Walk a YAML node tree collecting `$ref` strings as `imports` edges.
 * Resolves `#/components/schemas/Foo` → module=`Foo` so find_usages
 * can connect schema references back to schema symbols.
 */
function collectRefs(node: YAMLMap | YAMLSeq | YNode, edges: RawEdge[], from?: string): void {
  if (!node) return;
  if (isMap(node)) {
    for (const pair of (node as YAMLMap).items) {
      if (!isPair(pair)) continue;
      const key = pairKey(pair);
      if (key === '$ref') {
        const ref = pairVal(pair);
        if (ref) {
          const m = ref.match(/\/([^/]+)$/);
          const target = m ? m[1] : ref;
          const meta: Record<string, unknown> = { module: target, ref, dialect: 'openapi' };
          if (from) meta.from = from;
          edges.push({ edgeType: 'imports', metadata: meta });
        }
        continue;
      }
      if (isMap(pair.value) || isSeq(pair.value)) {
        collectRefs(pair.value as YAMLMap | YAMLSeq, edges, from);
      }
    }
  } else if (isSeq(node)) {
    for (const item of (node as YAMLSeq).items) {
      if (isMap(item) || isSeq(item)) {
        collectRefs(item as YAMLMap | YAMLSeq, edges, from);
      }
    }
  }
}

function extractCircleCI(filePath: string, rootMap: YAMLMap, edges: RawEdge[], add: AddFn): void {
  // Jobs
  const jobsMap = getMapMap(rootMap, 'jobs');
  if (jobsMap) {
    for (const pair of jobsMap.items) {
      if (!isPair(pair)) continue;
      const jobName = pairKey(pair);
      if (jobName) add(jobName, 'function', pairStart(pair), pairEnd(pair), { yamlKind: 'job' });
    }
  }

  // Orbs
  const orbsMap = getMapMap(rootMap, 'orbs');
  if (orbsMap) {
    for (const pair of orbsMap.items) {
      if (!isPair(pair)) continue;
      const orbAlias = pairKey(pair);
      const orbRef = pairVal(pair);
      if (orbRef) {
        edges.push({
          edgeType: 'imports',
          metadata: { module: orbRef, alias: orbAlias, dialect: 'circleci' },
        });
      }
    }
  }
}

function extractHelmChart(filePath: string, rootMap: YAMLMap, edges: RawEdge[], add: AddFn): void {
  // name:
  const namePair = getMapPair(rootMap, 'name');
  if (namePair) {
    const val = pairVal(namePair);
    if (val)
      add(val, 'constant', pairStart(namePair), pairEnd(namePair), { yamlKind: 'chartName' });
  }

  // version:
  const versionPair = getMapPair(rootMap, 'version');
  if (versionPair) {
    const val = pairVal(versionPair);
    if (val)
      add(val, 'constant', pairStart(versionPair), pairEnd(versionPair), {
        yamlKind: 'chartVersion',
      });
  }

  // dependencies:
  const depsSeq = getMapSeq(rootMap, 'dependencies');
  if (depsSeq) {
    for (const item of depsSeq.items) {
      if (!isMap(item)) continue;
      const depMap = item as YAMLMap;
      const depName = getMapScalar(depMap, 'name');
      if (depName) {
        add(depName, 'constant', nodeStart(item as YNode), nodeEnd(item as YNode), {
          yamlKind: 'helmDep',
        });
        edges.push({ edgeType: 'imports', metadata: { module: depName, dialect: 'helm-chart' } });
      }
    }
  }
}

function extractCloudFormation(
  filePath: string,
  rootMap: YAMLMap,
  edges: RawEdge[],
  add: AddFn,
): void {
  const resourcesMap = getMapMap(rootMap, 'Resources');
  if (!resourcesMap) return;

  for (const resPair of resourcesMap.items) {
    if (!isPair(resPair)) continue;
    const resName = pairKey(resPair);
    if (!resName) continue;

    add(resName, 'class', pairStart(resPair), pairEnd(resPair), { yamlKind: 'cfnResource' });

    if (!isMap(resPair.value)) continue;
    const resMap = resPair.value as YAMLMap;
    const typePair = getMapPair(resMap, 'Type');
    if (typePair) {
      const resType = pairVal(typePair);
      if (resType)
        add(`${resName}:${resType}`, 'type', pairStart(typePair), pairEnd(typePair), {
          yamlKind: 'cfnResourceType',
          resource: resName,
          type: resType,
        });
    }
  }
}

function extractGenericYaml(filePath: string, rootMap: YAMLMap, add: AddFn): void {
  for (const pair of rootMap.items) {
    if (!isPair(pair)) continue;
    const key = pairKey(pair);
    if (key && /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(key)) {
      add(key, 'constant', pairStart(pair), pairEnd(pair), { yamlKind: 'topLevelKey' });
    }
  }
}

// ── Main plugin ────────────────────────────────────────────────────────────

export class YamlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'yaml-language',
    version: '3.0.0',
    priority: 8,
  };

  supportedExtensions = ['.yaml', '.yml'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    try {
      const source = content.toString('utf-8');
      const doc = parseDocument(source, { keepSourceTokens: true });

      const hasErrors = doc.errors.length > 0;
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const seen = new Set<string>();
      const warnings: string[] = [];

      if (hasErrors) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      const add: AddFn = (
        name: string,
        kind: SymbolKind,
        offset: number,
        endOffset: number,
        meta?: Record<string, unknown>,
      ) => {
        if (!name) return;
        const id = symId(filePath, name, kind);
        if (seen.has(id)) return;
        seen.add(id);
        symbols.push({
          symbolId: id,
          name,
          kind,
          fqn: name,
          byteStart: offset,
          byteEnd: endOffset,
          lineStart: lineAt(source, offset),
          lineEnd: lineAt(source, endOffset > 0 ? endOffset - 1 : offset),
          metadata: meta,
        });
      };

      // Dialect is detected from the first document, then each document in a
      // multi-document file (`---` separated) is dispatched. This matters for
      // Kubernetes manifests, which routinely pack several objects per file.
      const dialect = detectDialect(filePath, doc);

      const dispatchDoc = (d: Document): void => {
        const contents = d.contents;
        switch (dialect) {
          case 'docker-compose':
            if (isMap(contents)) extractDockerCompose(filePath, contents, edges, add);
            break;
          case 'github-actions':
            if (isMap(contents)) extractGitHubActions(filePath, contents, edges, add);
            break;
          case 'gitlab-ci':
            if (isMap(contents)) extractGitLabCI(filePath, contents, edges, add);
            break;
          case 'kubernetes':
            if (isMap(contents)) extractKubernetes(filePath, contents, edges, add);
            break;
          case 'kustomize':
            if (isMap(contents)) extractKustomize(filePath, contents, edges, add);
            break;
          case 'ansible-playbook':
            extractAnsible(filePath, d, edges, add);
            break;
          case 'openapi':
            if (isMap(contents)) extractOpenAPI(filePath, contents, edges, add);
            break;
          case 'circleci':
            if (isMap(contents)) extractCircleCI(filePath, contents, edges, add);
            break;
          case 'helm-chart':
            if (isMap(contents)) extractHelmChart(filePath, contents, edges, add);
            break;
          case 'cloudformation':
            if (isMap(contents)) extractCloudFormation(filePath, contents, edges, add);
            break;
          default:
            if (isMap(contents)) extractGenericYaml(filePath, contents, add);
            break;
        }
      };

      // Kubernetes is the only dialect where multi-document is idiomatic; for
      // the rest we keep the single-document parse to avoid behaviour changes.
      if (dialect === 'kubernetes') {
        const allDocs = parseAllDocuments(source, { keepSourceTokens: true });
        for (const d of allDocs) {
          if (d.contents) dispatchDoc(d);
        }
      } else {
        dispatchDoc(doc);
      }

      return ok({
        language: 'yaml',
        status: hasErrors ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        metadata: dialect !== 'generic' ? { yamlDialect: dialect } : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch {
      // Never throw -- return empty result on any error
      return ok({
        language: 'yaml',
        status: 'ok',
        symbols: [],
      });
    }
  }
}
