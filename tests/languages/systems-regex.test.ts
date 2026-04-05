import { describe, it, expect } from 'vitest';
import { SwiftLanguagePlugin } from '../../src/indexer/plugins/language/swift/index.js';
import { ObjCLanguagePlugin } from '../../src/indexer/plugins/language/objc/index.js';
import { DartLanguagePlugin } from '../../src/indexer/plugins/language/dart/index.js';
// XML tests moved to xml.test.ts

// ── Swift ───────────────────────────────────────────────────────────────────

const swiftPlugin = new SwiftLanguagePlugin();
function parseSwift(source: string, filePath = 'main.swift') {
  const result = swiftPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('SwiftLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(swiftPlugin.manifest.name).toBe('swift-language');
    expect(swiftPlugin.supportedExtensions).toContain('.swift');
  });

  it('extracts functions', () => {
    const r = parseSwift('func greet(name: String) -> String {\n  return "Hello \\(name)"\n}');
    expect(r.symbols.some(s => s.name === 'greet' && s.kind === 'function')).toBe(true);
  });

  it('extracts classes', () => {
    const r = parseSwift('class Vehicle {\n  var speed: Int = 0\n}');
    expect(r.symbols.some(s => s.name === 'Vehicle' && s.kind === 'class')).toBe(true);
  });

  it('extracts structs', () => {
    const r = parseSwift('struct Point {\n  var x: Double\n  var y: Double\n}');
    expect(r.symbols.some(s => s.name === 'Point' && s.kind === 'class')).toBe(true);
  });

  it('extracts protocols', () => {
    const r = parseSwift('protocol Drawable {\n  func draw()\n}');
    expect(r.symbols.some(s => s.name === 'Drawable' && s.kind === 'interface')).toBe(true);
  });

  it('extracts enums with cases', () => {
    const r = parseSwift('enum Direction {\n  case north\n  case south\n}');
    expect(r.symbols.some(s => s.name === 'Direction' && s.kind === 'enum')).toBe(true);
    expect(r.symbols.some(s => s.name === 'north' && s.kind === 'enum_case')).toBe(true);
  });

  it('extracts constants (let)', () => {
    const r = parseSwift('let maxRetries = 5');
    expect(r.symbols.some(s => s.name === 'maxRetries' && s.kind === 'constant')).toBe(true);
  });

  it('extracts variables (var)', () => {
    const r = parseSwift('var currentCount = 0');
    expect(r.symbols.some(s => s.name === 'currentCount' && s.kind === 'variable')).toBe(true);
  });

  it('extracts typealiases', () => {
    const r = parseSwift('typealias Completion = (Bool) -> Void');
    expect(r.symbols.some(s => s.name === 'Completion' && s.kind === 'type')).toBe(true);
  });

  it('extracts import edges', () => {
    const r = parseSwift('import Foundation\nimport UIKit');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const modules = imports.map(e => (e.metadata as any).module);
    expect(modules).toContain('Foundation');
    expect(modules).toContain('UIKit');
  });
});

// ── Objective-C ─────────────────────────────────────────────────────────────

