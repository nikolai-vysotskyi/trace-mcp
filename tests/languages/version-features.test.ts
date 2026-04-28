/**
 * Tests for version-features detection across all languages.
 */
import { describe, expect, it } from 'vitest';
import { detectCssVersions } from '../../src/indexer/plugins/language/css/version-features.js';
import { detectMinGoVersionFromSource } from '../../src/indexer/plugins/language/go/version-features.js';
import { detectMinJavaVersionFromSource } from '../../src/indexer/plugins/language/java/version-features.js';
import { detectMinKotlinVersion } from '../../src/indexer/plugins/language/kotlin/version-features.js';
import { detectMinPhpVersion } from '../../src/indexer/plugins/language/php/version-features.js';
import { detectMinPythonVersion } from '../../src/indexer/plugins/language/python/version-features.js';
import { detectMinRubyVersionFromSource } from '../../src/indexer/plugins/language/ruby/version-features.js';
import {
  detectMinEsVersion,
  detectMinNodeVersion,
  detectMinNodeVersionFromAPIs,
  detectMinTsVersion,
  detectMinTsVersionFromSource,
} from '../../src/indexer/plugins/language/typescript/version-features.js';

// ==============================
// Node.js
// ==============================

describe('Node.js version detection', () => {
  it('detects optional chaining → Node 14', () => {
    expect(detectMinNodeVersion(['optional_chaining'])).toBe('14');
  });

  it('detects class static block → Node 16', () => {
    expect(detectMinNodeVersion(['class_static_block'])).toBe('16');
  });

  it('detects using declaration → Node 22', () => {
    expect(detectMinNodeVersion(['using_declaration'])).toBe('22');
  });

  it('picks highest version when multiple features present', () => {
    expect(detectMinNodeVersion(['optional_chaining', 'using_declaration'])).toBe('22');
  });

  it('returns undefined for baseline features', () => {
    expect(detectMinNodeVersion(['function_declaration', 'if_statement'])).toBeUndefined();
  });

  it('detects fetch API → Node 18', () => {
    expect(detectMinNodeVersionFromAPIs('const res = await fetch(url)')).toBe('18');
  });

  it('detects structuredClone → Node 17', () => {
    expect(detectMinNodeVersionFromAPIs('const copy = structuredClone(obj)')).toBe('17');
  });

  it('detects node:test → Node 18', () => {
    expect(detectMinNodeVersionFromAPIs("import test from 'node:test'")).toBe('18');
  });

  it('returns undefined for code without API markers', () => {
    expect(detectMinNodeVersionFromAPIs('const x = 42;')).toBeUndefined();
  });
});

// ==============================
// TypeScript compiler
// ==============================

describe('TypeScript compiler version detection', () => {
  it('detects satisfies → TS 4.9', () => {
    expect(detectMinTsVersion(['satisfies_expression'])).toBe('4.9');
  });

  it('detects const type parameter → TS 5.0', () => {
    expect(detectMinTsVersion(['const_type_parameter'])).toBe('5.0');
  });

  it('detects using declaration → TS 5.2', () => {
    expect(detectMinTsVersion(['using_declaration'])).toBe('5.2');
  });

  it('detects satisfies from source', () => {
    expect(detectMinTsVersionFromSource('const x = {} satisfies Config')).toBe('4.9');
  });

  it('detects <const T> from source', () => {
    expect(detectMinTsVersionFromSource('function foo<const T>(x: T) {}')).toBe('5.0');
  });

  it('returns undefined for vanilla TS', () => {
    expect(detectMinTsVersion(['interface_declaration', 'type_alias_declaration'])).toBeUndefined();
  });
});

// ==============================
// ECMAScript
// ==============================

describe('ECMAScript version detection', () => {
  it('detects arrow function → ES2015', () => {
    expect(detectMinEsVersion(['arrow_function'])).toBe('ES2015');
  });

  it('detects await → ES2017', () => {
    expect(detectMinEsVersion(['await_expression'])).toBe('ES2017');
  });

  it('detects optional chaining → ES2020', () => {
    expect(detectMinEsVersion(['optional_chaining'])).toBe('ES2020');
  });

  it('detects class static block → ES2022', () => {
    expect(detectMinEsVersion(['class_static_block'])).toBe('ES2022');
  });

  it('picks highest ES version', () => {
    expect(detectMinEsVersion(['arrow_function', 'optional_chaining', 'class_static_block'])).toBe(
      'ES2022',
    );
  });
});

