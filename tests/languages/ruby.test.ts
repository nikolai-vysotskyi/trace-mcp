import { describe, expect, it } from 'vitest';
import { RubyLanguagePlugin } from '../../src/indexer/plugins/language/ruby/index.js';

const plugin = new RubyLanguagePlugin();

async function extract(code: string, filePath = 'app/models/user.rb') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(code));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('RubyLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('ruby-language');
    expect(plugin.supportedExtensions).toContain('.rb');
    expect(plugin.supportedExtensions).toContain('.rake');
  });

  it('extracts class with inheritance', async () => {
    const result = await extract(`
class User < ApplicationRecord
  def full_name
    "#{first_name} #{last_name}"
  end
end
    `);
    const cls = result.symbols.find((s) => s.name === 'User');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.metadata?.extends).toBe('ApplicationRecord');

    const method = result.symbols.find((s) => s.name === 'full_name');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });

  it('extracts module', async () => {
    const result = await extract(`
module Concerns
  module Searchable
    def search(query)
    end
  end
end
    `);
    const mod = result.symbols.find((s) => s.name === 'Concerns');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('namespace');
  });

  it('extracts class methods (def self.xxx)', async () => {
    const result = await extract(`
class Config
  def self.load
  end
end
    `);
    const method = result.symbols.find((s) => s.name === 'self.load');
    expect(method).toBeDefined();
    expect(method!.metadata?.static).toBe(true);
  });

  it('extracts attr_accessor properties', async () => {
    const result = await extract(`
class Person
  attr_accessor :name, :age
  attr_reader :id
end
    `);
    const name = result.symbols.find((s) => s.name === 'name' && s.kind === 'property');
    expect(name).toBeDefined();
    const age = result.symbols.find((s) => s.name === 'age' && s.kind === 'property');
    expect(age).toBeDefined();
    const id = result.symbols.find((s) => s.name === 'id' && s.kind === 'property');
    expect(id).toBeDefined();
  });

  it('extracts require import edges', async () => {
    const result = await extract(`
require 'json'
require_relative './helpers'

class App; end
    `);
    expect(result.edges).toBeDefined();
    const imports = result.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const froms = imports.map((e) => (e.metadata as any).from);
    expect(froms).toContain('json');
    expect(froms).toContain('./helpers');
  });

  it('extracts constants', async () => {
    const result = await extract(`
class Config
  VERSION = "1.0.0"
  MAX_RETRIES = 3
end
    `);
    const ver = result.symbols.find((s) => s.name === 'VERSION');
    expect(ver).toBeDefined();
    expect(ver!.kind).toBe('constant');
  });

  it('extracts include/extend mixins', async () => {
    const result = await extract(`
class User
  include Comparable
  extend ClassMethods
end
    `);
    const cls = result.symbols.find((s) => s.name === 'User');
    expect(cls!.metadata?.includes).toContain('Comparable');
    expect(cls!.metadata?.extends_modules).toContain('ClassMethods');
  });
});