const objcPlugin = new ObjCLanguagePlugin();
function parseObjC(source: string, filePath = 'MyClass.m') {
  const result = objcPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('ObjCLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(objcPlugin.manifest.name).toBe('objc-language');
    expect(objcPlugin.supportedExtensions).toContain('.m');
  });

  it('extracts @interface declarations', () => {
    const r = parseObjC('@interface MyClass : NSObject\n@end');
    expect(r.symbols.some(s => s.name === 'MyClass' && s.kind === 'class')).toBe(true);
  });

  it('extracts @implementation', () => {
    const r = parseObjC('@implementation MyClass\n@end');
    expect(r.symbols.some(s => s.name === 'MyClass' && s.kind === 'class')).toBe(true);
  });

  it('extracts @protocol', () => {
    const r = parseObjC('@protocol Serializable\n- (NSData *)serialize;\n@end');
    expect(r.symbols.some(s => s.name === 'Serializable' && s.kind === 'interface')).toBe(true);
  });

  it('extracts simple instance method', () => {
    const r = parseObjC('- (void)doSomething {\n}');
    expect(r.symbols.some(s => s.name === 'doSomething' && s.kind === 'method')).toBe(true);
  });

  it('extracts instance method with parameter', () => {
    const r = parseObjC('- (void)doSomething:(NSString *)name {\n}');
    // Regex captures selector parts from the matched line
    expect(r.symbols.some(s => s.kind === 'method' && s.name.includes('doSomething'))).toBe(true);
  });

  it('extracts class methods', () => {
    const r = parseObjC('+ (instancetype)sharedInstance {\n  return nil;\n}');
    expect(r.symbols.some(s => s.name === 'sharedInstance' && s.kind === 'method')).toBe(true);
    const method = r.symbols.find(s => s.name === 'sharedInstance');
    expect(method!.metadata?.static).toBe(true);
  });

  it('extracts @property', () => {
    const r = parseObjC('@property (nonatomic, strong) NSString *name;');
    expect(r.symbols.some(s => s.name === 'name' && s.kind === 'property')).toBe(true);
  });

  it('extracts #define constants', () => {
    const r = parseObjC('#define APP_VERSION @"1.0.0"');
    expect(r.symbols.some(s => s.name === 'APP_VERSION' && s.kind === 'constant')).toBe(true);
  });

  it('extracts import edges from #import', () => {
    const r = parseObjC('#import <Foundation/Foundation.h>\n#import "MyHeader.h"');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.length).toBe(2);
    const modules = imports.map(e => (e.metadata as any).module);
    expect(modules).toContain('Foundation/Foundation.h');
    expect(modules).toContain('MyHeader.h');
  });

  it('extracts import edges from @import', () => {
    const r = parseObjC('@import UIKit;');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.some(e => (e.metadata as any).module === 'UIKit')).toBe(true);
  });
});

// ── Dart ────────────────────────────────────────────────────────────────────

const dartPlugin = new DartLanguagePlugin();
function parseDart(source: string, filePath = 'main.dart') {
  const result = dartPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('DartLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(dartPlugin.manifest.name).toBe('dart-language');
    expect(dartPlugin.supportedExtensions).toContain('.dart');
  });

  it('extracts classes', () => {
    const r = parseDart('class UserRepository {\n  void save() {}\n}');
    expect(r.symbols.some(s => s.name === 'UserRepository' && s.kind === 'class')).toBe(true);
  });

  it('extracts abstract classes', () => {
    const r = parseDart('abstract class BaseService {\n  void init();\n}');
    expect(r.symbols.some(s => s.name === 'BaseService' && s.kind === 'class')).toBe(true);
  });

  it('extracts mixins', () => {
    const r = parseDart('mixin Printable {\n  void printInfo() {}\n}');
    expect(r.symbols.some(s => s.name === 'Printable' && s.kind === 'trait')).toBe(true);
  });

  it('extracts enums', () => {
    const r = parseDart('enum Color { red, green, blue }');
    expect(r.symbols.some(s => s.name === 'Color' && s.kind === 'enum')).toBe(true);
  });

  it('extracts functions with return types', () => {
    const r = parseDart('void fetchData() async {\n  // fetch\n}');
    expect(r.symbols.some(s => s.name === 'fetchData' && s.kind === 'function')).toBe(true);
  });

  it('extracts Future-returning functions', () => {
    const r = parseDart('Future<String> loadName() async {\n  return "";\n}');
    expect(r.symbols.some(s => s.name === 'loadName' && s.kind === 'function')).toBe(true);
  });

  it('extracts getters', () => {
    const r = parseDart('String get name => _name;');
    expect(r.symbols.some(s => s.name === 'name' && s.kind === 'property')).toBe(true);
  });

  it('extracts constants', () => {
    const r = parseDart('const maxItems = 100;');
    expect(r.symbols.some(s => s.name === 'maxItems' && s.kind === 'constant')).toBe(true);
  });

  it('extracts final variables', () => {
    const r = parseDart('final String appName = "MyApp";');
    expect(r.symbols.some(s => s.name === 'appName' && s.kind === 'variable')).toBe(true);
  });

  it('extracts import edges', () => {
    const r = parseDart("import 'package:flutter/material.dart';\nimport 'dart:async';");
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const modules = imports.map(e => (e.metadata as any).module);
    expect(modules).toContain('package:flutter/material.dart');
    expect(modules).toContain('dart:async');
  });
});

// XML tests moved to xml.test.ts