// ==============================
// Python
// ==============================

describe('Python version detection', () => {
  it('detects match statement → 3.10', () => {
    expect(detectMinPythonVersion(['match_statement'])).toBe('3.10');
  });

  it('detects type alias → 3.12', () => {
    expect(detectMinPythonVersion(['type_alias_statement'])).toBe('3.12');
  });

  it('detects f-strings → 3.6', () => {
    expect(detectMinPythonVersion(['format_string'])).toBe('3.6');
  });

  it('detects walrus operator → 3.8', () => {
    expect(detectMinPythonVersion(['named_expression'])).toBe('3.8');
  });

  it('detects async → 3.5', () => {
    expect(detectMinPythonVersion(['async_function_definition'])).toBe('3.5');
  });

  it('returns undefined for basic features', () => {
    expect(detectMinPythonVersion(['function_definition', 'if_statement'])).toBeUndefined();
  });
});

// ==============================
// PHP
// ==============================

describe('PHP version detection', () => {
  it('detects attribute list → 8.0', () => {
    expect(detectMinPhpVersion(['attribute_list'])).toBe('8.0');
  });

  it('detects enum → 8.1', () => {
    expect(detectMinPhpVersion(['enum_declaration'])).toBe('8.1');
  });

  it('detects property hooks → 8.4', () => {
    expect(detectMinPhpVersion(['property_hook_list'])).toBe('8.4');
  });

  it('detects namespace → 5.3', () => {
    expect(detectMinPhpVersion(['namespace_definition'])).toBe('5.3');
  });

  it('detects arrow function → 7.4', () => {
    expect(detectMinPhpVersion(['arrow_function'])).toBe('7.4');
  });
});

// ==============================
// Go
// ==============================

describe('Go version detection', () => {
  it('detects //go:embed → 1.16', () => {
    expect(detectMinGoVersionFromSource('//go:embed templates/*')).toBe('1.16');
  });

  it('detects generics → 1.18', () => {
    expect(detectMinGoVersionFromSource('func Map[T any](s []T) []T {')).toBe('1.18');
  });

  it('detects min() builtin → 1.21', () => {
    expect(detectMinGoVersionFromSource('x := min(a, b)')).toBe('1.21');
  });

  it('returns undefined for basic Go code', () => {
    expect(detectMinGoVersionFromSource('func main() { fmt.Println("hello") }')).toBeUndefined();
  });
});

// ==============================
// Java
// ==============================

describe('Java version detection', () => {
  it('detects lambda → Java 8', () => {
    expect(detectMinJavaVersionFromSource('list.stream().map(x -> x * 2)')).toBe('8');
  });

  it('detects var → Java 10', () => {
    expect(detectMinJavaVersionFromSource('var items = List.of(1, 2);')).toBe('10');
  });

  it('detects text blocks → Java 15', () => {
    expect(detectMinJavaVersionFromSource('String s = """\n  hello\n  """;')).toBe('15');
  });

  it('detects records → Java 16', () => {
    expect(detectMinJavaVersionFromSource('public record Point(int x, int y) {}')).toBe('16');
  });

  it('detects sealed classes → Java 17', () => {
    expect(detectMinJavaVersionFromSource('sealed class Shape permits Circle, Square {}')).toBe(
      '17',
    );
  });
});

// ==============================
// Kotlin
// ==============================

describe('Kotlin version detection', () => {
  it('detects suspend → 1.3', () => {
    expect(detectMinKotlinVersion('suspend fun getData(): List<Item> {')).toBe('1.3');
  });

  it('detects data object → 1.9', () => {
    expect(detectMinKotlinVersion('data object Empty')).toBe('1.9');
  });

  it('detects sealed interface → 1.5', () => {
    expect(detectMinKotlinVersion('sealed interface UiState')).toBe('1.5');
  });

  it('returns undefined for basic Kotlin', () => {
    expect(detectMinKotlinVersion('fun main() { println("hello") }')).toBeUndefined();
  });
});

// ==============================
// Ruby
// ==============================

