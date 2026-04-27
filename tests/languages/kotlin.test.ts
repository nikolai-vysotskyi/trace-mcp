import { describe, it, expect } from 'vitest';
import { KotlinLanguagePlugin } from '../../src/indexer/plugins/language/kotlin/index.js';

const plugin = new KotlinLanguagePlugin();

async function extract(code: string, filePath = 'com/example/App.kt') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(code));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('KotlinLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('kotlin-language');
    expect(plugin.supportedExtensions).toContain('.kt');
    expect(plugin.supportedExtensions).toContain('.kts');
  });

  it('extracts class with package', async () => {
    const result = await extract(`
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

  it('extracts data class', async () => {
    const result = await extract(`
package com.example

data class User(val name: String, val age: Int)
    `);
    const cls = result.symbols.find((s) => s.name === 'User');
    expect(cls).toBeDefined();
    expect(cls!.metadata?.data).toBe(true);
  });

  it('extracts interface', async () => {
    const result = await extract(`
package com.example

interface Repository {
  fun findAll(): List<Entity>
}
    `);
    const iface = result.symbols.find((s) => s.name === 'Repository');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
  });

  it('extracts functions', async () => {
    const result = await extract(`package com.example

fun greet(name: String): String {
  return "Hello"
}
`);
    const fn = result.symbols.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(['function', 'method']).toContain(fn!.kind);
    expect(fn!.signature).toContain('greet');
  });

  it('extracts import edges', async () => {
    const result = await extract(`
package com.example

import java.util.List
import kotlinx.coroutines.launch as launchCoroutine
    `);
    expect(result.edges).toBeDefined();
    expect(result.edges!.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts inheritance', async () => {
    const result = await extract(`
package com.example

class Dog : Animal(), Serializable {
  override fun speak() {}
}
    `);
    const cls = result.symbols.find((s) => s.name === 'Dog');
    expect(cls).toBeDefined();
    expect(cls!.metadata?.extends).toBe('Animal');
  });

  // ── Regression: heritage with multiple interfaces ─────────────────────────
  // Bug a649977 — greedy regex was cutting off class name at first dot

  it('captures all implemented interfaces (multiple inheritance)', async () => {
    const result = await extract(`
package com.example

class Repository : BaseRepo(), Serializable, Closeable {
  override fun close() {}
}
    `);
    const cls = result.symbols.find((s) => s.name === 'Repository');
    expect(cls?.metadata?.extends).toBe('BaseRepo');
    const impls = cls?.metadata?.implements as string[] | string | undefined;
    const implList = Array.isArray(impls) ? impls : impls ? [impls] : [];
    expect(implList).toContain('Serializable');
    expect(implList).toContain('Closeable');
  });

  // ── Regression: import alias specifier ────────────────────────────────────
  // Bug 4d92110 — import alias was stored instead of original name

  it('stores original name in import specifiers, not alias', async () => {
    const result = await extract(`
package com.example

import kotlinx.coroutines.launch as launchCoroutine
import java.util.ArrayList as MutableList
    `);
    const edges = result.edges ?? [];
    const specifiers = edges.flatMap((e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      return Array.isArray(meta?.specifiers) ? (meta.specifiers as string[]) : [];
    });
    // Should contain "launch" and "ArrayList", NOT "launchCoroutine" or "MutableList"
    expect(specifiers).toContain('launch');
    expect(specifiers).toContain('ArrayList');
    expect(specifiers).not.toContain('launchCoroutine');
    expect(specifiers).not.toContain('MutableList');
  });

  // ── Corner cases ─────────────────────────────────────────────────────────

  it('extracts sealed class with sealed modifier in metadata', async () => {
    const result = await extract(`
package com.example

sealed class Result {
  data class Success(val value: String) : Result()
  data class Failure(val error: Throwable) : Result()
}
    `);
    const sealed = result.symbols.find((s) => s.name === 'Result');
    expect(sealed?.metadata?.sealed).toBe(true);
    // Nested data classes should also be extracted
    expect(result.symbols.some((s) => s.name === 'Success')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'Failure')).toBe(true);
  });

  it('extracts enum class with enum entries', async () => {
    const result = await extract(`
package com.example

enum class Status { ACTIVE, INACTIVE, PENDING }
    `);
    const enumCls = result.symbols.find((s) => s.name === 'Status');
    expect(enumCls?.kind).toBe('enum');
    expect(result.symbols.some((s) => s.name === 'ACTIVE')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'INACTIVE')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'PENDING')).toBe(true);
  });

  it('extracts object declaration (singleton) with object=true metadata', async () => {
    const result = await extract(`
package com.example

object DatabasePool {
  fun getConnection() {}
}
    `);
    const obj = result.symbols.find((s) => s.name === 'DatabasePool');
    expect(obj).toBeDefined();
    expect(obj?.metadata?.object).toBe(true);
  });

  it('extracts suspend function with suspend=true metadata', async () => {
    const result = await extract(`
package com.example

suspend fun fetchUser(id: Long): User {
  return User()
}
    `);
    const fn = result.symbols.find((s) => s.name === 'fetchUser');
    expect(fn?.metadata?.suspend).toBe(true);
  });

  it('extracts typealias', async () => {
    const result = await extract(`
package com.example

typealias EventHandler = (String, Int) -> Unit
    `);
    expect(result.symbols.some((s) => s.name === 'EventHandler' && s.kind === 'type')).toBe(true);
  });

  it('extracts const val top-level property', async () => {
    const result = await extract(`
package com.example

const val MAX_RETRIES = 3
val DEFAULT_TIMEOUT = 5000L
    `);
    expect(result.symbols.some((s) => s.name === 'MAX_RETRIES')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'DEFAULT_TIMEOUT')).toBe(true);
  });

  it('extracts inline/value class', async () => {
    const result = await extract(`
package com.example

@JvmInline
value class UserId(val value: Long)
    `);
    const cls = result.symbols.find((s) => s.name === 'UserId');
    expect(cls).toBeDefined();
    expect(['class', 'interface']).toContain(cls?.kind);
  });

  it('symbolIds are unique even with nested classes', async () => {
    const result = await extract(`
package com.example

class Outer {
  class Inner
  object Companion
}
class Inner  // top-level Inner should not collide
    `);
    const ids = result.symbols.map((s) => s.symbolId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
