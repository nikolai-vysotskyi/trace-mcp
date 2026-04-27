import { describe, expect, it } from 'vitest';
import { DartLanguagePlugin } from '../../src/indexer/plugins/language/dart/index.js';
import { ObjCLanguagePlugin } from '../../src/indexer/plugins/language/objc/index.js';
import { SwiftLanguagePlugin } from '../../src/indexer/plugins/language/swift/index.js';

// XML tests moved to xml.test.ts

// ── Swift ───────────────────────────────────────────────────────────────────

const swiftPlugin = new SwiftLanguagePlugin();
async function parseSwift(source: string, filePath = 'main.swift') {
  const result = await swiftPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('SwiftLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(swiftPlugin.manifest.name).toBe('swift-language');
    expect(swiftPlugin.supportedExtensions).toContain('.swift');
  });

  it('extracts functions', async () => {
    const r = await parseSwift(
      'func greet(name: String) -> String {\n  return "Hello \\(name)"\n}',
    );
    expect(r.symbols.some((s) => s.name === 'greet' && s.kind === 'function')).toBe(true);
  });

  it('extracts classes', async () => {
    const r = await parseSwift('class Vehicle {\n  var speed: Int = 0\n}');
    expect(r.symbols.some((s) => s.name === 'Vehicle' && s.kind === 'class')).toBe(true);
  });

  it('extracts structs', async () => {
    const r = await parseSwift('struct Point {\n  var x: Double\n  var y: Double\n}');
    expect(r.symbols.some((s) => s.name === 'Point' && s.kind === 'class')).toBe(true);
  });

  it('extracts protocols', async () => {
    const r = await parseSwift('protocol Drawable {\n  func draw()\n}');
    expect(r.symbols.some((s) => s.name === 'Drawable' && s.kind === 'interface')).toBe(true);
  });

  it('extracts enums with cases', async () => {
    const r = await parseSwift('enum Direction {\n  case north\n  case south\n}');
    expect(r.symbols.some((s) => s.name === 'Direction' && s.kind === 'enum')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'north' && s.kind === 'enum_case')).toBe(true);
  });

  it('extracts constants (let)', async () => {
    const r = await parseSwift('let maxRetries = 5');
    expect(r.symbols.some((s) => s.name === 'maxRetries' && s.kind === 'constant')).toBe(true);
  });

  it('extracts variables (var)', async () => {
    const r = await parseSwift('var currentCount = 0');
    expect(r.symbols.some((s) => s.name === 'currentCount' && s.kind === 'variable')).toBe(true);
  });

  it('extracts typealiases', async () => {
    const r = await parseSwift('typealias Completion = (Bool) -> Void');
    expect(r.symbols.some((s) => s.name === 'Completion' && s.kind === 'type')).toBe(true);
  });

  it('extracts import edges', async () => {
    const r = await parseSwift('import Foundation\nimport UIKit');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const modules = imports.map((e) => (e.metadata as any).module);
    expect(modules).toContain('Foundation');
    expect(modules).toContain('UIKit');
  });
});

// ── Objective-C ─────────────────────────────────────────────────────────────

