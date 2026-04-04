/**
 * Swift Language Plugin — regex-based symbol extraction.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'swift',
  language: 'swift',
  extensions: ['.swift'],
  symbolPatterns: [
    // Class: public class Name or final class Name
    {
      kind: 'class',
      pattern: /^[ \t]*(?:(?:open|public|internal|fileprivate|private|final)\s+)*class\s+(\w+)/gm,
    },
    // Struct: public struct Name
    {
      kind: 'class',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private)\s+)*struct\s+(\w+)/gm,
      meta: { swiftKind: 'struct' },
    },
    // Enum: public enum Name
    {
      kind: 'enum',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private|indirect)\s+)*enum\s+(\w+)/gm,
    },
    // Protocol: public protocol Name
    {
      kind: 'interface',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private)\s+)*protocol\s+(\w+)/gm,
      meta: { swiftKind: 'protocol' },
    },
    // Extension: extension Name
    {
      kind: 'class',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private)\s+)*extension\s+(\w+)/gm,
      meta: { swiftKind: 'extension' },
    },
    // Function: func name(...)
    {
      kind: 'function',
      pattern: /^[ \t]*(?:(?:open|public|internal|fileprivate|private|static|class|override|mutating|nonmutating|@\w+\s*(?:\([^)]*\))?\s*)\s+)*func\s+(\w+)/gm,
    },
    // Typealias: typealias Name = ...
    {
      kind: 'type',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private)\s+)*typealias\s+(\w+)/gm,
    },
    // Constant: let name (top-level or with access modifiers)
    {
      kind: 'constant',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private|static|class|lazy|override)\s+)*let\s+(\w+)/gm,
    },
    // Variable: var name
    {
      kind: 'variable',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private|static|class|lazy|override|weak|unowned)\s+)*var\s+(\w+)/gm,
    },
    // Enum case: case name
    {
      kind: 'enum_case',
      pattern: /^[ \t]*case\s+(\w+)/gm,
    },
    // Init: init(...) — use "init" as name but distinguish by line number via symbolId
    {
      kind: 'method',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private|convenience|required|override)\s+)*(init)\s*[?(]/gm,
      meta: { swiftKind: 'initializer' },
    },
    // Deinit
    {
      kind: 'method',
      pattern: /^[ \t]*(deinit)\s*\{/gm,
      meta: { swiftKind: 'deinitializer' },
    },
    // Subscript
    {
      kind: 'method',
      pattern: /^[ \t]*(?:(?:public|internal|fileprivate|private|static|class|override)\s+)*(subscript)\s*[(<]/gm,
      meta: { swiftKind: 'subscript' },
    },
    // Associated type (in protocols)
    {
      kind: 'type',
      pattern: /^[ \t]*associatedtype\s+(\w+)/gm,
      meta: { swiftKind: 'associatedtype' },
    },
  ],
  importPatterns: [
    // import Module or import struct Module.Type
    { pattern: /^[ \t]*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([\w.]+)/gm },
  ],
});

export class SwiftLanguagePlugin implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
}
