import { describe, it, expect } from 'vitest';
import { GoLanguagePlugin } from '../../src/indexer/plugins/language/go.js';

const plugin = new GoLanguagePlugin();

function extract(code: string, filePath = 'pkg/service/user.go') {
  const result = plugin.extractSymbols(filePath, Buffer.from(code));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('GoLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('go-language');
    expect(plugin.supportedExtensions).toContain('.go');
  });

  it('extracts package and function', () => {
    const result = extract(`
package main

func main() {
  fmt.Println("hello")
}
    `);
    const fn = result.symbols.find((s) => s.name === 'main' && s.kind === 'function');
    expect(fn).toBeDefined();
    expect(fn!.fqn).toBe('main.main');
  });

  it('extracts struct type', () => {
    const result = extract(`
package models

type User struct {
  ID   int    ` + '`json:"id"`' + `
  Name string ` + '`json:"name"`' + `
}
    `);
    const st = result.symbols.find((s) => s.name === 'User' && s.kind === 'class');
    expect(st).toBeDefined();
    expect(st!.fqn).toBe('models.User');
    expect(st!.metadata?.exported).toBe(1);
  });

  it('extracts methods with receivers', () => {
    const result = extract(`
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

  it('extracts interface', () => {
    const result = extract(`
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

  it('extracts constants', () => {
    const result = extract(`
package config

const MaxRetries = 3
const DefaultTimeout = 30
    `);
    const c = result.symbols.find((s) => s.name === 'MaxRetries');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('constant');
  });

  it('extracts import edges', () => {
    const result = extract(`
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

  it('extracts variables', () => {
    const result = extract(`
package app

var GlobalConfig Config
    `);
    const v = result.symbols.find((s) => s.name === 'GlobalConfig');
    expect(v).toBeDefined();
    expect(v!.kind).toBe('variable');
  });
});
