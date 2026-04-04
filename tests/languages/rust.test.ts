import { describe, it, expect, beforeAll } from 'vitest';
import { RustLanguagePlugin } from '../../src/indexer/plugins/language/rust/index.js';

const plugin = new RustLanguagePlugin();

function extract(code: string, filePath = 'src/lib.rs') {
  const result = plugin.extractSymbols(filePath, Buffer.from(code));
  if (!result.isOk()) {
    throw new Error(`Rust extractSymbols failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

describe('RustLanguagePlugin', () => {
  beforeAll(() => {
    const probe = plugin.extractSymbols('probe.rs', Buffer.from('fn probe() {}\n'));
    expect(probe.isOk(), `Rust parser init failed: ${JSON.stringify(probe.isErr() ? probe._unsafeUnwrapErr() : '')}`).toBe(true);
  });

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('rust-language');
    expect(plugin.supportedExtensions).toContain('.rs');
  });

  it('extracts functions', () => {
    const result = extract(`
pub fn hello(name: &str) -> String {
    format!("Hello, {}", name)
}

fn private_fn() {}
    `);
    const hello = result.symbols.find((s) => s.name === 'hello' && s.kind === 'function');
    expect(hello).toBeDefined();
    expect(hello!.metadata?.exported).toBe(1);

    const priv = result.symbols.find((s) => s.name === 'private_fn');
    expect(priv).toBeDefined();
    expect(priv!.metadata?.exported).toBeUndefined();
  });

  it('extracts structs with fields', () => {
    const result = extract(`
pub struct Config {
    pub name: String,
    pub port: u16,
    secret: String,
}
    `);
    const st = result.symbols.find((s) => s.name === 'Config' && s.kind === 'class');
    expect(st).toBeDefined();
    expect(st!.metadata?.rustKind).toBe('struct');
    expect(st!.metadata?.exported).toBe(1);

    const fields = result.symbols.filter((s) => s.kind === 'property');
    expect(fields.length).toBe(3);
    const nameField = fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.metadata?.exported).toBe(1);
  });

  it('extracts enums with variants', () => {
    const result = extract(`
pub enum Status {
    Active,
    Inactive,
    Error(String),
}
    `);
    const e = result.symbols.find((s) => s.name === 'Status' && s.kind === 'enum');
    expect(e).toBeDefined();

    const variants = result.symbols.filter((s) => s.kind === 'enum_case');
    expect(variants.length).toBe(3);
    expect(variants.map((v) => v.name)).toContain('Active');
    expect(variants.map((v) => v.name)).toContain('Error');
  });

  it('extracts traits with methods', () => {
    const result = extract(`
pub trait Service {
    fn start(&self) -> Result<(), Box<dyn std::error::Error>>;
    fn stop(&self);
    fn name(&self) -> &str {
        "default"
    }
}
    `);
    const t = result.symbols.find((s) => s.name === 'Service' && s.kind === 'trait');
    expect(t).toBeDefined();

    const methods = result.symbols.filter((s) => s.kind === 'method');
    expect(methods.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts impl methods', () => {
    const result = extract(`
struct Config {
    name: String,
}

impl Config {
    pub fn new(name: String) -> Self {
        Config { name }
    }

    fn validate(&self) -> bool {
        !self.name.is_empty()
    }
}
    `);
    const methods = result.symbols.filter((s) => s.kind === 'method');
    expect(methods.length).toBe(2);
    const newFn = methods.find((m) => m.name === 'new');
    expect(newFn).toBeDefined();
    expect(newFn!.parentSymbolId).toContain('Config');
    expect(newFn!.metadata?.exported).toBe(1);
  });

  it('extracts trait impl methods', () => {
    const result = extract(`
struct MyService;

trait Service {
    fn run(&self);
}

impl Service for MyService {
    fn run(&self) {
        println!("running");
    }
}
    `);
    const method = result.symbols.find((s) => s.name === 'run' && s.kind === 'method' && s.metadata?.implTrait);
    expect(method).toBeDefined();
    expect(method!.metadata?.implTrait).toBe('Service');
  });

  it('extracts import edges', () => {
    const result = extract(`
use std::collections::HashMap;
use serde::{Serialize, Deserialize};
extern crate log;
    `);
    expect(result.edges).toBeDefined();
    const imports = result.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts const and static', () => {
    const result = extract(`
pub const MAX_RETRIES: u32 = 3;
static mut COUNTER: u32 = 0;
    `);
    const c = result.symbols.find((s) => s.name === 'MAX_RETRIES');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('constant');

    const s = result.symbols.find((s) => s.name === 'COUNTER');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('variable');
  });

  it('extracts modules', () => {
    const result = extract(`
pub mod utils;
mod internal {}
    `);
    const mods = result.symbols.filter((s) => s.kind === 'namespace');
    expect(mods.length).toBe(2);
  });

  it('extracts macro_rules', () => {
    const result = extract(`
macro_rules! log {
    ($msg:expr) => { println!("{}", $msg) };
}
    `);
    const m = result.symbols.find((s) => s.name === 'log');
    expect(m).toBeDefined();
    expect(m!.metadata?.rustKind).toBe('macro');
  });

  it('extracts type aliases', () => {
    const result = extract(`
pub type Result<T> = std::result::Result<T, Error>;
    `);
    const t = result.symbols.find((s) => s.name === 'Result' && s.kind === 'type');
    expect(t).toBeDefined();
  });

  it('handles syntax errors gracefully', () => {
    const result = extract(`
pub fn broken( {
    // missing closing paren and body
}
    `);
    expect(result.status).toBe('partial');
  });
});
