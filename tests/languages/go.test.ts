import { describe, it, expect, beforeAll } from 'vitest';
import { GoLanguagePlugin } from '../../src/indexer/plugins/language/go/index.js';

const plugin = new GoLanguagePlugin();

async function extract(code: string, filePath = 'pkg/service/user.go') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(code));
  if (!result.isOk()) {
    // Surface the actual error so full-suite failures are diagnosable
    throw new Error(`Go extractSymbols failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

describe('GoLanguagePlugin', () => {
  // Eagerly initialise the parser to catch native-module loading issues
  // that can surface when other tree-sitter plugins run first in the suite.
  beforeAll(async () => {
    const probe = await plugin.extractSymbols('probe.go', Buffer.from('package probe\n'));
    expect(
      probe.isOk(),
      `Go parser init failed: ${JSON.stringify(probe.isErr() ? probe._unsafeUnwrapErr() : '')}`,
    ).toBe(true);
  });
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('go-language');
    expect(plugin.supportedExtensions).toContain('.go');
  });

  it('extracts package and function', async () => {
    const result = await extract(`
package main

func main() {
  fmt.Println("hello")
}
    `);
    const fn = result.symbols.find((s) => s.name === 'main' && s.kind === 'function');
    expect(fn).toBeDefined();
    expect(fn!.fqn).toBe('main.main');
  });

  it('extracts struct type', async () => {
    const result = await extract(
      `
package models

type User struct {
  ID   int    ` +
        '`json:"id"`' +
        `
  Name string ` +
        '`json:"name"`' +
        `
}
    `,
    );
    const st = result.symbols.find((s) => s.name === 'User' && s.kind === 'class');
    expect(st).toBeDefined();
    expect(st!.fqn).toBe('models.User');
    expect(st!.metadata?.exported).toBe(1);
  });

  it('extracts methods with receivers', async () => {
    const result = await extract(`
package models

type User struct {
  Name string
}

func (u *User) FullName() string {
  return u.Name
}

func (u User) String() string {
  return u.Name
}
    `);
    const methods = result.symbols.filter((s) => s.kind === 'method');
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const fn = methods.find((m) => m.name === 'FullName');
    expect(fn).toBeDefined();
    expect(fn!.fqn).toBe('models.User.FullName');
  });

  it('extracts interface', async () => {
    const result = await extract(`
package service

type UserRepository interface {
  FindByID(id int) (*User, error)
  Save(user *User) error
}
    `);
    const iface = result.symbols.find((s) => s.name === 'UserRepository' && s.kind === 'interface');
    expect(iface).toBeDefined();
    expect(iface!.fqn).toBe('service.UserRepository');
  });

  it('extracts constants', async () => {
    const result = await extract(`
package config

const MaxRetries = 3
const DefaultTimeout = 30
    `);
    const c = result.symbols.find((s) => s.name === 'MaxRetries');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('constant');
  });

  it('extracts import edges', async () => {
    const result = await extract(`
package main

import (
  "fmt"
  "net/http"
  mylog "github.com/sirupsen/logrus"
)
    `);
    expect(result.edges).toBeDefined();
    const imports = result.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const modules = imports.map((e) => (e.metadata as any).module);
    expect(modules).toContain('fmt');
  });

  it('extracts variables', async () => {
    const result = await extract(`
package app

var GlobalConfig Config
    `);
    const v = result.symbols.find((s) => s.name === 'GlobalConfig');
    expect(v).toBeDefined();
    expect(v!.kind).toBe('variable');
  });
});
