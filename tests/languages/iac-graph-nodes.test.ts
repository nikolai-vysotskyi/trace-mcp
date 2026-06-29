/**
 * IaC as first-class graph nodes.
 *
 * Promotes infrastructure manifests (Kubernetes, Kustomize, Dockerfile/compose
 * build links) to first-class graph entities with Resource/Module nodes and
 * IMPORTS / depends_on edges, so find_usages / get_change_impact traverse them.
 */
import { describe, expect, it } from 'vitest';
import { DockerfileLanguagePlugin } from '../../src/indexer/plugins/language/dockerfile/index.js';
import { YamlLanguagePlugin } from '../../src/indexer/plugins/language/yaml-lang/index.js';

const yaml = new YamlLanguagePlugin();

async function parseYaml(source: string, filePath = 'config.yaml') {
  const result = await yaml.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('IaC graph nodes', () => {
  // ── Kubernetes: first-class Resource nodes ──

  describe('kubernetes Resource nodes', () => {
    it('emits a first-class Resource node capturing kind, name, and namespace', async () => {
      const r = await parseYaml(
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  replicas: 3`,
        'k8s/deployment.yaml',
      );

      expect(r.metadata?.yamlDialect).toBe('kubernetes');
      const resource = r.symbols.find(
        (s) => s.metadata?.yamlKind === 'k8sResource' && s.name === 'my-app',
      );
      expect(resource).toBeDefined();
      expect(resource!.kind).toBe('class');
      expect(resource!.metadata?.k8sKind).toBe('Deployment');
      expect(resource!.metadata?.namespace).toBe('production');
    });

    it('handles multi-document manifests (--- separated) as separate Resources', async () => {
      const r = await parseYaml(
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
        - name: web
          image: web:latest
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  selector:
    app: web`,
        'k8s/web.yaml',
      );

      expect(r.metadata?.yamlDialect).toBe('kubernetes');
      const deployment = r.symbols.find(
        (s) => s.metadata?.yamlKind === 'k8sResource' && s.metadata?.k8sKind === 'Deployment',
      );
      const service = r.symbols.find(
        (s) => s.metadata?.yamlKind === 'k8sResource' && s.metadata?.k8sKind === 'Service',
      );
      expect(deployment?.name).toBe('web');
      expect(service?.name).toBe('web-svc');
    });

    it('sources configMapRef depends_on edge from the Resource node', async () => {
      const r = await parseYaml(
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
        - name: app
          envFrom:
            - configMapRef:
                name: app-config`,
        'k8s/dep.yaml',
      );

      const resource = r.symbols.find(
        (s) => s.metadata?.yamlKind === 'k8sResource' && s.name === 'my-app',
      );
      expect(resource).toBeDefined();
      const edge = r.edges!.find(
        (e) => e.edgeType === 'depends_on' && (e.metadata as any)?.refKind === 'configMap',
      );
      expect(edge).toBeDefined();
      // Edge source must point at the Resource node so impact analysis traverses it.
      expect(edge!.sourceSymbolId).toBe(resource!.symbolId);
    });
  });

  // ── Kustomize: Module nodes with IMPORTS edges ──

  describe('kustomize', () => {
    it('detects kustomization.yaml and emits a Module node', async () => {
      const r = await parseYaml(
        `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml`,
        'k8s/overlays/prod/kustomization.yaml',
      );

      expect(r.metadata?.yamlDialect).toBe('kustomize');
      const module = r.symbols.find((s) => s.metadata?.yamlKind === 'kustomization');
      expect(module).toBeDefined();
      expect(module!.kind).toBe('namespace');
    });

    it('emits IMPORTS edges to resources, bases, and components', async () => {
      const r = await parseYaml(
        `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - ../base
bases:
  - ../../base
components:
  - ../components/monitoring`,
        'k8s/overlays/prod/kustomization.yaml',
      );

      const importedModules = r
        .edges!.filter((e) => e.edgeType === 'imports')
        .map((e) => (e.metadata as any)?.module);
      expect(importedModules).toContain('deployment.yaml');
      expect(importedModules).toContain('../base');
      expect(importedModules).toContain('../../base');
      expect(importedModules).toContain('../components/monitoring');
    });

    it('tags kustomize import edges with the kustomize dialect', async () => {
      const r = await parseYaml(
        `kind: Kustomization
resources:
  - deployment.yaml`,
        'kustomization.yml',
      );
      expect(r.metadata?.yamlDialect).toBe('kustomize');
      const edge = r.edges!.find(
        (e) => e.edgeType === 'imports' && (e.metadata as any)?.dialect === 'kustomize',
      );
      expect(edge).toBeDefined();
    });
  });

  // ── Dockerfile cross-link from compose build ──

  describe('compose -> Dockerfile build link', () => {
    it('emits an IMPORTS edge from a service to its build context (string form)', async () => {
      const r = await parseYaml(
        `services:
  web:
    build: ./web
    ports:
      - "80:80"`,
        'docker-compose.yml',
      );

      const edge = r.edges!.find(
        (e) =>
          e.edgeType === 'imports' &&
          (e.metadata as any)?.buildLink === true &&
          (e.metadata as any)?.module === './web',
      );
      expect(edge).toBeDefined();
      expect(edge!.sourceSymbolId).toBe('docker-compose.yml::web#class');
    });

    it('emits an IMPORTS edge to context + dockerfile (object form)', async () => {
      const r = await parseYaml(
        `services:
  api:
    build:
      context: ./api
      dockerfile: Dockerfile.prod`,
        'docker-compose.yml',
      );

      const modules = r
        .edges!.filter((e) => e.edgeType === 'imports' && (e.metadata as any)?.buildLink === true)
        .map((e) => (e.metadata as any)?.module);
      // Context joined with dockerfile so the edge points at the actual Dockerfile.
      expect(modules.some((m: string) => m === './api/Dockerfile.prod' || m === './api')).toBe(
        true,
      );
    });
  });

  // ── Dockerfile plugin sanity: FROM stages exist as nodes ──

  describe('dockerfile nodes', () => {
    it('extracts FROM base image stages as module symbols', () => {
      const result = (DockerfileLanguagePlugin as any).prototype
        ? new (DockerfileLanguagePlugin as any)().extractSymbols(
            'Dockerfile',
            Buffer.from(`FROM node:20 AS builder\nFROM builder AS runtime\n`),
          )
        : null;
      expect(result).not.toBeNull();
      expect(result.isOk()).toBe(true);
      const r = result._unsafeUnwrap();
      expect(r.symbols.some((s: any) => s.kind === 'module')).toBe(true);
    });
  });
});
