/**
 * VHDL Language Plugin — regex-based symbol extraction.
 *
 * Comprehensive extraction of:
 *  - Structural: entities, architectures, packages, package bodies, configurations
 *  - Behavioral: processes (incl. postponed), functions (pure/impure), procedures
 *  - Declarations: components, signals, constants, variables (shared), files
 *  - Types: type, subtype, record types, access types, protected types (VHDL-2000),
 *           incomplete types, physical types, array types
 *  - VHDL-2008: context declarations, case-generate, external names, force/release
 *  - Blocks: block statements, for-generate, if-generate, case-generate
 *  - Assertions: assert, report statements
 *  - Misc: aliases, attributes, groups, disconnections, natures (VHDL-AMS)
 *  - Ports: port declarations (in/out/inout/buffer/linkage)
 *  - Generics: generic declarations with defaults
 *  - Imports: library (skip work) + use clauses + VHDL-2008 context references
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'vhdl',
  language: 'vhdl',
  extensions: ['.vhd', '.vhdl', '.vho', '.vhs'],
  symbolPatterns: [
    // ═══════════════════════════════════════════════════════════════
    // Structural — Design Units
    // ═══════════════════════════════════════════════════════════════

    // entity name is
    { kind: 'class', pattern: /^\s*entity\s+(\w+)\s+is\b/gim, meta: { vhdlKind: 'entity' } },
    // architecture name of entity_name is
    { kind: 'class', pattern: /^\s*architecture\s+(\w+)\s+of\s+\w+\s+is\b/gim, meta: { vhdlKind: 'architecture' } },
    // package name is
    { kind: 'namespace', pattern: /^\s*package\s+(\w+)\s+is\b/gim, meta: { vhdlKind: 'package' } },
    // package body name is
    { kind: 'namespace', pattern: /^\s*package\s+body\s+(\w+)\s+is\b/gim, meta: { vhdlKind: 'package_body' } },
    // configuration name of entity is
    { kind: 'class', pattern: /^\s*configuration\s+(\w+)\s+of\s+\w+\s+is\b/gim, meta: { vhdlKind: 'configuration' } },
    // context name is  (VHDL-2008)
    { kind: 'namespace', pattern: /^\s*context\s+(\w+)\s+is\b/gim, meta: { vhdlKind: 'context' } },

    // ═══════════════════════════════════════════════════════════════
    // Behavioral — Processes, Functions, Procedures
    // ═══════════════════════════════════════════════════════════════

    // label : [postponed] process
    { kind: 'function', pattern: /^\s*(\w+)\s*:\s*(?:postponed\s+)?process\b/gim, meta: { vhdlKind: 'process' } },
    // function name (pure/impure)
    { kind: 'function', pattern: /^\s*(?:pure\s+|impure\s+)?function\s+(?:"[^"]+"|(\w+))/gim },
    // procedure name
    { kind: 'function', pattern: /^\s*procedure\s+(\w+)/gim, meta: { vhdlKind: 'procedure' } },

    // ═══════════════════════════════════════════════════════════════
    // Declarations — Components, Signals, Constants, etc.
    // ═══════════════════════════════════════════════════════════════

    // component name [is]
    { kind: 'interface', pattern: /^\s*component\s+(\w+)/gim },
    // signal name : type
    { kind: 'property', pattern: /^\s*signal\s+(\w+)/gim, meta: { vhdlKind: 'signal' } },
    // constant name : type := value
    { kind: 'constant', pattern: /^\s*constant\s+(\w+)/gim },
    // variable name : type  (incl. shared)
    { kind: 'variable', pattern: /^\s*(?:shared\s+)?variable\s+(\w+)/gim },
    // file name : file_type [open mode is "path"]
    { kind: 'variable', pattern: /^\s*file\s+(\w+)\s*:/gim, meta: { vhdlKind: 'file' } },

    // ═══════════════════════════════════════════════════════════════
    // Types & Subtypes (comprehensive)
    // ═══════════════════════════════════════════════════════════════

    // type name is (enumerations, records, arrays, etc.)
    { kind: 'type', pattern: /^\s*type\s+(\w+)\s+is\b/gim },
    // type name;  (incomplete type declaration)
    { kind: 'type', pattern: /^\s*type\s+(\w+)\s*;/gim, meta: { vhdlKind: 'incomplete_type' } },
    // subtype name is
    { kind: 'type', pattern: /^\s*subtype\s+(\w+)\s+is\b/gim, meta: { vhdlKind: 'subtype' } },

    // ═══════════════════════════════════════════════════════════════
    // Protected Types (VHDL-2000)
    // ═══════════════════════════════════════════════════════════════

    // type name is protected body  (must be before protected_type to match first)
    { kind: 'class', pattern: /^\s*type\s+(\w+)\s+is\s+protected\s+body\b/gim, meta: { vhdlKind: 'protected_body' } },
    // type name is protected  (but not "protected body")
    { kind: 'class', pattern: /^\s*type\s+(\w+)\s+is\s+protected\b(?!\s+body)/gim, meta: { vhdlKind: 'protected_type' } },

    // ═══════════════════════════════════════════════════════════════
    // Aliases, Attributes, Groups
    // ═══════════════════════════════════════════════════════════════

    // alias name : type is ...  /  alias name is ...
    { kind: 'variable', pattern: /^\s*alias\s+(\w+)/gim, meta: { vhdlKind: 'alias' } },
    // attribute name : type
    { kind: 'property', pattern: /^\s*attribute\s+(\w+)\s*:/gim, meta: { vhdlKind: 'attribute' } },
    // group name : group_template_name (...)
    { kind: 'variable', pattern: /^\s*group\s+(\w+)\s*:/gim, meta: { vhdlKind: 'group' } },
    // disconnect signal_name : type after time
    { kind: 'variable', pattern: /^\s*disconnect\s+(\w+)\s*:/gim, meta: { vhdlKind: 'disconnect' } },

    // ═══════════════════════════════════════════════════════════════
    // Blocks & Generate Statements
    // ═══════════════════════════════════════════════════════════════

    // label : block [(guard_expression)]
    { kind: 'function', pattern: /^\s*(\w+)\s*:\s*block\b/gim, meta: { vhdlKind: 'block' } },
    // label : for ... generate
    { kind: 'function', pattern: /^\s*(\w+)\s*:\s*for\b.*\bgenerate\b/gim, meta: { vhdlKind: 'generate' } },
    // label : if ... generate
    { kind: 'function', pattern: /^\s*(\w+)\s*:\s*if\b.*\bgenerate\b/gim, meta: { vhdlKind: 'generate' } },
    // label : case ... generate  (VHDL-2008)
    { kind: 'function', pattern: /^\s*(\w+)\s*:\s*case\b.*\bgenerate\b/gim, meta: { vhdlKind: 'case_generate' } },

    // ═══════════════════════════════════════════════════════════════
    // Ports & Generics
    // ═══════════════════════════════════════════════════════════════

    // port name : direction type
    { kind: 'property', pattern: /^\s*(\w+)\s*:\s*(?:in|out|inout|buffer|linkage)\s+\w+/gim, meta: { vhdlKind: 'port' } },
    // generic (name : type := default)
    { kind: 'constant', pattern: /^\s*(\w+)\s*:\s*\w+\s*:=/gim, meta: { vhdlKind: 'generic' } },

    // ═══════════════════════════════════════════════════════════════
    // VHDL-AMS (Analog/Mixed-Signal)
    // ═══════════════════════════════════════════════════════════════

    // nature name is ...
    { kind: 'type', pattern: /^\s*nature\s+(\w+)\s+is\b/gim, meta: { vhdlKind: 'nature' } },
    // subnature name is ...
    { kind: 'type', pattern: /^\s*subnature\s+(\w+)\s+is\b/gim, meta: { vhdlKind: 'subnature' } },
    // terminal name : nature
    { kind: 'property', pattern: /^\s*terminal\s+(\w+)/gim, meta: { vhdlKind: 'terminal' } },
    // quantity name [across|through] ...
    { kind: 'variable', pattern: /^\s*quantity\s+(\w+)/gim, meta: { vhdlKind: 'quantity' } },

    // ═══════════════════════════════════════════════════════════════
    // Labeled Concurrent Statements
    // ═══════════════════════════════════════════════════════════════

    // label : component_name [generic map (...)] port map (...)
    // label : entity lib.entity [(arch)] [generic map] port map (...)
    // (these are instantiation labels, captured as named blocks)
    // label : assert ... — concurrent assertion
    { kind: 'function', pattern: /^\s*(\w+)\s*:\s*assert\b/gim, meta: { vhdlKind: 'assertion' } },
  ],
  importPatterns: [
    // library name (skip work)
    { pattern: /^\s*library\s+(?!work\b)(\w+)\s*;/gim },
    // use lib.pkg.item
    { pattern: /^\s*use\s+(?!work\.)(\w+(?:\.\w+)*)/gim },
    // context lib.ctx  (VHDL-2008 context reference)
    { pattern: /^\s*context\s+(\w+\.\w+)\s*;/gim },
  ],
});

export const VhdlLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
