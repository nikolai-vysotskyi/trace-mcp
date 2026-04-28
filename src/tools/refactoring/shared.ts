/**
 * Shared types, constants, and helpers for refactoring tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface FileEdit {
  file: string;
  original_line: number;
  original_text: string;
  new_text: string;
}

export interface NonCodeMention {
  file: string;
  line: number;
  text: string;
  suggestion: string;
}

export interface RefactorResult {
  success: boolean;
  tool: string;
  edits: FileEdit[];
  files_modified: string[];
  warnings: string[];
  error?: string;
  non_code_suggestions?: NonCodeMention[];
}

// ════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════

export const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.svg',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wav',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.a',
  '.wasm',
  '.pyc',
  '.class',
]);

export const SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  '__pycache__',
  '.next',
  '.nuxt',
];

// ════════════════════════════════════════════════════════════════════════
// FILE I/O
// ════════════════════════════════════════════════════════════════════════

/** Read file content, split into lines. */
export function readLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf-8').split('\n');
}

/** Write lines back to file. */
export function writeLines(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// ════════════════════════════════════════════════════════════════════════
// SYMBOL / IMPORT HELPERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a word-boundary regex for renaming a symbol name.
 * Handles property access (`.name`), destructuring (`{ name }`), imports, etc.
 */
export function buildRenameRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

/**
 * Get all files that import a given file node.
 * Returns file paths + file IDs for targeted replacement.
 */
export function getImportingFiles(
  store: Store,
  fileId: number,
  projectRoot: string,
): { filePath: string; fileId: number }[] {
  const fileNodeId = store.getNodeId('file', fileId);
  if (fileNodeId === undefined) return [];

  const incomingEdges = store.getIncomingEdges(fileNodeId);
  const importingFiles: { filePath: string; fileId: number }[] = [];
  const seen = new Set<number>();

  for (const edge of incomingEdges) {
    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref) continue;

    let importFileId: number | undefined;
    if (ref.nodeType === 'file') {
      importFileId = ref.refId;
    } else if (ref.nodeType === 'symbol') {
      const symRow = store.getSymbolById(ref.refId);
      if (symRow) importFileId = symRow.file_id;
    }

    if (importFileId !== undefined && importFileId !== fileId && !seen.has(importFileId)) {
      seen.add(importFileId);
      const file = store.getFileById(importFileId);
      if (file) {
        importingFiles.push({
          filePath: path.resolve(projectRoot, file.path),
          fileId: importFileId,
        });
      }
    }
  }

  return importingFiles;
}

// ════════════════════════════════════════════════════════════════════════
// LANGUAGE DETECTION
// ════════════════════════════════════════════════════════════════════════

export function detectLanguage(ext: string): 'typescript' | 'python' | 'go' | 'generic' {
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'typescript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    default:
      return 'generic';
  }
}

// ════════════════════════════════════════════════════════════════════════
// IDENTIFIER EXTRACTION (lightweight, regex-based)
// ════════════════════════════════════════════════════════════════════════

export interface IdentifierAnalysis {
  /** All identifiers used (read) in the code */
  used: string[];
  /** Identifiers that are defined (assigned / declared) in the code */
  defined: Set<string>;
}

/** Keywords to exclude from identifier analysis */
export const KEYWORDS = new Set([
  // JS/TS
  'const',
  'let',
  'var',
  'function',
  'class',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'this',
  'super',
  'import',
  'export',
  'from',
  'default',
  'async',
  'await',
  'try',
  'catch',
  'finally',
  'throw',
  'typeof',
  'instanceof',
  'void',
  'delete',
  'in',
  'of',
  'true',
  'false',
  'null',
  'undefined',
  'yield',
  'static',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'abstract',
  // Python
  'def',
  'class',
  'return',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'with',
  'as',
  'import',
  'from',
  'try',
  'except',
  'finally',
  'raise',
  'pass',
  'lambda',
  'and',
  'or',
  'not',
  'is',
  'in',
  'True',
  'False',
  'None',
  'global',
  'nonlocal',
  'assert',
  // Go
  'func',
  'return',
  'if',
  'else',
  'for',
  'range',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'go',
  'defer',
  'select',
  'chan',
  'map',
  'struct',
  'interface',
  'package',
  'import',
  'type',
  'var',
  'const',
  'nil',
  'true',
  'false',
  // Common
  'console',
  'log',
  'print',
  'fmt',
  'string',
  'number',
  'boolean',
  'int',
  'float',
]);

/**
 * Extract identifiers from code text using regex-based analysis.
 * Not a full parser — good enough for variable detection in extraction.
 */
export function extractIdentifiers(text: string): IdentifierAnalysis {
  const defined = new Set<string>();
  const usedList: string[] = [];
  const seen = new Set<string>();

  // Detect definitions: const/let/var X, function X, def X, X :=, X =
  const defPatterns = [
    /(?:const|let|var)\s+(?:\{[^}]*\}|([a-zA-Z_$][\w$]*))/g, // JS/TS destructuring or simple
    /function\s+([a-zA-Z_$][\w$]*)/g, // function declarations
    /def\s+([a-zA-Z_]\w*)/g, // Python defs
    /([a-zA-Z_]\w*)\s*:=/g, // Go short var decl
    /for\s+(?:const|let|var)?\s*(?:\(?\s*)?([a-zA-Z_$][\w$]*)/g, // for loop vars
  ];

  for (const pattern of defPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      if (name && !KEYWORDS.has(name)) {
        defined.add(name);
      }
    }
  }

  // Also handle destructuring definitions: const { a, b } = ...
  const destructurePattern = /(?:const|let|var)\s+\{([^}]+)\}/g;
  let dm: RegExpExecArray | null;
  while ((dm = destructurePattern.exec(text)) !== null) {
    const inner = dm[1];
    for (const part of inner.split(',')) {
      const name = part.split(':').pop()?.trim().split('=')[0]?.trim();
      if (name && /^[a-zA-Z_$][\w$]*$/.test(name) && !KEYWORDS.has(name)) {
        defined.add(name);
      }
    }
  }

  // Detect all identifier usages
  const identPattern = /\b([a-zA-Z_$][\w$]*)\b/g;
  let im: RegExpExecArray | null;
  while ((im = identPattern.exec(text)) !== null) {
    const name = im[1];
    if (!KEYWORDS.has(name) && !seen.has(name)) {
      seen.add(name);
      usedList.push(name);
    }
  }

  return { used: usedList, defined };
}

/** Get leading whitespace of a line. */
export function getIndent(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}
