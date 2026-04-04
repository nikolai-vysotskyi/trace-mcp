/**
 * Dart Language Plugin — regex-based symbol extraction.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'dart',
  language: 'dart',
  extensions: ['.dart'],
  symbolPatterns: [
    // Class: abstract class Name or class Name
    {
      kind: 'class',
      pattern: /^[ \t]*(?:(?:abstract|sealed|base|final|mixin)\s+)*class\s+(\w+)/gm,
    },
    // Mixin: mixin Name
    {
      kind: 'trait',
      pattern: /^[ \t]*(?:base\s+)?mixin\s+(?!class\b)(\w+)/gm,
      meta: { dartKind: 'mixin' },
    },
    // Extension: extension Name on Type
    {
      kind: 'class',
      pattern: /^[ \t]*extension\s+(\w+)\s+on\b/gm,
      meta: { dartKind: 'extension' },
    },
    // Extension type: extension type Name(...)
    {
      kind: 'class',
      pattern: /^[ \t]*extension\s+type\s+(\w+)/gm,
      meta: { dartKind: 'extension_type' },
    },
    // Enum: enum Name
    {
      kind: 'enum',
      pattern: /^[ \t]*enum\s+(\w+)/gm,
    },
    // Typedef: typedef Name = ... or typedef ReturnType Name(...)
    {
      kind: 'type',
      pattern: /^[ \t]*typedef\s+(?:\w+\s+)?(\w+)\s*[=(]/gm,
    },
    // Top-level / method functions with explicit return type before name(
    {
      kind: 'function',
      pattern: /^[ \t]*(?:(?:static|external|abstract|override)\s+)*(?:(?:Future|Stream|FutureOr|Iterable|List|Map|Set)<[^>]*>\s+|(?:void|int|double|bool|String|num|dynamic|Object|Never|Null)\s+)(\w+)\s*(?:<[^>]*>)?\s*\(/gm,
    },
    // Getter: Type get name => or Type get name {
    {
      kind: 'property',
      pattern: /^[ \t]*(?:(?:static|external|abstract|override)\s+)*(?:\w[\w<>,?\s]*\s+)?get\s+(\w+)/gm,
      meta: { dartKind: 'getter' },
    },
    // Setter: set name(Type value) {
    {
      kind: 'property',
      pattern: /^[ \t]*(?:(?:static|external|abstract|override)\s+)*set\s+(\w+)\s*\(/gm,
      meta: { dartKind: 'setter' },
    },
    // Factory constructor: factory ClassName(...)
    {
      kind: 'method',
      pattern: /^[ \t]*(?:const\s+)?factory\s+(\w+)(?:\.\w+)?\s*\(/gm,
      meta: { dartKind: 'factory' },
    },
    // Top-level const: const name = ... or const Type name = ...
    {
      kind: 'constant',
      pattern: /^[ \t]*(?:(?:static|external)\s+)?const\s+(?:[\w<>,?\s]+\s+)?(\w+)\s*=/gm,
    },
    // Top-level final: final name = ... or final Type name = ...
    {
      kind: 'variable',
      pattern: /^[ \t]*(?:(?:static|late|external)\s+)*final\s+(?:[\w<>,?\s]+\s+)?(\w+)\s*[=;]/gm,
    },
    // Top-level var: var name or Type name
    {
      kind: 'variable',
      pattern: /^[ \t]*(?:(?:static|late)\s+)*var\s+(\w+)\s*[=;]/gm,
    },
    // Enum values (inside enum bodies are hard to regex, skip for now)
  ],
  importPatterns: [
    // import 'package:name/path.dart'; or import 'path.dart';
    { pattern: /^[ \t]*import\s+'([^']+)'/gm },
    // import "package:name/path.dart";
    { pattern: /^[ \t]*import\s+"([^"]+)"/gm },
    // export 'package:name/path.dart';
    { pattern: /^[ \t]*export\s+'([^']+)'/gm },
    // part 'file.dart'; or part of 'library';
    { pattern: /^[ \t]*part\s+(?:of\s+)?'([^']+)'/gm },
  ],
});

export class DartLanguagePlugin implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
}
