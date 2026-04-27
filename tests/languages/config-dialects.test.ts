/**
 * Tests for dialect-aware config language plugins: YAML, JSON, TOML, HCL.
 */
import { describe, it, expect } from 'vitest';
import { YamlLanguagePlugin } from '../../src/indexer/plugins/language/yaml-lang/index.js';
import { JsonLanguagePlugin } from '../../src/indexer/plugins/language/json-lang/index.js';
import { TomlLanguagePlugin } from '../../src/indexer/plugins/language/toml/index.js';
import { HclLanguagePlugin } from '../../src/indexer/plugins/language/hcl/index.js';

const yamlPlugin = new YamlLanguagePlugin();
const jsonPlugin = new JsonLanguagePlugin();
const tomlPlugin = new TomlLanguagePlugin();
const hclPlugin = new HclLanguagePlugin();

function parseYaml(source: string, filePath = 'config.yaml') {
  const r = yamlPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(r.isOk()).toBe(true);
  return r._unsafeUnwrap();
}
async function parseJson(source: string, filePath = 'config.json') {
  const r = await jsonPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(r.isOk()).toBe(true);
  return r._unsafeUnwrap();
}
async function parseToml(source: string, filePath = 'config.toml') {
  const r = await tomlPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(r.isOk()).toBe(true);
  return r._unsafeUnwrap();
}
function parseHcl(source: string, filePath = 'main.tf') {
  const r = hclPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(r.isOk()).toBe(true);
  return r._unsafeUnwrap();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// YAML
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('YAML — Docker Compose', () => {
  it('detects dialect and extracts services', () => {
    const r = parseYaml(
      `services:
  web:
    image: nginx:latest
  db:
    image: postgres:15
`,
      'docker-compose.yml',
    );
    expect(r.metadata?.yamlDialect).toBe('docker-compose');
    expect(r.symbols.some((s) => s.name === 'web' && s.kind === 'class')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'db' && s.kind === 'class')).toBe(true);
  });
});

describe('YAML — GitHub Actions', () => {
  it('detects dialect and extracts jobs', () => {
    const r = parseYaml(
      `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Install deps
        run: npm install
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run tests
        run: npm test
`,
      '.github/workflows/ci.yml',
    );
    expect(r.metadata?.yamlDialect).toBe('github-actions');
    expect(r.symbols.some((s) => s.name === 'build' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'test' && s.kind === 'function')).toBe(true);
  });
});