const objcPlugin = new ObjCLanguagePlugin();
async function parseObjC(source: string, filePath = 'MyClass.m') {
  const result = await objcPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('ObjCLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(objcPlugin.manifest.name).toBe('objc-language');
    expect(objcPlugin.supportedExtensions).toContain('.m');
  });

  it('extracts @interface declarations', async () => {
    const r = await parseObjC('@interface MyClass : NSObject\n@end');
    expect(r.symbols.some((s) => s.name === 'MyClass' && s.kind === 'class')).toBe(true);
  });

  it('extracts @implementation', async () => {
    const r = await parseObjC('@implementation MyClass\n@end');
    expect(r.symbols.some((s) => s.name === 'MyClass' && s.kind === 'class')).toBe(true);
  });

  it('extracts @protocol', async () => {
    const r = await parseObjC('@protocol Serializable\n- (NSData *)serialize;\n@end');
    expect(r.symbols.some((s) => s.name === 'Serializable' && s.kind === 'interface')).toBe(true);
  });

  it('extracts simple instance method', async () => {
    const r = await parseObjC('@implementation Foo\n- (void)doSomething {\n}\n@end');
    expect(r.symbols.some((s) => s.name === 'doSomething' && s.kind === 'method')).toBe(true);
  });

  it('extracts instance method with parameter', async () => {
    const r = await parseObjC(
      '@implementation Foo\n- (void)doSomething:(NSString *)name {\n}\n@end',
    );
    expect(r.symbols.some((s) => s.kind === 'method' && s.name.includes('doSomething'))).toBe(true);
  });

  it('extracts class methods', async () => {
    const r = await parseObjC(
      '@implementation Foo\n+ (instancetype)sharedInstance {\n  return nil;\n}\n@end',
    );
    expect(r.symbols.some((s) => s.name === 'sharedInstance' && s.kind === 'method')).toBe(true);
    const method = r.symbols.find((s) => s.name === 'sharedInstance');
    expect(method!.metadata?.static).toBe(true);
  });

  it('extracts @property', async () => {
    const r = await parseObjC(
      '@interface Foo : NSObject\n@property (nonatomic, strong) NSString *name;\n@end',
    );
    expect(r.symbols.some((s) => s.name === 'name' && s.kind === 'property')).toBe(true);
  });

  it('extracts #define constants', async () => {
    const r = await parseObjC('#define APP_VERSION @"1.0.0"');
    expect(r.symbols.some((s) => s.name === 'APP_VERSION' && s.kind === 'constant')).toBe(true);
  });

  it('extracts import edges from #import', async () => {
    const r = await parseObjC('#import <Foundation/Foundation.h>\n#import "MyHeader.h"');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBe(2);
    const modules = imports.map((e) => (e.metadata as any).module);
    expect(modules).toContain('Foundation/Foundation.h');
    expect(modules).toContain('MyHeader.h');
  });

  it('extracts import edges from @import', async () => {
    const r = await parseObjC('@import UIKit;');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.some((e) => (e.metadata as any).module === 'UIKit')).toBe(true);
  });
});

// ── Dart ────────────────────────────────────────────────────────────────────

const dartPlugin = new DartLanguagePlugin();
async function parseDart(source: string, filePath = 'main.dart') {
  const result = await dartPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('DartLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(dartPlugin.manifest.name).toBe('dart-language');
    expect(dartPlugin.supportedExtensions).toContain('.dart');
  });

  it('extracts classes', async () => {
    const r = await parseDart('class UserRepository {\n  void save() {}\n}');
    expect(r.symbols.some((s) => s.name === 'UserRepository' && s.kind === 'class')).toBe(true);
  });

  it('extracts abstract classes', async () => {
    const r = await parseDart('abstract class BaseService {\n  void init();\n}');
    expect(r.symbols.some((s) => s.name === 'BaseService' && s.kind === 'class')).toBe(true);
  });

  it('extracts mixins', async () => {
    const r = await parseDart('mixin Printable {\n  void printInfo() {}\n}');
    expect(r.symbols.some((s) => s.name === 'Printable' && s.kind === 'trait')).toBe(true);
  });

  it('extracts enums', async () => {
    const r = await parseDart('enum Color { red, green, blue }');
    expect(r.symbols.some((s) => s.name === 'Color' && s.kind === 'enum')).toBe(true);
  });

  it('extracts functions with return types', async () => {
    const r = await parseDart('void fetchData() async {\n  // fetch\n}');
    expect(r.symbols.some((s) => s.name === 'fetchData' && s.kind === 'function')).toBe(true);
  });

  it('extracts Future-returning functions', async () => {
    const r = await parseDart('Future<String> loadName() async {\n  return "";\n}');
    expect(r.symbols.some((s) => s.name === 'loadName' && s.kind === 'function')).toBe(true);
  });

  it('extracts getters', async () => {
    const r = await parseDart('String get name => _name;');
    expect(r.symbols.some((s) => s.name === 'name' && s.kind === 'property')).toBe(true);
  });

  it('extracts constants', async () => {
    const r = await parseDart('const maxItems = 100;');
    expect(r.symbols.some((s) => s.name === 'maxItems' && s.kind === 'constant')).toBe(true);
  });

  it('extracts final variables', async () => {
    const r = await parseDart('final String appName = "MyApp";');
    expect(r.symbols.some((s) => s.name === 'appName' && s.kind === 'variable')).toBe(true);
  });

  it('extracts import edges', async () => {
    const r = await parseDart("import 'package:flutter/material.dart';\nimport 'dart:async';");
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const modules = imports.map((e) => (e.metadata as any).module);
    expect(modules).toContain('package:flutter/material.dart');
    expect(modules).toContain('dart:async');
  });
});

// XML tests moved to xml.test.ts
