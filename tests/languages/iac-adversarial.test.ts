/**
 * Adversarial hardening for the IaC / K8s / Kustomize YAML paths.
 *
 * These probe the failure modes a real infra repo will hit: a broken document
 * inside a multi-document manifest, a compose service with no matching
 * Dockerfile, a kustomization pointing at a non-existent resource, and
 * non-namespaced / List-wrapping K8s kinds. The indexer must degrade
 * gracefully — never crash, never drop a whole valid file because one document
 * beside it is broken.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { DockerfileLanguagePlugin } from '../../src/indexer/plugins/language/dockerfile/index.js';
import { YamlLanguagePlugin } from '../../src/indexer/plugins/language/yaml-lang/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const yaml = new YamlLanguagePlugin();

async function parseYaml(source: string, filePath = 'config.yaml') {
  const result = await yaml.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('IaC adversarial hardening', () => {
  describe('malformed multi-document YAML (partial success)', () => {
    it('still indexes the valid Deployment doc when a sibling doc is broken', async () => {
      // Doc 1: valid Deployment. Doc 2: broken (unclosed flow map / bad indent).
      const r = await parseYaml(
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: good-app
spec:
  replicas: 1
---
apiVersion: v1
kind: Service
metadata:
  name: broken-svc
spec:
  ports: [ { port: 80, : bad }
`,
        'k8s/mixed.yaml',
      );

      // The valid Deployment Resource must survive.
      const good = r.symbols.find(
        (s) => s.metadata?.yamlKind === 'k8sResource' && s.name === 'good-app',
      );
      expect(good).toBeDefined();
      expect(good!.metadata?.k8sKind).toBe('Deployment');
      // Result should not be an error; partial is acceptable.
      expect(r.status === 'ok' || r.status === 'partial').toBe(true);
    });

    it('does not crash on a fully broken single document', async () => {
      const r = await parseYaml(`: : : [ { unbalanced\n\t\tbad`, 'k8s/garbage.yaml');
      // Never throws; returns some result (possibly empty symbols).
      expect(Array.isArray(r.symbols)).toBe(true);
    });
  });

  describe('K8s resource with no matching Dockerfile/image', () => {
    it('emits no spurious build/import edge for a plain Deployment', async () => {
      const r = await parseYaml(
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: no-image-app
spec:
  replicas: 2`,
        'k8s/plain.yaml',
      );
      const buildEdges = (r.edges ?? []).filter(
        (e) => e.edgeType === 'imports' && (e.metadata as any)?.buildLink === true,
      );
      expect(buildEdges.length).toBe(0);
    });
  });

  describe('List / non-namespaced kinds', () => {
    it('handles a cluster-scoped ClusterRole (no namespace) without crashing', async () => {
      const r = await parseYaml(
        `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: reader
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]`,
        'k8s/clusterrole.yaml',
      );
      expect(r.metadata?.yamlDialect).toBe('kubernetes');
      const resource = r.symbols.find(
        (s) => s.metadata?.yamlKind === 'k8sResource' && s.name === 'reader',
      );
      expect(resource).toBeDefined();
      expect(resource!.metadata?.k8sKind).toBe('ClusterRole');
      // No namespace present — metadata.namespace must be absent/undefined, not "".
      expect(resource!.metadata?.namespace).toBeUndefined();
    });

    it('does not silently mis-model a bare List wrapper as a single resource', async () => {
      const r = await parseYaml(
        `apiVersion: v1
kind: List
items:
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: item-a
  - apiVersion: v1
    kind: Service
    metadata:
      name: item-b`,
        'k8s/list.yaml',
      );
      expect(r.metadata?.yamlDialect).toBe('kubernetes');
      // A List must not be modeled as a Resource named after items[].name of the
      // first item, nor crash. Document the observed behaviour explicitly.
      const asListResource = r.symbols.find(
        (s) => s.metadata?.yamlKind === 'k8sResource' && s.metadata?.k8sKind === 'List',
      );
      // Either the List is skipped (no k8sResource of kind List) OR items are
      // surfaced. What must NOT happen: a List resource named 'item-a'.
      if (asListResource) {
        expect(asListResource.name).not.toBe('item-a');
      }
      expect(Array.isArray(r.symbols)).toBe(true);
    });
  });
});

describe('IaC adversarial E2E (pipeline)', () => {
  let store: Store;
  let fixtureDir: string;

  const FILES: Record<string, string> = {
    // compose service whose build context has NO Dockerfile on disk.
    'docker-compose.yml': `services:
  ghost:
    build: ./nowhere
`,
    // kustomization referencing a resource that does not exist.
    'infra/kustomization.yaml': `kind: Kustomization
resources:
  - does-not-exist.yaml
  - real.yaml
`,
    'infra/real.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: real-cm
`,
  };

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-iac-adv-');
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
    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => removeTmpDir(fixtureDir));

  it('indexes without crashing when refs dangle', () => {
    expect(store.getAllFiles().length).toBeGreaterThan(0);
  });

  it('leaves no self-loop imports edges even when some refs dangle', () => {
    const imports = store.getEdgesByType('imports');
    for (const e of imports) {
      expect(e.source_node_id).not.toBe(e.target_node_id);
    }
  });

  it('resolves the one real kustomize resource and drops the dangling one', () => {
    const files = store.getAllFiles();
    const kustom = files.find((f) => f.path.endsWith('kustomization.yaml'))!;
    const syms = store.getSymbolsByFile(kustom.id);
    const moduleSym = syms.find((s) => {
      const m = JSON.parse(s.metadata ?? '{}');
      return m.yamlKind === 'kustomization';
    })!;
    const moduleNode = store.getNodeId('symbol', moduleSym.id)!;
    const importsOut = store
      .getOutgoingEdges(moduleNode)
      .filter((e) => e.edge_type_name === 'imports');
    // real.yaml resolves; does-not-exist.yaml is dropped (dangling).
    const targets = importsOut.map((e) => {
      const ref = store.getNodeRef(e.target_node_id);
      if (!ref) return '';
      if (ref.nodeType === 'file') return store.getFileById(ref.refId)?.path ?? '';
      const sym = store.getSymbolById(ref.refId);
      return sym?.file_id != null ? (store.getFileById(sym.file_id)?.path ?? '') : '';
    });
    expect(targets.some((t) => t.endsWith('real.yaml'))).toBe(true);
    expect(targets.some((t) => t.includes('does-not-exist'))).toBe(false);
  });
});
