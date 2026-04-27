/**
 * Verilog / SystemVerilog Language Plugin — regex-based symbol extraction.
 *
 * Comprehensive extraction of:
 *  - Structural: modules, interfaces, programs, packages, classes (with extends/implements)
 *  - Behavioral: functions, tasks (automatic/static/virtual/extern/protected/local)
 *  - Declarations: parameters, localparams, `define macros, typedefs, enums, structs
 *  - Ports & nets: input/output/inout/ref ports, wire/logic/reg declarations
 *  - Generate & always: always_ff/always_comb/always_latch blocks, generate labels, genvar
 *  - Verification: covergroups, constraints, properties, sequences, assertions, checkers
 *  - UVM: `uvm_component_utils`, `uvm_object_utils`, factory-registered classes
 *  - DPI: import "DPI-C" / "DPI" function/task declarations
 *  - Misc: modport, clocking, bind, let, nettype, enum members
 *  - Imports: import pkg::*, `include "file", `include <file>
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'verilog',
  language: 'verilog',
  extensions: ['.v', '.sv', '.svh', '.vh'],
  symbolPatterns: [
    // ═══════════════════════════════════════════════════════════════
    // Structural
    // ═══════════════════════════════════════════════════════════════

    // module [automatic|static] name [#(params)] (ports);
    { kind: 'module', pattern: /^\s*(?:extern\s+)?module\s+(?:automatic\s+|static\s+)?(\w+)/gm },
    // interface [automatic] name
    { kind: 'interface', pattern: /^\s*(?:extern\s+)?interface\s+(?:automatic\s+)?(\w+)/gm },
    // program [automatic] name
    {
      kind: 'module',
      pattern: /^\s*(?:extern\s+)?program\s+(?:automatic\s+)?(\w+)/gm,
      meta: { verilogKind: 'program' },
    },
    // package name
    { kind: 'namespace', pattern: /^\s*package\s+(?:automatic\s+)?(\w+)/gm },
    // class [virtual] [automatic] name [extends parent]
    {
      kind: 'class',
      pattern: /^\s*(?:virtual\s+)?class\s+(?:automatic\s+)?(\w+)(?:\s+extends\s+(\w+))?/gm,
      meta: { verilogKind: 'class' },
    },
    // checker name
    { kind: 'class', pattern: /^\s*checker\s+(\w+)/gm, meta: { verilogKind: 'checker' } },

    // ═══════════════════════════════════════════════════════════════
    // Functions & Tasks
    // ═══════════════════════════════════════════════════════════════

    // function [automatic|static] [return_type] name
    {
      kind: 'function',
      pattern:
        /^\s*(?:extern\s+)?(?:virtual\s+)?(?:protected\s+|local\s+)?(?:static\s+)?function\s+(?:automatic\s+|static\s+)?(?:void\s+|(?:(?:bit|logic|reg|int|integer|real|shortint|longint|byte|shortreal|string|chandle)\s*(?:\[[\w:$\s\-+`]+\]\s*)?)?)?(\w+)\s*[;(]/gm,
    },
    // task [automatic|static] name
    {
      kind: 'function',
      pattern:
        /^\s*(?:extern\s+)?(?:virtual\s+)?(?:protected\s+|local\s+)?(?:static\s+)?task\s+(?:automatic\s+|static\s+)?(\w+)/gm,
      meta: { task: true },
    },

    // ═══════════════════════════════════════════════════════════════
    // Parameters & Constants
    // ═══════════════════════════════════════════════════════════════

    // parameter [type] NAME = value
    {
      kind: 'constant',
      pattern:
        /^\s*parameter\s+(?:(?:bit|logic|reg|int|integer|real|signed|unsigned|shortint|longint|byte)\s*(?:\[[\w:$\s\-+`]+\]\s*)?)?(\w+)\s*=/gm,
      meta: { verilogKind: 'parameter' },
    },
    // localparam [type] NAME = value
    {
      kind: 'constant',
      pattern:
        /^\s*localparam\s+(?:(?:bit|logic|reg|int|integer|real|signed|unsigned|shortint|longint|byte)\s*(?:\[[\w:$\s\-+`]+\]\s*)?)?(\w+)\s*=/gm,
      meta: { verilogKind: 'localparam' },
    },
    // `define NAME
    { kind: 'constant', pattern: /^\s*`define\s+(\w+)/gm, meta: { macro: true } },
    // specparam NAME = value
    {
      kind: 'constant',
      pattern: /^\s*specparam\s+(\w+)\s*=/gm,
      meta: { verilogKind: 'specparam' },
    },

    // ═══════════════════════════════════════════════════════════════
    // Types
    // ═══════════════════════════════════════════════════════════════

    // typedef enum {...} name;
    {
      kind: 'type',
      pattern: /^\s*typedef\s+enum\b[^;]*\}\s*(\w+)\s*;/gm,
      meta: { verilogKind: 'enum' },
    },
    // typedef struct/union [packed] {...} name;
    {
      kind: 'type',
      pattern:
        /^\s*typedef\s+(?:struct|union)\s*(?:packed\s*)?(?:signed\s+|unsigned\s+)?\{[^}]*\}\s*(\w+)\s*;/gm,
    },
    // typedef class name;  (forward declaration)
    { kind: 'type', pattern: /^\s*typedef\s+class\s+(\w+)\s*;/gm },
    // typedef interface class name;  (interface class forward)
    {
      kind: 'type',
      pattern: /^\s*typedef\s+interface\s+class\s+(\w+)\s*;/gm,
      meta: { verilogKind: 'interface_class' },
    },
    // typedef simple_type name; (simple alias — no braces)
    {
      kind: 'type',
      pattern:
        /^\s*typedef\s+(?!enum\b|struct\b|union\b|class\b|interface\b)[\w\s[\]:$`]+?\s+(\w+)\s*;/gm,
    },
    // nettype name  (user-defined net type, SV-2012)
    { kind: 'type', pattern: /^\s*nettype\s+\w+\s+(\w+)/gm, meta: { verilogKind: 'nettype' } },
    // let name = expression  (SV let construct)
    { kind: 'variable', pattern: /^\s*let\s+(\w+)\s*[=(]/gm, meta: { verilogKind: 'let' } },

    // ═══════════════════════════════════════════════════════════════
    // Ports & Net/Variable Declarations
    // ═══════════════════════════════════════════════════════════════

    // input/output/inout [wire|reg|logic] [signed] [range] name
    {
      kind: 'property',
      pattern:
        /^\s*(?:input|output|inout)\s+(?:wire\s+|reg\s+|logic\s+)?(?:signed\s+)?(?:\[[\w:$\s\-+`]+\]\s*)?(\w+)/gm,
      meta: { verilogKind: 'port' },
    },
    // ref [type] name (SystemVerilog pass-by-reference)
    {
      kind: 'property',
      pattern: /^\s*ref\s+(?:\w+\s+)?(\w+)/gm,
      meta: { verilogKind: 'ref_port' },
    },
    // wire [range] name (standalone wire declarations)
    {
      kind: 'variable',
      pattern: /^\s*wire\s+(?:signed\s+)?(?:\[[\w:$\s\-+`]+\]\s*)?(\w+)/gm,
      meta: { verilogKind: 'wire' },
    },
    // reg [range] name
    {
      kind: 'variable',
      pattern: /^\s*reg\s+(?:signed\s+)?(?:\[[\w:$\s\-+`]+\]\s*)?(\w+)/gm,
      meta: { verilogKind: 'reg' },
    },
    // logic [range] name
    {
      kind: 'variable',
      pattern: /^\s*logic\s+(?:signed\s+)?(?:\[[\w:$\s\-+`]+\]\s*)?(\w+)/gm,
      meta: { verilogKind: 'logic' },
    },
    // bit [range] name
    {
      kind: 'variable',
      pattern: /^\s*bit\s+(?:signed\s+)?(?:\[[\w:$\s\-+`]+\]\s*)?(\w+)/gm,
      meta: { verilogKind: 'bit' },
    },
    // integer name
    { kind: 'variable', pattern: /^\s*integer\s+(\w+)/gm, meta: { verilogKind: 'integer' } },
    // real/realtime name
    { kind: 'variable', pattern: /^\s*(?:real|realtime)\s+(\w+)/gm, meta: { verilogKind: 'real' } },
    // time name
    { kind: 'variable', pattern: /^\s*time\s+(\w+)/gm, meta: { verilogKind: 'time' } },

    // ═══════════════════════════════════════════════════════════════
    // Generate & Always Blocks
    // ═══════════════════════════════════════════════════════════════

    // label : begin
    { kind: 'function', pattern: /^\s*(\w+)\s*:\s*begin\b/gm, meta: { verilogKind: 'block' } },
    // genvar name
    { kind: 'variable', pattern: /^\s*genvar\s+(\w+)/gm },
    // label : always_ff @(...)
    {
      kind: 'function',
      pattern: /^\s*(\w+)\s*:\s*always_ff\b/gm,
      meta: { verilogKind: 'always_ff' },
    },
    // label : always_comb
    {
      kind: 'function',
      pattern: /^\s*(\w+)\s*:\s*always_comb\b/gm,
      meta: { verilogKind: 'always_comb' },
    },
    // label : always_latch
    {
      kind: 'function',
      pattern: /^\s*(\w+)\s*:\s*always_latch\b/gm,
      meta: { verilogKind: 'always_latch' },
    },
    // label : always @(...)
    { kind: 'function', pattern: /^\s*(\w+)\s*:\s*always\s*@/gm, meta: { verilogKind: 'always' } },

    // ═══════════════════════════════════════════════════════════════
    // SystemVerilog Verification
    // ═══════════════════════════════════════════════════════════════

    // covergroup name
    { kind: 'class', pattern: /^\s*covergroup\s+(\w+)/gm, meta: { verilogKind: 'covergroup' } },
    // constraint name { ... }
    {
      kind: 'function',
      pattern: /^\s*(?:extern\s+)?constraint\s+(\w+)/gm,
      meta: { verilogKind: 'constraint' },
    },
    // property name
    { kind: 'function', pattern: /^\s*property\s+(\w+)/gm, meta: { verilogKind: 'property' } },
    // sequence name
    { kind: 'function', pattern: /^\s*sequence\s+(\w+)/gm, meta: { verilogKind: 'sequence' } },
    // label : assert property (...)
    {
      kind: 'function',
      pattern: /^\s*(\w+)\s*:\s*assert\s+property\b/gm,
      meta: { verilogKind: 'assertion' },
    },
    // label : assume property (...)
    {
      kind: 'function',
      pattern: /^\s*(\w+)\s*:\s*assume\s+property\b/gm,
      meta: { verilogKind: 'assumption' },
    },
    // label : cover property (...)
    {
      kind: 'function',
      pattern: /^\s*(\w+)\s*:\s*cover\s+property\b/gm,
      meta: { verilogKind: 'cover' },
    },
    // label : cover sequence (...)
    {
      kind: 'function',
      pattern: /^\s*(\w+)\s*:\s*cover\s+sequence\b/gm,
      meta: { verilogKind: 'cover_sequence' },
    },

    // ═══════════════════════════════════════════════════════════════
    // UVM Macros
    // ═══════════════════════════════════════════════════════════════

    // `uvm_component_utils(ClassName)
    {
      kind: 'constant',
      pattern: /^\s*`uvm_component_utils\s*\(\s*(\w+)/gm,
      meta: { verilogKind: 'uvm_component' },
    },
    // `uvm_component_utils_begin(ClassName)
    {
      kind: 'constant',
      pattern: /^\s*`uvm_component_utils_begin\s*\(\s*(\w+)/gm,
      meta: { verilogKind: 'uvm_component' },
    },
    // `uvm_object_utils(ClassName)
    {
      kind: 'constant',
      pattern: /^\s*`uvm_object_utils\s*\(\s*(\w+)/gm,
      meta: { verilogKind: 'uvm_object' },
    },
    // `uvm_object_utils_begin(ClassName)
    {
      kind: 'constant',
      pattern: /^\s*`uvm_object_utils_begin\s*\(\s*(\w+)/gm,
      meta: { verilogKind: 'uvm_object' },
    },
    // `uvm_component_param_utils(ClassName)
    {
      kind: 'constant',
      pattern: /^\s*`uvm_component_param_utils\s*\(\s*(\w+)/gm,
      meta: { verilogKind: 'uvm_component' },
    },
    // `uvm_object_param_utils(ClassName)
    {
      kind: 'constant',
      pattern: /^\s*`uvm_object_param_utils\s*\(\s*(\w+)/gm,
      meta: { verilogKind: 'uvm_object' },
    },
    // `uvm_analysis_imp_decl(_SUFFIX)
    {
      kind: 'constant',
      pattern: /^\s*`uvm_analysis_imp_decl\s*\(\s*_(\w+)/gm,
      meta: { verilogKind: 'uvm_analysis_imp' },
    },

    // ═══════════════════════════════════════════════════════════════
    // DPI (Direct Programming Interface)
    // ═══════════════════════════════════════════════════════════════

    // import "DPI-C" [context|pure] function type name
    {
      kind: 'function',
      pattern: /^\s*import\s+"DPI(?:-C)?"\s+(?:context\s+|pure\s+)?function\s+(?:\w+\s+)?(\w+)/gm,
      meta: { verilogKind: 'dpi_import' },
    },
    // import "DPI-C" [context] task name
    {
      kind: 'function',
      pattern: /^\s*import\s+"DPI(?:-C)?"\s+(?:context\s+)?task\s+(\w+)/gm,
      meta: { verilogKind: 'dpi_import', task: true },
    },
    // export "DPI-C" function name
    {
      kind: 'function',
      pattern: /^\s*export\s+"DPI(?:-C)?"\s+function\s+(\w+)/gm,
      meta: { verilogKind: 'dpi_export' },
    },
    // export "DPI-C" task name
    {
      kind: 'function',
      pattern: /^\s*export\s+"DPI(?:-C)?"\s+task\s+(\w+)/gm,
      meta: { verilogKind: 'dpi_export', task: true },
    },

    // ═══════════════════════════════════════════════════════════════
    // Bind & Instantiation
    // ═══════════════════════════════════════════════════════════════

    // bind target_module bind_module instance_name (...)
    { kind: 'variable', pattern: /^\s*bind\s+(\w+)\s+\w+/gm, meta: { verilogKind: 'bind_target' } },

    // ═══════════════════════════════════════════════════════════════
    // Instantiation helpers
    // ═══════════════════════════════════════════════════════════════

    // modport name (inside interface)
    { kind: 'interface', pattern: /^\s*modport\s+(\w+)/gm, meta: { verilogKind: 'modport' } },
    // clocking name
    {
      kind: 'class',
      pattern: /^\s*(?:default\s+)?clocking\s+(\w+)/gm,
      meta: { verilogKind: 'clocking' },
    },

    // ═══════════════════════════════════════════════════════════════
    // Enum members (standalone enum)
    // ═══════════════════════════════════════════════════════════════

    // enum type_name name;
    { kind: 'variable', pattern: /^\s*enum\s+\w+\s+(\w+)\s*;/gm },
  ],
  importPatterns: [
    // import pkg::*; or import pkg::name;
    { pattern: /^\s*import\s+([\w]+)::/gm },
    // `include "file"
    { pattern: /^\s*`include\s+"([^"]+)"/gm },
    // `include <file>
    { pattern: /^\s*`include\s+<([^>]+)>/gm },
  ],
});

export const VerilogLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
