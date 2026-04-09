import { describe, it, expect } from 'vitest';
import { YamlLanguagePlugin } from '../../src/indexer/plugins/language/yaml-lang/index.js';

const plugin = new YamlLanguagePlugin();

async function parse(source: string, filePath = 'config.yaml') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('YamlLanguagePlugin', () => {
  // ── Manifest ──

  it('has correct manifest', async () => {
    expect(plugin.manifest.name).toBe('yaml-language');
    expect(plugin.supportedExtensions).toContain('.yaml');
    expect(plugin.supportedExtensions).toContain('.yml');
  });

  // ── Generic YAML ──

  describe('generic', () => {
    it('extracts top-level keys as constants', async () => {
      const r = await parse('database:\n  host: localhost\nlogging:\n  level: debug\nserver:\n  port: 8080');
      expect(r.symbols.some(s => s.name === 'database' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'logging' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'server' && s.kind === 'constant')).toBe(true);
      // metadata is undefined for generic dialect
      expect(r.metadata?.yamlDialect).toBeUndefined();
    });

    it('ignores comments and indented keys', async () => {
      const r = await parse('# comment\ntop_key:\n  nested: val');
      expect(r.symbols.some(s => s.name === 'top_key')).toBe(true);
      expect(r.symbols.some(s => s.name === 'nested')).toBe(false);
    });

    it('handles empty file', async () => {
      const r = await parse('');
      expect(r.symbols).toHaveLength(0);
    });
  });

  // ── Docker Compose ──

  describe('docker-compose', () => {
    it('extracts services as classes with depends_on edges', async () => {
      const r = await parse(
        `services:
  web:
    image: nginx:latest
    depends_on:
      - db
  db:
    image: postgres:15
    ports:
      - "5432:5432"`,
        'docker-compose.yml',
      );

      expect(r.metadata?.yamlDialect).toBe('docker-compose');
      expect(r.symbols.some(s => s.name === 'web' && s.kind === 'class')).toBe(true);
      expect(r.symbols.some(s => s.name === 'db' && s.kind === 'class')).toBe(true);
      // image constants
      expect(r.symbols.some(s => s.name === 'web:image' && s.kind === 'constant')).toBe(true);
      // depends_on edge
      expect(r.edges!.some(e => e.edgeType === 'depends_on')).toBe(true);
    });
  });

  // ── GitHub Actions ──

  describe('github-actions', () => {
    it('extracts jobs as functions and uses as import edges', async () => {
      const r = await parse(
        `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: npm test`,
        '.github/workflows/ci.yml',
      );

      expect(r.metadata?.yamlDialect).toBe('github-actions');
      expect(r.symbols.some(s => s.name === 'build' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'Run tests' && s.kind === 'constant')).toBe(true);
      expect(r.edges!.some(e => e.edgeType === 'imports' && (e.metadata as any).module === 'actions/checkout@v4')).toBe(true);
    });
  });

  // ── GitLab CI ──

  describe('gitlab-ci', () => {
    it('extracts stages and jobs as functions', async () => {
      const r = await parse(
        `stages:
  - build
  - test

build_job:
  stage: build
  script:
    - make build

test_job:
  stage: test
  script:
    - make test`,
        '.gitlab-ci.yml',
      );

      expect(r.metadata?.yamlDialect).toBe('gitlab-ci');
      expect(r.symbols.some(s => s.name === 'build' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'test' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'build_job' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'test_job' && s.kind === 'function')).toBe(true);
    });
  });

  // ── Kubernetes ──

  describe('kubernetes', () => {
    it('extracts kind as type and metadata.name as constant', async () => {
      const r = await parse(
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 3`,
      );

      expect(r.metadata?.yamlDialect).toBe('kubernetes');
      expect(r.symbols.some(s => s.name === 'Deployment' && s.kind === 'type')).toBe(true);
      expect(r.symbols.some(s => s.name === 'my-app' && s.kind === 'constant')).toBe(true);
    });
  });

  // ── OpenAPI ──

  describe('openapi', () => {
    it('extracts paths as functions and schemas as types', async () => {
      const r = await parse(
        `openapi: "3.0.0"
info:
  title: My API
paths:
  /users:
    get:
      summary: List users
    post:
      summary: Create user
components:
  schemas:
    User:
      type: object
    Error:
      type: object`,
      );

      expect(r.metadata?.yamlDialect).toBe('openapi');
      expect(r.symbols.some(s => s.name === 'GET /users' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'POST /users' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'User' && s.kind === 'type')).toBe(true);
      expect(r.symbols.some(s => s.name === 'Error' && s.kind === 'type')).toBe(true);
    });

    it('extracts operationId, tags and $ref edges', async () => {
      const r = await parse(
        `openapi: "3.0.0"
info:
  title: My API
paths:
  /users/{id}:
    get:
      operationId: getUserById
      summary: Fetch user
      tags: [users, public]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
components:
  schemas:
    User:
      type: object
      properties:
        profile:
          $ref: '#/components/schemas/Profile'
    Profile:
      type: object`,
      );

      // operationId is a separate, searchable symbol
      const opSym = r.symbols.find(s => s.name === 'getUserById');
      expect(opSym).toBeDefined();
      expect(opSym?.kind).toBe('function');
      expect(opSym?.metadata?.yamlKind).toBe('operationId');
      expect(opSym?.metadata?.path).toBe('/users/{id}');

      // endpoint label has tags + operationId in metadata
      const endpoint = r.symbols.find(s => s.name === 'GET /users/{id}');
      expect(endpoint?.metadata?.operationId).toBe('getUserById');
      expect(endpoint?.metadata?.tags).toEqual(['users', 'public']);

      // $ref → User in operation responses
      expect(r.edges?.some(e =>
        e.edgeType === 'imports' && (e.metadata as any)?.module === 'User' && (e.metadata as any)?.dialect === 'openapi'
      )).toBe(true);

      // schema-to-schema $ref: User → Profile
      expect(r.edges?.some(e =>
        e.edgeType === 'imports' && (e.metadata as any)?.module === 'Profile' && (e.metadata as any)?.from === 'User'
      )).toBe(true);
    });
  });

  // ── Ansible ──

  describe('ansible-playbook', () => {
    it('extracts plays and tasks', async () => {
      const r = await parse(
        `- hosts: webservers
  tasks:
    - name: Install nginx
      apt:
        name: nginx
    - name: Start nginx
      service:
        name: nginx
        state: started`,
      );

      expect(r.metadata?.yamlDialect).toBe('ansible-playbook');
      // tasks are indented, so kind=function
      expect(r.symbols.some(s => s.name === 'Install nginx' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'Start nginx' && s.kind === 'function')).toBe(true);
    });
  });

  // ── CircleCI ──

  describe('circleci', () => {
    it('extracts jobs as functions', async () => {
      const r = await parse(
        `version: 2.1
jobs:
  build:
    docker:
      - image: node:18
    steps:
      - checkout
  test:
    docker:
      - image: node:18
    steps:
      - run: npm test`,
        '.circleci/config.yml',
      );

      expect(r.metadata?.yamlDialect).toBe('circleci');
      expect(r.symbols.some(s => s.name === 'build' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'test' && s.kind === 'function')).toBe(true);
    });
  });

  // ── CloudFormation ──

  describe('cloudformation', () => {
    it('extracts resource logical IDs as classes', async () => {
      const r = await parse(
        `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
  MyFunction:
    Type: AWS::Lambda::Function`,
      );

      expect(r.metadata?.yamlDialect).toBe('cloudformation');
      expect(r.symbols.some(s => s.name === 'MyBucket' && s.kind === 'class')).toBe(true);
      expect(r.symbols.some(s => s.name === 'MyFunction' && s.kind === 'class')).toBe(true);
    });
  });

  // ── Helm Chart ──

  describe('helm-chart', () => {
    it('extracts chart name, version, and dependencies', async () => {
      const r = await parse(
        `name: my-chart
version: 1.2.3
description: A Helm chart
dependencies:
  - name: redis
    version: 17.0.0
    repository: https://charts.bitnami.com/bitnami`,
        'Chart.yaml',
      );

      expect(r.metadata?.yamlDialect).toBe('helm-chart');
      expect(r.symbols.some(s => s.name === 'my-chart' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === '1.2.3' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'redis' && s.kind === 'constant')).toBe(true);
      expect(r.edges!.some(e => e.edgeType === 'imports' && (e.metadata as any).module === 'redis')).toBe(true);
    });
  });

  // ── IaC Enhancements ──

  describe('docker-compose IaC', () => {
    it('extracts volumes from services', async () => {
      const r = await parse(
        `services:
  web:
    image: nginx
    volumes:
      - ./html:/usr/share/nginx/html
      - data:/var/lib/data`,
        'docker-compose.yml',
      );

      expect(r.symbols.some(s => s.metadata?.yamlKind === 'volume')).toBe(true);
      expect(r.symbols.some(s => (s.metadata as any)?.value?.includes('/usr/share/nginx/html'))).toBe(true);
    });

    it('extracts networks from services', async () => {
      const r = await parse(
        `services:
  web:
    image: nginx
    networks:
      - frontend
      - backend`,
        'docker-compose.yml',
      );

      expect(r.symbols.some(s => s.metadata?.yamlKind === 'network' && (s.metadata as any).value === 'frontend')).toBe(true);
      expect(r.symbols.some(s => s.metadata?.yamlKind === 'network' && (s.metadata as any).value === 'backend')).toBe(true);
    });

    it('extracts environment variables from services', async () => {
      const r = await parse(
        `services:
  db:
    image: postgres:15
    environment:
      - POSTGRES_USER=admin
      - POSTGRES_PASSWORD=secret`,
        'docker-compose.yml',
      );

      expect(r.symbols.some(s => s.metadata?.yamlKind === 'envVar' && (s.metadata as any).key === 'POSTGRES_USER')).toBe(true);
      expect(r.symbols.some(s => s.metadata?.yamlKind === 'envVar' && (s.metadata as any).key === 'POSTGRES_PASSWORD')).toBe(true);
    });

    it('extracts top-level volume and network definitions', async () => {
      const r = await parse(
        `services:
  web:
    image: nginx

volumes:
  data:
    driver: local
  cache:

networks:
  frontend:
  backend:
    driver: bridge`,
        'docker-compose.yml',
      );

      expect(r.symbols.some(s => s.name === 'data' && s.metadata?.yamlKind === 'volumeDef')).toBe(true);
      expect(r.symbols.some(s => s.name === 'cache' && s.metadata?.yamlKind === 'volumeDef')).toBe(true);
      expect(r.symbols.some(s => s.name === 'frontend' && s.metadata?.yamlKind === 'networkDef')).toBe(true);
      expect(r.symbols.some(s => s.name === 'backend' && s.metadata?.yamlKind === 'networkDef')).toBe(true);
    });
  });

  describe('kubernetes IaC', () => {
    it('extracts volume mounts', async () => {
      const r = await parse(
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: myapp:latest
          volumeMounts:
            - mountPath: /config
              name: config-vol`,
      );

      expect(r.symbols.some(s => s.name === 'mount:/config' && s.metadata?.yamlKind === 'volumeMount')).toBe(true);
    });

    it('extracts configMapRef and creates edges', async () => {
      const r = await parse(
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
      );

      expect(r.symbols.some(s => s.name === 'configMap:app-config')).toBe(true);
      expect(r.edges!.some(e => e.edgeType === 'depends_on' && (e.metadata as any).refKind === 'configMap')).toBe(true);
    });

    it('extracts secretRef and creates edges', async () => {
      const r = await parse(
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
            - secretRef:
                name: db-credentials`,
      );

      expect(r.symbols.some(s => s.name === 'secret:db-credentials')).toBe(true);
      expect(r.edges!.some(e => e.edgeType === 'depends_on' && (e.metadata as any).refKind === 'secret')).toBe(true);
    });

    it('extracts service selector', async () => {
      const r = await parse(
        `apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    app: my-app
  ports:
    - port: 80`,
      );

      expect(r.symbols.some(s => s.name === 'selector:my-app' && s.metadata?.yamlKind === 'serviceSelector')).toBe(true);
    });
  });
});