describe('Ruby version detection', () => {
  it('detects safe navigation → 2.3', () => {
    expect(detectMinRubyVersionFromSource('user&.name')).toBe('2.3');
  });

  it('detects frozen string literal → 2.3', () => {
    expect(detectMinRubyVersionFromSource('# frozen_string_literal: true')).toBe('2.3');
  });

  it('detects endless range → 2.6', () => {
    expect(detectMinRubyVersionFromSource('(1..)')).toBe('2.6');
  });

  it('detects numbered block params → 2.7', () => {
    expect(detectMinRubyVersionFromSource('items.map { _1.to_s }')).toBe('2.7');
  });

  it('detects Data.define → 3.2', () => {
    expect(detectMinRubyVersionFromSource('Point = Data.define(:x, :y)')).toBe('3.2');
  });

  it('returns undefined for basic Ruby', () => {
    expect(detectMinRubyVersionFromSource('def hello; puts "hi"; end')).toBeUndefined();
  });
});

// ==============================
// CSS / SCSS / LESS
// ==============================

describe('CSS version detection', () => {
  it('detects CSS custom properties → 2017', () => {
    const r = detectCssVersions(':root { color: var(--main); }', 'css');
    expect(r.minCssSpec).toBe('2017');
  });

  it('detects :has() → 2022', () => {
    const r = detectCssVersions('div:has(.active) { }', 'css');
    expect(r.minCssSpec).toBe('2022');
    expect(r.cssFeatures).toContain(':has() pseudo-class');
  });

  it('detects @layer → 2022', () => {
    const r = detectCssVersions('@layer utilities { }', 'css');
    expect(r.minCssSpec).toBe('2022');
  });

  it('detects @container → 2022', () => {
    const r = detectCssVersions('@container sidebar (min-width: 400px) { }', 'css');
    expect(r.minCssSpec).toBe('2022');
  });

  it('detects CSS nesting → 2023', () => {
    const r = detectCssVersions('.card { & .title { } }', 'css');
    expect(r.minCssSpec).toBe('2023');
  });

  it('detects @scope → 2024', () => {
    const r = detectCssVersions('@scope (.card) { }', 'css');
    expect(r.minCssSpec).toBe('2024');
  });

  it('returns no version for basic CSS', () => {
    const r = detectCssVersions('body { color: red; }', 'css');
    expect(r.minCssSpec).toBeUndefined();
  });
});

describe('SCSS/Sass version detection', () => {
  it('detects @use → Sass 1.23', () => {
    const r = detectCssVersions('@use "variables";', 'scss');
    expect(r.minSassVersion).toBe('1.23');
  });

  it('detects @use with() → Sass 1.33', () => {
    const r = detectCssVersions('@use "config" with ($color: red);', 'scss');
    expect(r.minSassVersion).toBe('1.33');
  });

  it('detects math.div → Sass 1.33', () => {
    const r = detectCssVersions('width: math.div(100%, 3);', 'scss');
    expect(r.minSassVersion).toBe('1.33');
  });

  it('detects @import deprecation context → Sass 1.71', () => {
    const r = detectCssVersions('@import "legacy";', 'scss');
    expect(r.minSassVersion).toBe('1.71');
  });

  it('detects oklch → Sass 1.80', () => {
    const r = detectCssVersions('color: oklch(50% 0.2 120);', 'scss');
    expect(r.minSassVersion).toBe('1.80');
  });

  it('does not detect Sass features in plain CSS', () => {
    const r = detectCssVersions('@import "reset.css";', 'css');
    expect(r.minSassVersion).toBeUndefined();
  });
});

describe('LESS version detection', () => {
  it('detects each() → LESS 3.0', () => {
    const r = detectCssVersions('each(@list, { ... })', 'less');
    expect(r.minLessVersion).toBe('3.0');
  });

  it('detects @plugin → LESS 3.5', () => {
    const r = detectCssVersions('@plugin "my-plugin";', 'less');
    expect(r.minLessVersion).toBe('3.5');
  });

  it('detects @layer → LESS 4.1', () => {
    const r = detectCssVersions('@layer base { }', 'less');
    expect(r.minLessVersion).toBe('4.1');
  });

  it('does not detect LESS features in SCSS', () => {
    const r = detectCssVersions('@layer base { }', 'scss');
    expect(r.minLessVersion).toBeUndefined();
  });
});
