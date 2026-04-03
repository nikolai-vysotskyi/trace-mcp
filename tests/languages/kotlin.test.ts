import { describe, it, expect } from 'vitest';
import { KotlinLanguagePlugin } from '../../src/indexer/plugins/language/kotlin.js';

const plugin = new KotlinLanguagePlugin();

function extract(code: string, filePath = 'com/example/App.kt') {
  const result = plugin.extractSymbols(filePath, Buffer.from(code));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('KotlinLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('kotlin-language');
    expect(plugin.supportedExtensions).toContain('.kt');
    expect(plugin.supportedExtensions).toContain('.kts');
  });

  it('extracts class with package', () => {
    const result = extract(`
package com.example

class UserService {
  fun doWork() {}
}
    `);
    const cls = result.symbols.find((s) => s.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.fqn).toBe('com.example.UserService');
  });

  it('extracts data class', () => {
    const result = extract(`
package com.example

data class User(val name: String, val age: Int)
    `);
    const cls = result.symbols.find((s) => s.name === 'User');
    expect(cls).toBeDefined();
    expect(cls!.metadata?.data).toBe(true);
  });

  it('extracts interface', () => {
    const result = extract(`
package com.example

interface Repository {
  fun findAll(): List<Entity>
}
    `);
    const iface = result.symbols.find((s) => s.name === 'Repository');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
  });

  it('extracts functions', () => {
    const result = extract(`
package com.example

fun greet(name: String): String {
  return "Hello, $name"
}
    `);
    const fn = result.symbols.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts import edges', () => {
    const result = extract(`
package com.example

import java.util.List
import kotlinx.coroutines.launch as launchCoroutine
    `);
    expect(result.edges).toBeDefined();
    expect(result.edges!.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts inheritance', () => {
    const result = extract(`
package com.example

class Dog : Animal(), Serializable {
  override fun speak() {}
}
    `);
    const cls = result.symbols.find((s) => s.name === 'Dog');
    expect(cls).toBeDefined();
    expect(cls!.metadata?.extends).toBe('Animal');
  });
});