describe('YAML — Kubernetes', () => {
  it('detects dialect', () => {
    const r = parseYaml(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
`);
    expect(r.metadata?.yamlDialect).toBe('kubernetes');
    expect(r.symbols.some((s) => s.name === 'nginx-deployment')).toBe(true);
  });
});

describe('YAML — OpenAPI', () => {
  it('detects dialect from openapi key', () => {
    const r = parseYaml(`openapi: "3.0.0"
info:
  title: Pet Store
paths:
  /pets:
    get:
      summary: List pets
`);
    expect(r.metadata?.yamlDialect).toBe('openapi');
  });
});

describe('YAML — generic', () => {
  it('extracts top-level keys', () => {
    const r = parseYaml(`database:
  host: localhost
cache:
  enabled: true
`);
    expect(r.symbols.some((s) => s.name === 'database')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'cache')).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JSON
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('JSON — package.json', () => {
  it('detects dialect and extracts scripts + deps', async () => {
    const r = await parseJson(
      `{
  "name": "my-app",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "test": "vitest"
  },
  "dependencies": {
    "express": "^4.18.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}`,
      'package.json',
    );
    expect(r.metadata?.jsonDialect).toBe('package-json');
    // Package name extracted
    expect(r.symbols.some((s) => s.name === 'my-app')).toBe(true);
    // Scripts
    expect(r.symbols.some((s) => s.name === 'build' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'test' && s.kind === 'function')).toBe(true);
    // Dependency edges
    const depModules = (r.edges ?? []).map((e) => (e.metadata as any).module);
    expect(depModules).toContain('express');
    expect(depModules).toContain('typescript');
  });
});

describe('JSON — tsconfig.json', () => {
  it('detects dialect and extracts extends', async () => {
    const r = await parseJson(
      `{
  "extends": "@tsconfig/node20/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "strict": true
  }
}`,
      'tsconfig.json',
    );
    expect(r.metadata?.jsonDialect).toBe('tsconfig');
    // extends creates import edge
    expect(
      r.edges?.some((e) => (e.metadata as any).module === '@tsconfig/node20/tsconfig.json'),
    ).toBe(true);
  });
});

describe('JSON — composer.json', () => {
  it('detects dialect and extracts deps', async () => {
    const r = await parseJson(
      `{
  "name": "vendor/package",
  "require": {
    "laravel/framework": "^11.0"
  },
  "require-dev": {
    "phpunit/phpunit": "^10.0"
  }
}`,
      'composer.json',
    );
    expect(r.metadata?.jsonDialect).toBe('composer');
    const depModules = (r.edges ?? []).map((e) => (e.metadata as any).module);
    expect(depModules).toContain('laravel/framework');
    expect(depModules).toContain('phpunit/phpunit');
  });
});

describe('JSON — turbo.json', () => {
  it('extracts pipeline key', async () => {
    const r = await parseJson(
      `{
  "pipeline": {
    "build": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["build"] }
  }
}`,
      'turbo.json',
    );
    // turbo.json: pipeline is a top-level key
    expect(r.symbols.some((s) => s.name === 'pipeline')).toBe(true);
  });
});

describe('JSON — generic', () => {
  it('extracts top-level keys', async () => {
    const r = await parseJson(`{
  "database": { "host": "localhost" },
  "cache": { "ttl": 3600 }
}`);
    expect(r.symbols.some((s) => s.name === 'database')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'cache')).toBe(true);
  });

  it('handles empty JSON', async () => {
    const r = await parseJson('{}');
    expect(r.symbols).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOML
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TOML — Cargo.toml', () => {
  it('detects dialect and extracts package + deps', async () => {
    const r = await parseToml(
      `[package]
name = "my-crate"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = { version = "1" }

[dev-dependencies]
criterion = "0.5"

[features]
async = ["tokio"]

[[bin]]
name = "cli"
`,
      'Cargo.toml',
    );
    expect(r.metadata?.dialect).toBe('cargo');
    // Package fields
    expect(r.symbols.some((s) => s.name === 'name' && s.metadata?.value === 'my-crate')).toBe(true);
    // Deps as edges
    const depModules = (r.edges ?? []).map((e) => (e.metadata as any).module);
    expect(depModules).toContain('serde');
    expect(depModules).toContain('tokio');
    expect(depModules).toContain('criterion');
    // Features
    expect(r.symbols.some((s) => s.name === 'async' && s.metadata?.tomlKind === 'feature')).toBe(
      true,
    );
    // Binary
    expect(r.symbols.some((s) => s.name === 'cli' && s.metadata?.tomlKind === 'binary')).toBe(true);
  });
});

describe('TOML — pyproject.toml', () => {
  it('detects dialect and extracts project + build deps', async () => {
    const r = await parseToml(
      `[project]
name = "my-package"
version = "0.1.0"

[build-system]
requires = ["setuptools", "wheel"]

[tool.poetry.dependencies]
requests = "^2.28"
`,
      'pyproject.toml',
    );
    expect(r.metadata?.dialect).toBe('pyproject');
    expect(r.symbols.some((s) => s.name === 'name' && s.metadata?.value === 'my-package')).toBe(
      true,
    );
    const depModules = (r.edges ?? []).map((e) => (e.metadata as any).module);
    expect(depModules).toContain('setuptools');
    expect(depModules).toContain('requests');
  });
});

describe('TOML — generic', () => {
  it('extracts tables and keys', async () => {
    // Use a non-config.toml filename to avoid hugo dialect detection
    const r = await parseToml(
      `[database]
host = "localhost"
port = 5432

[[servers]]
name = "alpha"
`,
      'settings.toml',
    );
    expect(r.symbols.some((s) => s.name === 'database' && s.kind === 'namespace')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'host')).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HCL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('HCL — resources', () => {
  it('extracts resource with type metadata', () => {
    const r = parseHcl(`resource "aws_instance" "web" {
  ami           = "ami-abc123"
  instance_type = "t3.micro"
}

resource "aws_s3_bucket" "logs" {
  bucket = "my-logs"
}`);
    expect(
      r.symbols.some(
        (s) =>
          s.name === 'web' && s.kind === 'class' && s.metadata?.resourceType === 'aws_instance',
      ),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s) =>
          s.name === 'logs' && s.kind === 'class' && s.metadata?.resourceType === 'aws_s3_bucket',
      ),
    ).toBe(true);
  });

  it('extracts data sources', () => {
    const r = parseHcl(`data "aws_ami" "ubuntu" {
  most_recent = true
}`);
    expect(r.symbols.some((s) => s.name === 'ubuntu' && s.metadata?.hclKind === 'data')).toBe(true);
  });
});

describe('HCL — variables and outputs', () => {
  it('extracts variables and outputs', () => {
    const r = parseHcl(`variable "region" {
  type    = string
  default = "us-east-1"
}

output "instance_ip" {
  value = aws_instance.web.public_ip
}`);
    expect(r.symbols.some((s) => s.name === 'region' && s.kind === 'variable')).toBe(true);
    expect(
      r.symbols.some((s) => s.name === 'instance_ip' && s.metadata?.hclKind === 'output'),
    ).toBe(true);
  });
});

describe('HCL — locals', () => {
  it('extracts only keys inside locals block', () => {
    const r = parseHcl(`locals {
  env    = "production"
  prefix = "myapp"
}

resource "aws_instance" "web" {
  ami = "ami-abc"
  tags = {
    Name = "not-a-local"
  }
}`);
    expect(r.symbols.some((s) => s.name === 'env' && s.metadata?.hclKind === 'local')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'prefix' && s.metadata?.hclKind === 'local')).toBe(
      true,
    );
    // "Name" inside resource tags should NOT be local
    expect(r.symbols.some((s) => s.name === 'Name' && s.metadata?.hclKind === 'local')).toBe(false);
  });
});

describe('HCL — modules with source', () => {
  it('extracts module and source as import edge', () => {
    const r = parseHcl(`module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}`);
    expect(r.symbols.some((s) => s.name === 'vpc' && s.kind === 'namespace')).toBe(true);
    expect(
      r.edges?.some((e) => (e.metadata as any).module === 'terraform-aws-modules/vpc/aws'),
    ).toBe(true);
  });
});

describe('HCL — providers', () => {
  it('extracts provider', () => {
    const r = parseHcl(`provider "aws" {
  region = "us-east-1"
}`);
    expect(r.symbols.some((s) => s.name === 'aws' && s.metadata?.hclKind === 'provider')).toBe(
      true,
    );
  });
});
