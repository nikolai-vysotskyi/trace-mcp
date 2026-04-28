import { describe, expect, it } from 'vitest';
import { HclLanguagePlugin } from '../../src/indexer/plugins/language/hcl/index.js';

const plugin = new HclLanguagePlugin();

function parse(source: string, filePath = 'main.tf') {
  const result = plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('HclLanguagePlugin', () => {
  // ── Manifest ──

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('hcl-language');
    expect(plugin.supportedExtensions).toContain('.tf');
    expect(plugin.supportedExtensions).toContain('.hcl');
    expect(plugin.supportedExtensions).toContain('.tfvars');
  });

  // ── Resource blocks ──

  describe('resource', () => {
    it('extracts resource name as class with resourceType metadata', () => {
      const r = parse(`resource "aws_s3_bucket" "my_bucket" {
  bucket = "my-bucket-name"
}`);
      expect(
        r.symbols.some(
          (s) =>
            s.name === 'my_bucket' &&
            s.kind === 'class' &&
            s.metadata?.hclKind === 'resource' &&
            s.metadata?.resourceType === 'aws_s3_bucket',
        ),
      ).toBe(true);
    });
  });

  // ── Data blocks ──

  describe('data', () => {
    it('extracts data source as class', () => {
      const r = parse(`data "aws_ami" "latest_ubuntu" {
  most_recent = true
}`);
      expect(
        r.symbols.some(
          (s) =>
            s.name === 'latest_ubuntu' &&
            s.kind === 'class' &&
            s.metadata?.hclKind === 'data' &&
            s.metadata?.resourceType === 'aws_ami',
        ),
      ).toBe(true);
    });
  });

  // ── Module blocks ──

  describe('module', () => {
    it('extracts module name as namespace', () => {
      const r = parse(`module "vpc" {
  source = "./modules/vpc"
  cidr   = "10.0.0.0/16"
}`);
      expect(
        r.symbols.some(
          (s) => s.name === 'vpc' && s.kind === 'namespace' && s.metadata?.hclKind === 'module',
        ),
      ).toBe(true);
    });

    it('extracts module source as import edge', () => {
      const r = parse(`module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}`);
      expect(
        r.edges!.some(
          (e) =>
            e.edgeType === 'imports' &&
            (e.metadata as any).module === 'terraform-aws-modules/vpc/aws',
        ),
      ).toBe(true);
    });
  });

  // ── Variable blocks ──

  describe('variable', () => {
    it('extracts variable name with type, default, and description metadata', () => {
      const r = parse(`variable "instance_type" {
  type        = string
  default     = "t3.micro"
  description = "EC2 instance type"
}`);
      const sym = r.symbols.find(
        (s) => s.name === 'instance_type' && s.metadata?.hclKind === 'variable',
      );
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('variable');
      expect(sym!.metadata?.type).toBe('string');
      expect(sym!.metadata?.default).toBe('"t3.micro"');
      expect(sym!.metadata?.description).toBe('EC2 instance type');
    });
  });

  // ── Output blocks ──

  describe('output', () => {
    it('extracts output name as variable', () => {
      const r = parse(`output "vpc_id" {
  value = module.vpc.id
}`);
      expect(
        r.symbols.some(
          (s) => s.name === 'vpc_id' && s.kind === 'variable' && s.metadata?.hclKind === 'output',
        ),
      ).toBe(true);
    });
  });

  // ── Locals blocks ──

  describe('locals', () => {
    it('extracts keys inside locals block as variables', () => {
      const r = parse(`locals {
  region = "us-east-1"
  env    = "prod"
}`);
      expect(
        r.symbols.some(
          (s) => s.name === 'region' && s.kind === 'variable' && s.metadata?.hclKind === 'local',
        ),
      ).toBe(true);
      expect(
        r.symbols.some(
          (s) => s.name === 'env' && s.kind === 'variable' && s.metadata?.hclKind === 'local',
        ),
      ).toBe(true);
    });

    it('does NOT extract keys outside locals block', () => {
      const r = parse(`locals {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami = "ami-12345"
}`);
      // 'region' is a local, 'ami' should NOT be extracted as local
      expect(r.symbols.some((s) => s.name === 'region' && s.metadata?.hclKind === 'local')).toBe(
        true,
      );
      expect(r.symbols.some((s) => s.name === 'ami')).toBe(false);
    });
  });

  // ── Terraform required_providers ──

  describe('terraform required_providers', () => {
    it('extracts provider names as constants', () => {
      const r = parse(`terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}`);
      expect(
        r.symbols.some(
          (s) =>
            s.name === 'aws' &&
            s.kind === 'constant' &&
            s.metadata?.hclKind === 'required_provider',
        ),
      ).toBe(true);
      expect(
        r.symbols.some(
          (s) =>
            s.name === 'random' &&
            s.kind === 'constant' &&
            s.metadata?.hclKind === 'required_provider',
        ),
      ).toBe(true);
    });
  });

  // ── Combined file ──

  describe('combined', () => {
    it('handles a file with multiple block types', () => {
      const r = parse(`variable "name" {
  type = string
}

resource "aws_instance" "web" {
  instance_type = var.name
}

output "instance_id" {
  value = aws_instance.web.id
}

locals {
  tags = { Name = "web" }
}`);
      expect(r.symbols.some((s) => s.name === 'name' && s.metadata?.hclKind === 'variable')).toBe(
        true,
      );
      expect(r.symbols.some((s) => s.name === 'web' && s.metadata?.hclKind === 'resource')).toBe(
        true,
      );
      expect(
        r.symbols.some((s) => s.name === 'instance_id' && s.metadata?.hclKind === 'output'),
      ).toBe(true);
      expect(r.symbols.some((s) => s.name === 'tags' && s.metadata?.hclKind === 'local')).toBe(
        true,
      );
    });
  });
});
