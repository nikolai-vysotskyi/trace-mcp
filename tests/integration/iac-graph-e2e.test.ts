/**
 * IaC-as-graph-nodes E2E.
 *
 * Indexes a small infrastructure fixture (K8s Deployment + Service, a
 * kustomization composing them, a Dockerfile, a docker-compose with a build
 * link) through the full IndexingPipeline and asserts the new infra symbols
 * become real graph nodes and that the K8s depends_on edge is a traversable
 * graph edge from the first-class Resource node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { DockerfileLanguagePlugin } from '../../src/indexer/plugins/language/dockerfile/index.js';
import { YamlLanguagePlugin } from '../../src/indexer/plugins/language/yaml-lang/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const FILES: Record<string, string> = {
  'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: web
          image: web:latest
          envFrom:
            - configMapRef:
                name: web-config
`,
  'k8s/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  selector:
    app: web
`,
  'k8s/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
`,
  Dockerfile: `FROM node:20 AS builder
WORKDIR /app
FROM builder AS runtime
CMD ["node", "index.js"]
`,
  'docker-compose.yml': `services:
  web:
    build: .
    ports:
      - "80:80"
`,
};

function nodeIdForSymbol(store: Store, symbolId: string): number | undefined {
  const sym = store.getSymbolBySymbolId(symbolId);
  if (!sym) return undefined;
  return store.getNodeId('symbol', sym.id);
}

describe('IaC graph E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-iac-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new YamlLanguagePlugin());
    registry.registerLanguagePlugin(new DockerfileLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.yaml', '**/*.yml', '**/Dockerfile'],
      exclude: ['node_modules/**'],
      db: { path: ':memory:' },
      plugins: [],
    } as TraceMcpConfig;

    const pipeline = new IndexingPipeline(store, registry, config, fixtureDir);
    await pipeline.indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('indexes the infra fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('emits a first-class K8s Resource node with kind + namespace', () => {
    const resource = store.getSymbolBySymbolId('k8s/deployment.yaml::web#class');
    expect(resource).toBeDefined();
    const meta = JSON.parse(resource!.metadata ?? '{}');
    expect(meta.yamlKind).toBe('k8sResource');
    expect(meta.k8sKind).toBe('Deployment');
    expect(meta.namespace).toBe('production');
  });

  it('makes the configMap depends_on edge traversable from the Resource node', () => {
    const resourceNode = nodeIdForSymbol(store, 'k8s/deployment.yaml::web#class');
    expect(resourceNode).toBeDefined();
    const out = store
      .getOutgoingEdges(resourceNode!)
      .filter((e) => e.edge_type_name === 'depends_on');
    expect(out.length).toBeGreaterThan(0);

    // The target configMap node must also receive the edge (incoming).
    const cmNode = nodeIdForSymbol(store, 'k8s/deployment.yaml::configMap:web-config#constant');
    expect(cmNode).toBeDefined();
    const incoming = store
      .getIncomingEdges(cmNode!)
      .filter((e) => e.edge_type_name === 'depends_on');
    expect(incoming.length).toBeGreaterThan(0);
  });

  it('emits a Kustomize Module node', () => {
    const files = store.getAllFiles();
    const kustomFile = files.find((f) => f.path.endsWith('kustomization.yaml'));
    expect(kustomFile).toBeDefined();
    const syms = store.getSymbolsByFile(kustomFile!.id);
    const moduleSym = syms.find((s) => {
      const m = JSON.parse(s.metadata ?? '{}');
      return m.yamlKind === 'kustomization';
    });
    expect(moduleSym).toBeDefined();
    expect(moduleSym!.kind).toBe('namespace');
  });

  it('emits Dockerfile FROM stages as module symbols', () => {
    const files = store.getAllFiles();
    const dockerfile = files.find((f) => f.path.endsWith('Dockerfile'));
    expect(dockerfile).toBeDefined();
    const syms = store.getSymbolsByFile(dockerfile!.id);
    expect(syms.some((s) => s.kind === 'module')).toBe(true);
  });
});
