import { describe, it, expect } from 'vitest';
import { SwiftLanguagePlugin } from '../../src/indexer/plugins/language/swift/index.js';
import { ObjCLanguagePlugin } from '../../src/indexer/plugins/language/objc/index.js';
import { DartLanguagePlugin } from '../../src/indexer/plugins/language/dart/index.js';
import { XmlLanguagePlugin } from '../../src/indexer/plugins/language/xml/index.js';

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

// ── XML ─────────────────────────────────────────────────────────────────────

const xmlPlugin = new XmlLanguagePlugin();
function parseXml(source: string, filePath = 'config.xml') {
  const result = xmlPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('XmlLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(xmlPlugin.manifest.name).toBe('xml-language');
    expect(xmlPlugin.supportedExtensions).toContain('.xml');
    expect(xmlPlugin.supportedExtensions).toContain('.xsd');
    expect(xmlPlugin.supportedExtensions).toContain('.svg');
  });

  // --- Root element ---

  it('extracts root element only once (first tag)', () => {
    const r = parseXml('<root>\n  <child />\n  <other />\n</root>');
    const roots = r.symbols.filter(s => s.kind === 'type' && s.metadata?.xmlKind === 'rootElement');
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('root');
  });

  it('handles namespaced root element', () => {
    const r = parseXml('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body />\n</soap:Envelope>');
    const roots = r.symbols.filter(s => s.metadata?.xmlKind === 'rootElement');
    expect(roots[0].name).toBe('soap:Envelope');
  });

  // --- id attributes ---

  it('extracts elements with id attributes', () => {
    const r = parseXml('<root>\n  <item id="first" />\n  <item id="second" />\n</root>');
    expect(r.symbols.some(s => s.name === 'first' && s.kind === 'constant')).toBe(true);
    expect(r.symbols.some(s => s.name === 'second' && s.kind === 'constant')).toBe(true);
  });

  it('deduplicates id symbols', () => {
    const r = parseXml('<root>\n  <a id="dup" />\n  <b id="dup" />\n</root>');
    const dups = r.symbols.filter(s => s.name === 'dup');
    expect(dups).toHaveLength(1);
  });

  it('handles single-quoted id attributes', () => {
    const r = parseXml("<root><item id='sqid' /></root>");
    expect(r.symbols.some(s => s.name === 'sqid')).toBe(true);
  });

  // --- name attributes (context-aware) ---

  it('extracts name from structural tags', () => {
    const r = parseXml('<config>\n  <setting name="timeout" value="30" />\n  <feature name="darkMode" />\n</config>');
    expect(r.symbols.some(s => s.name === 'timeout')).toBe(true);
    expect(r.symbols.some(s => s.name === 'darkMode')).toBe(true);
  });

  it('does NOT extract name from HTML input/meta/param noise', () => {
    const r = parseXml('<form>\n  <input name="email" />\n  <meta name="viewport" />\n  <param name="color" />\n</form>');
    expect(r.symbols.some(s => s.name === 'email')).toBe(false);
    expect(r.symbols.some(s => s.name === 'viewport')).toBe(false);
    expect(r.symbols.some(s => s.name === 'color')).toBe(false);
  });

  // --- Namespaces ---

  it('extracts namespace declarations', () => {
    const r = parseXml('<root xmlns:ns="http://example.com" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></root>');
    expect(r.symbols.some(s => s.name === 'ns' && s.kind === 'namespace')).toBe(true);
    expect(r.symbols.some(s => s.name === 'xsi' && s.kind === 'namespace')).toBe(true);
  });

  // --- XSD types ---

  it('extracts XSD complexType as type', () => {
    const r = parseXml('<xs:schema>\n  <xs:complexType name="UserType">\n    <xs:sequence />\n  </xs:complexType>\n</xs:schema>');
    expect(r.symbols.some(s => s.name === 'UserType' && s.kind === 'type' && s.metadata?.xmlKind === 'schemaType')).toBe(true);
  });

  it('extracts XSD simpleType as type', () => {
    const r = parseXml('<xs:schema>\n  <xs:simpleType name="StatusCode">\n    <xs:restriction base="xs:string" />\n  </xs:simpleType>\n</xs:schema>');
    expect(r.symbols.some(s => s.name === 'StatusCode' && s.kind === 'type')).toBe(true);
  });

  it('extracts XSD element as type', () => {
    const r = parseXml('<xs:schema>\n  <xs:element name="user" type="UserType" />\n</xs:schema>');
    expect(r.symbols.some(s => s.name === 'user' && s.kind === 'type')).toBe(true);
  });

  // --- WSDL ---

  it('extracts WSDL definitions', () => {
    const r = parseXml('<definitions>\n  <message name="GetUserRequest" />\n  <portType name="UserPort">\n    <operation name="getUser" />\n  </portType>\n</definitions>');
    expect(r.symbols.some(s => s.name === 'GetUserRequest' && s.kind === 'type')).toBe(true);
    expect(r.symbols.some(s => s.name === 'UserPort' && s.kind === 'type')).toBe(true);
    expect(r.symbols.some(s => s.name === 'getUser' && s.kind === 'function')).toBe(true);
  });

  // --- XSLT ---

  it('extracts XSLT templates as functions', () => {
    const r = parseXml('<xsl:stylesheet>\n  <xsl:template name="header">\n    <h1>Header</h1>\n  </xsl:template>\n</xsl:stylesheet>');
    expect(r.symbols.some(s => s.name === 'header' && s.kind === 'function' && s.metadata?.xmlKind === 'xslt')).toBe(true);
  });

  it('extracts XSLT variables', () => {
    const r = parseXml('<xsl:stylesheet>\n  <xsl:variable name="title" select="\'Hello\'" />\n</xsl:stylesheet>');
    expect(r.symbols.some(s => s.name === 'title' && s.kind === 'variable')).toBe(true);
  });

  // --- Import edges ---

  it('extracts xsl:import edges', () => {
    const r = parseXml('<xsl:stylesheet>\n  <xsl:import href="base.xsl" />\n  <xsl:include href="helpers.xsl" />\n</xsl:stylesheet>');
    expect(r.edges).toBeDefined();
    const modules = r.edges!.map(e => (e.metadata as any).module);
    expect(modules).toContain('base.xsl');
    expect(modules).toContain('helpers.xsl');
  });

  it('extracts xs:import with schemaLocation', () => {
    const r = parseXml('<xs:schema>\n  <xs:import schemaLocation="types.xsd" />\n</xs:schema>');
    expect(r.edges).toBeDefined();
    expect(r.edges!.some(e => (e.metadata as any).module === 'types.xsd')).toBe(true);
  });

  it('extracts script src as import', () => {
    const r = parseXml('<page>\n  <script src="app.js" />\n</page>');
    expect(r.edges).toBeDefined();
    expect(r.edges!.some(e => (e.metadata as any).module === 'app.js')).toBe(true);
  });

  it('extracts stylesheet link as import', () => {
    const r = parseXml('<page>\n  <link rel="stylesheet" href="style.css" />\n</page>');
    expect(r.edges).toBeDefined();
    expect(r.edges!.some(e => (e.metadata as any).module === 'style.css')).toBe(true);
  });

  it('does NOT extract non-import href (e.g. anchors)', () => {
    const r = parseXml('<root>\n  <a href="https://example.com">link</a>\n</root>');
    expect(r.edges ?? []).toHaveLength(0);
  });

  // --- Edge cases ---

  it('handles empty file', () => {
    const r = parseXml('');
    expect(r.symbols).toHaveLength(0);
  });

  it('handles XML with comments and CDATA', () => {
    const r = parseXml('<!-- comment -->\n<root>\n  <![CDATA[<not-a-tag>]]>\n  <item id="real" />\n</root>');
    expect(r.symbols.some(s => s.name === 'root' && s.kind === 'type')).toBe(true);
    expect(r.symbols.some(s => s.name === 'real')).toBe(true);
    // CDATA and comments should not produce symbols
    expect(r.symbols.some(s => s.name === 'not-a-tag')).toBe(false);
  });

  it('handles processing instructions', () => {
    const r = parseXml('<?xml version="1.0"?>\n<root />');
    // PI should be skipped, root should be extracted
    expect(r.symbols.some(s => s.name === 'root')).toBe(true);
    expect(r.symbols.some(s => s.name === 'xml')).toBe(false);
  });

  it('handles SVG with namespaced attributes', () => {
    const r = parseXml('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">\n  <defs>\n    <linearGradient id="grad1" />\n  </defs>\n</svg>');
    expect(r.symbols.some(s => s.name === 'svg' && s.kind === 'type')).toBe(true);
    expect(r.symbols.some(s => s.name === 'grad1' && s.kind === 'constant')).toBe(true);
    expect(r.symbols.some(s => s.name === 'xlink' && s.kind === 'namespace')).toBe(true);
  });

  it('handles large XML without hanging (performance)', () => {
    // Generate XML with 1000 elements
    const items = Array.from({ length: 1000 }, (_, i) => `  <item id="item${i}" name="name${i}" />`).join('\n');
    const xml = `<root>\n${items}\n</root>`;
    const start = performance.now();
    const r = parseXml(xml);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500); // must finish in under 500ms
    expect(r.symbols.filter(s => s.kind === 'constant').length).toBeGreaterThanOrEqual(1000);
  });
});
