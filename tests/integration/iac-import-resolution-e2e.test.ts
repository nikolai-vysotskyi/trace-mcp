/**
 * IaC cross-file import resolution E2E.
 *
 * The YAML plugin emits `imports` edges from a Kustomization Module to each
 * referenced resource path (`resources: [deployment.yaml, ...]`) and from a
 * compose service to its build context / Dockerfile. Those edges initially
 * carry a path-STRING target in `metadata.module` and no resolved graph node —
 * so before resolution they collapse into useless self-loops on the source
 * node.
 *
 * A dedicated post-pass (resolveIacImportEdges) resolves those path strings —
 * relative to the source file's directory — to the actual target file / Resource
 * node, so find_usages / get_change_impact traverse from a Kustomize Module down
 * into the manifest it composes, and from a compose service into its Dockerfile.
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

function fileNodeId(store: Store, path: string): number | undefined {
  const f = store.getFile(path);
  if (!f) return undefined;
  return store.getNodeId('file', f.id);
}

describe('IaC import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-iac-res-');
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

  it('resolves the Kustomize imports edge to the referenced resource manifest (not a self-loop)', () => {
    const kustomModule = nodeIdForSymbol(
      store,
      'k8s/kustomization.yaml::kustomization:k8s#namespace',
    );
    expect(kustomModule).toBeDefined();

    const importsOut = store
      .getOutgoingEdges(kustomModule!)
      .filter((e) => e.edge_type_name === 'imports');

    // No self-loops must remain.
    for (const e of importsOut) {
      expect(e.source_node_id).not.toBe(e.target_node_id);
    }

    // Both referenced resources (deployment.yaml + service.yaml) must resolve.
    const targetRefs = importsOut.map((e) => store.getNodeRef(e.target_node_id));
    const targetPaths = new Set<string>();
    for (const ref of targetRefs) {
      if (!ref) continue;
      if (ref.nodeType === 'file') {
        targetPaths.add(store.getFileById(ref.refId)?.path ?? '');
      } else if (ref.nodeType === 'symbol') {
        const sym = store.getSymbolById(ref.refId);
        const fileId = sym?.file_id;
        if (fileId != null) targetPaths.add(store.getFileById(fileId)?.path ?? '');
      }
    }
    expect(targetPaths.has('k8s/deployment.yaml')).toBe(true);
    expect(targetPaths.has('k8s/service.yaml')).toBe(true);
  });

  it('makes the deployment reachable from the kustomization via get change impact traversal', () => {
    // Incoming imports edge on the deployment file (or its Resource node).
    const depFileNode = fileNodeId(store, 'k8s/deployment.yaml');
    const depResourceNode = nodeIdForSymbol(store, 'k8s/deployment.yaml::web#class');
    const candidates = [depFileNode, depResourceNode].filter((n): n is number => n != null);
    let incomingImports = 0;
    for (const n of candidates) {
      incomingImports += store
        .getIncomingEdges(n)
        .filter((e) => e.edge_type_name === 'imports').length;
    }
    expect(incomingImports).toBeGreaterThan(0);
  });

  it('resolves the compose build imports edge to the Dockerfile / build context (not a self-loop)', () => {
    const serviceNode = nodeIdForSymbol(store, 'docker-compose.yml::web#class');
    expect(serviceNode).toBeDefined();

    const importsOut = store
      .getOutgoingEdges(serviceNode!)
      .filter((e) => e.edge_type_name === 'imports');
    expect(importsOut.length).toBeGreaterThan(0);
    for (const e of importsOut) {
      expect(e.source_node_id).not.toBe(e.target_node_id);
    }

    // Target must resolve to the Dockerfile file node (build: . -> ./Dockerfile).
    const dockerfileNode = fileNodeId(store, 'Dockerfile');
    expect(dockerfileNode).toBeDefined();
    const reachesDockerfile = importsOut.some((e) => e.target_node_id === dockerfileNode);
    expect(reachesDockerfile).toBe(true);
  });
});
