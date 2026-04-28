/**
 * Tests for HDL (Hardware Description Language) plugins:
 * - Arduino (.ino/.pde via C++ plugin)
 * - VHDL
 * - Verilog / SystemVerilog (upgraded)
 */
import { describe, expect, it } from 'vitest';
import { CppLanguagePlugin } from '../../src/indexer/plugins/language/cpp/index.js';
import { VerilogLanguagePlugin } from '../../src/indexer/plugins/language/verilog/index.js';
import { VhdlLanguagePlugin } from '../../src/indexer/plugins/language/vhdl/index.js';

// ══════════════════════════════════════════════════════════════════════════════
// Arduino (.ino/.pde via C++ plugin)
// ══════════════════════════════════════════════════════════════════════════════

const cppPlugin = new CppLanguagePlugin();
async function parseArduino(source: string, filePath = 'sketch.ino') {
  const result = await cppPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('Arduino (.ino/.pde via CppLanguagePlugin)', () => {
  it('supports .ino and .pde extensions', () => {
    expect(cppPlugin.supportedExtensions).toContain('.ino');
    expect(cppPlugin.supportedExtensions).toContain('.pde');
  });

  it('extracts setup() and loop() functions', async () => {
    const r = await parseArduino(`
void setup() {
  Serial.begin(9600);
}

void loop() {
  delay(1000);
}
`);
    expect(r.symbols.some((s: any) => s.name === 'setup' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'loop' && s.kind === 'function')).toBe(true);
  });

  it('extracts classes (Arduino libraries)', async () => {
    const r = await parseArduino(`
class MotorController {
public:
  void start(int pin) {}
  void setSpeed(int speed) {}
private:
  int _pin;
  int _speed;
};
`);
    expect(r.symbols.some((s: any) => s.name === 'MotorController' && s.kind === 'class')).toBe(
      true,
    );
    expect(r.symbols.some((s: any) => s.name === 'start' && s.kind === 'method')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'setSpeed' && s.kind === 'method')).toBe(true);
  });

  it('extracts #define constants', async () => {
    const r = await parseArduino(`
#define LED_PIN 13
#define BAUD_RATE 9600
`);
    expect(r.symbols.some((s: any) => s.name === 'LED_PIN' && s.kind === 'constant')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'BAUD_RATE' && s.kind === 'constant')).toBe(true);
  });

  it('extracts enums', async () => {
    const r = await parseArduino(`
enum MotorState {
  STOPPED,
  RUNNING,
  ERROR
};
`);
    expect(r.symbols.some((s: any) => s.name === 'MotorState' && s.kind === 'enum')).toBe(true);
  });

  it('extracts ISR callbacks and helper functions', async () => {
    const r = await parseArduino(`
volatile int counter = 0;

void handleInterrupt() {
  counter++;
}

int readSensor(int pin) {
  return analogRead(pin);
}
`);
    expect(r.symbols.some((s: any) => s.name === 'handleInterrupt' && s.kind === 'function')).toBe(
      true,
    );
    expect(r.symbols.some((s: any) => s.name === 'readSensor' && s.kind === 'function')).toBe(true);
  });

  it('extracts #include edges', async () => {
    const r = await parseArduino(`
#include <Wire.h>
#include <SPI.h>
#include "MyLibrary.h"
`);
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e: any) => e.edgeType === 'imports');
    const modules = imports.map((e: any) => e.metadata?.module);
    expect(modules).toContain('Wire.h');
    expect(modules).toContain('SPI.h');
    expect(modules).toContain('MyLibrary.h');
  });

  it('extracts template classes (Arduino advanced)', async () => {
    const r = await parseArduino(`
template <typename T, int SIZE>
class RingBuffer {
public:
  void push(T value);
  T pop();
private:
  T buffer[SIZE];
  int head = 0;
};
`);
    expect(r.symbols.some((s: any) => s.name === 'RingBuffer' && s.kind === 'class')).toBe(true);
  });

  it('parses .pde files identically', async () => {
    const r = await parseArduino('void setup() {}\nvoid loop() {}', 'sketch.pde');
    expect(r.symbols.some((s: any) => s.name === 'setup')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'loop')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// VHDL
// ══════════════════════════════════════════════════════════════════════════════

const vhdlPlugin = new VhdlLanguagePlugin();
function parseVhdl(source: string, filePath = 'design.vhd') {
  const result = vhdlPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('VhdlLanguagePlugin', () => {
  it('has correct manifest and extensions', () => {
    expect(vhdlPlugin.manifest.name).toBe('vhdl-language');
    expect(vhdlPlugin.supportedExtensions).toContain('.vhd');
    expect(vhdlPlugin.supportedExtensions).toContain('.vhdl');
    expect(vhdlPlugin.supportedExtensions).toContain('.vho');
    expect(vhdlPlugin.supportedExtensions).toContain('.vhs');
  });

  // ── Entities & Architectures ─────────────────────────────────

  it('extracts entity declaration', () => {
    const r = parseVhdl(`
entity counter is
  port (
    clk   : in  std_logic;
    reset : in  std_logic;
    count : out std_logic_vector(7 downto 0)
  );
end entity counter;
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'counter' && s.kind === 'class' && s.metadata?.vhdlKind === 'entity',
      ),
    ).toBe(true);
  });

  it('extracts architecture', () => {
    const r = parseVhdl(`
architecture behavioral of counter is
begin
end architecture behavioral;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'behavioral' && s.kind === 'class' && s.metadata?.vhdlKind === 'architecture',
      ),
    ).toBe(true);
  });

  // ── Packages ─────────────────────────────────────────────────

  it('extracts package', () => {
    const r = parseVhdl(`
package math_pkg is
  constant PI : real := 3.14159;
end package math_pkg;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'math_pkg' && s.kind === 'namespace' && s.metadata?.vhdlKind === 'package',
      ),
    ).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'PI' && s.kind === 'constant')).toBe(true);
  });

  it('extracts package body', () => {
    const r = parseVhdl(`
package body utils_pkg is
end package body utils_pkg;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'utils_pkg' &&
          s.kind === 'namespace' &&
          s.metadata?.vhdlKind === 'package_body',
      ),
    ).toBe(true);
  });

  // ── Processes ────────────────────────────────────────────────

  it('extracts labeled process', () => {
    const r = parseVhdl(`
clk_proc : process(clk)
begin
  if rising_edge(clk) then
    count <= count + 1;
  end if;
end process;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'clk_proc' && s.kind === 'function' && s.metadata?.vhdlKind === 'process',
      ),
    ).toBe(true);
  });

  it('extracts postponed process', () => {
    const r = parseVhdl(`
check_proc : postponed process(clk)
begin
end process;
`);
    expect(
      r.symbols.some((s: any) => s.name === 'check_proc' && s.metadata?.vhdlKind === 'process'),
    ).toBe(true);
  });

  // ── Functions & Procedures ───────────────────────────────────

  it('extracts function', () => {
    const r = parseVhdl(`
function to_integer(val : std_logic_vector) return integer is
begin
  return 0;
end function;
`);
    expect(r.symbols.some((s: any) => s.name === 'to_integer' && s.kind === 'function')).toBe(true);
  });

  it('extracts pure and impure functions', () => {
    const r = parseVhdl(`
pure function add(a, b : integer) return integer is
begin
  return a + b;
end function;

impure function get_random return integer is
begin
  return 42;
end function;
`);
    expect(r.symbols.some((s: any) => s.name === 'add' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'get_random' && s.kind === 'function')).toBe(true);
  });

  it('extracts procedure', () => {
    const r = parseVhdl(`
procedure reset_counter(signal cnt : out integer) is
begin
  cnt <= 0;
end procedure;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'reset_counter' &&
          s.kind === 'function' &&
          s.metadata?.vhdlKind === 'procedure',
      ),
    ).toBe(true);
  });

  // ── Components ───────────────────────────────────────────────

  it('extracts component declaration', () => {
    const r = parseVhdl(`
component full_adder is
  port (
    a, b, cin  : in  std_logic;
    sum, cout  : out std_logic
  );
end component;
`);
    expect(r.symbols.some((s: any) => s.name === 'full_adder' && s.kind === 'interface')).toBe(
      true,
    );
  });

  // ── Signals, Constants, Variables ────────────────────────────

  it('extracts signals', () => {
    const r = parseVhdl(`
signal clk        : std_logic;
signal data_bus   : std_logic_vector(7 downto 0);
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'clk' && s.kind === 'property' && s.metadata?.vhdlKind === 'signal',
      ),
    ).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'data_bus' && s.kind === 'property')).toBe(true);
  });

  it('extracts constants', () => {
    const r = parseVhdl(`
constant CLK_PERIOD : time := 10 ns;
constant DATA_WIDTH : integer := 8;
`);
    expect(r.symbols.some((s: any) => s.name === 'CLK_PERIOD' && s.kind === 'constant')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'DATA_WIDTH' && s.kind === 'constant')).toBe(true);
  });

  it('extracts variables and shared variables', () => {
    const r = parseVhdl(`
variable temp : integer := 0;
shared variable mem : mem_type;
`);
    expect(r.symbols.some((s: any) => s.name === 'temp' && s.kind === 'variable')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'mem' && s.kind === 'variable')).toBe(true);
  });

  // ── Types & Subtypes ─────────────────────────────────────────

  it('extracts type declarations', () => {
    const r = parseVhdl(`
type state_type is (IDLE, RUNNING, DONE);
type mem_type is array (0 to 255) of std_logic_vector(7 downto 0);
`);
    expect(r.symbols.some((s: any) => s.name === 'state_type' && s.kind === 'type')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'mem_type' && s.kind === 'type')).toBe(true);
  });

  it('extracts subtype declarations', () => {
    const r = parseVhdl(`
subtype byte is std_logic_vector(7 downto 0);
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'byte' && s.kind === 'type' && s.metadata?.vhdlKind === 'subtype',
      ),
    ).toBe(true);
  });

  // ── Aliases & Attributes ─────────────────────────────────────

  it('extracts alias', () => {
    const r = parseVhdl(`
alias data_hi is data_bus(7 downto 4);
`);
    expect(
      r.symbols.some((s: any) => s.name === 'data_hi' && s.metadata?.vhdlKind === 'alias'),
    ).toBe(true);
  });

  it('extracts attribute', () => {
    const r = parseVhdl(`
attribute keep : boolean;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'keep' && s.kind === 'property' && s.metadata?.vhdlKind === 'attribute',
      ),
    ).toBe(true);
  });

  // ── Generate blocks ──────────────────────────────────────────

  it('extracts for-generate block', () => {
    const r = parseVhdl(`
gen_adders : for i in 0 to 7 generate
end generate;
`);
    expect(
      r.symbols.some((s: any) => s.name === 'gen_adders' && s.metadata?.vhdlKind === 'generate'),
    ).toBe(true);
  });

  it('extracts if-generate block', () => {
    const r = parseVhdl(`
gen_debug : if DEBUG = true generate
end generate;
`);
    expect(
      r.symbols.some((s: any) => s.name === 'gen_debug' && s.metadata?.vhdlKind === 'generate'),
    ).toBe(true);
  });

  // ── Configuration ────────────────────────────────────────────

  it('extracts configuration', () => {
    const r = parseVhdl(`
configuration default_cfg of top_entity is
  for structural
  end for;
end configuration;
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'default_cfg' && s.metadata?.vhdlKind === 'configuration',
      ),
    ).toBe(true);
  });

  // ── Imports ──────────────────────────────────────────────────

  it('extracts library and use clauses', () => {
    const r = parseVhdl(`
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
`);
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e: any) => e.edgeType === 'imports');
    const modules = imports.map((e: any) => e.metadata?.module);
    expect(modules).toContain('ieee');
    expect(modules).toContain('ieee.std_logic_1164.all');
    expect(modules).toContain('ieee.numeric_std.all');
  });

  it('skips work library', () => {
    const r = parseVhdl(`
library work;
use work.my_pkg.all;
`);
    const imports = (r.edges ?? []).filter((e: any) => e.edgeType === 'imports');
    const modules = imports.map((e: any) => e.metadata?.module);
    expect(modules).not.toContain('work');
    expect(modules).not.toContain('work.my_pkg.all');
  });

  // ── Context declarations (VHDL-2008) ──────────────────────────

  it('extracts context declaration (VHDL-2008)', () => {
    const r = parseVhdl(`
context project_ctx is
  library ieee;
  use ieee.std_logic_1164.all;
end context project_ctx;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'project_ctx' && s.kind === 'namespace' && s.metadata?.vhdlKind === 'context',
      ),
    ).toBe(true);
  });

  it('extracts context reference import (VHDL-2008)', () => {
    const r = parseVhdl(`
context work.project_ctx;
`);
    const imports = (r.edges ?? []).filter((e: any) => e.edgeType === 'imports');
    const modules = imports.map((e: any) => e.metadata?.module);
    expect(modules).toContain('work.project_ctx');
  });

  // ── Protected types (VHDL-2000) ──────────────────────────────

  it('extracts protected type', () => {
    const r = parseVhdl(`
type shared_counter is protected
end protected shared_counter;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'shared_counter' &&
          s.kind === 'class' &&
          s.metadata?.vhdlKind === 'protected_type',
      ),
    ).toBe(true);
  });

  it('extracts protected body', () => {
    const r = parseVhdl(`
type shared_counter is protected body
end protected body shared_counter;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'shared_counter' &&
          s.kind === 'class' &&
          s.metadata?.vhdlKind === 'protected_body',
      ),
    ).toBe(true);
  });

  // ── File declarations ────────────────────────────────────────

  it('extracts file declarations', () => {
    const r = parseVhdl(`
file input_file : text open read_mode is "data.txt";
`);
    expect(
      r.symbols.some((s: any) => s.name === 'input_file' && s.metadata?.vhdlKind === 'file'),
    ).toBe(true);
  });

  // ── Block statements ─────────────────────────────────────────

  it('extracts block statement', () => {
    const r = parseVhdl(`
data_path : block
begin
end block data_path;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'data_path' && s.kind === 'function' && s.metadata?.vhdlKind === 'block',
      ),
    ).toBe(true);
  });

  // ── Case-generate (VHDL-2008) ────────────────────────────────

  it('extracts case-generate (VHDL-2008)', () => {
    const r = parseVhdl(`
gen_mux : case SEL generate
  when 0 =>
  when 1 =>
end generate gen_mux;
`);
    expect(
      r.symbols.some((s: any) => s.name === 'gen_mux' && s.metadata?.vhdlKind === 'case_generate'),
    ).toBe(true);
  });

  // ── Incomplete types ─────────────────────────────────────────

  it('extracts incomplete type declaration', () => {
    const r = parseVhdl(`
type node;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'node' && s.kind === 'type' && s.metadata?.vhdlKind === 'incomplete_type',
      ),
    ).toBe(true);
  });

  // ── Group & disconnect ───────────────────────────────────────

  it('extracts group declaration', () => {
    const r = parseVhdl(`
group timing_group : signal_group (clk, reset);
`);
    expect(
      r.symbols.some((s: any) => s.name === 'timing_group' && s.metadata?.vhdlKind === 'group'),
    ).toBe(true);
  });

  // ── VHDL-AMS ─────────────────────────────────────────────────

  it('extracts nature and terminal (VHDL-AMS)', () => {
    const r = parseVhdl(`
nature electrical is real across real through;
terminal p, n : electrical;
quantity v across i through p to n;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'electrical' && s.kind === 'type' && s.metadata?.vhdlKind === 'nature',
      ),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'p' && s.kind === 'property' && s.metadata?.vhdlKind === 'terminal',
      ),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'v' && s.kind === 'variable' && s.metadata?.vhdlKind === 'quantity',
      ),
    ).toBe(true);
  });

  // ── Concurrent assertion ─────────────────────────────────────

  it('extracts concurrent assertion label', () => {
    const r = parseVhdl(`
check_clk : assert clk = '1' report "Clock low" severity warning;
`);
    expect(
      r.symbols.some((s: any) => s.name === 'check_clk' && s.metadata?.vhdlKind === 'assertion'),
    ).toBe(true);
  });

  // ── Complete design example ──────────────────────────────────

  it('handles a complete design with multiple constructs', () => {
    const r = parseVhdl(`
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity alu is
  generic (
    WIDTH : integer := 8
  );
  port (
    clk    : in  std_logic;
    op     : in  std_logic_vector(1 downto 0);
    a, b   : in  std_logic_vector(WIDTH-1 downto 0);
    result : out std_logic_vector(WIDTH-1 downto 0)
  );
end entity alu;

architecture rtl of alu is
  signal temp : std_logic_vector(WIDTH-1 downto 0);
  constant ZERO : std_logic_vector(WIDTH-1 downto 0) := (others => '0');
begin
  compute : process(clk)
  begin
    if rising_edge(clk) then
      case op is
        when "00" => temp <= a + b;
        when "01" => temp <= a - b;
        when others => temp <= ZERO;
      end case;
    end if;
  end process;
  result <= temp;
end architecture rtl;
`);
    // Entity
    expect(r.symbols.some((s: any) => s.name === 'alu' && s.metadata?.vhdlKind === 'entity')).toBe(
      true,
    );
    // Architecture
    expect(
      r.symbols.some((s: any) => s.name === 'rtl' && s.metadata?.vhdlKind === 'architecture'),
    ).toBe(true);
    // Signal
    expect(r.symbols.some((s: any) => s.name === 'temp' && s.metadata?.vhdlKind === 'signal')).toBe(
      true,
    );
    // Constant
    expect(r.symbols.some((s: any) => s.name === 'ZERO' && s.kind === 'constant')).toBe(true);
    // Process
    expect(
      r.symbols.some((s: any) => s.name === 'compute' && s.metadata?.vhdlKind === 'process'),
    ).toBe(true);
    // Imports
    expect(r.edges!.length).toBeGreaterThanOrEqual(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Verilog / SystemVerilog (upgraded)
// ══════════════════════════════════════════════════════════════════════════════

const verilogPlugin = new VerilogLanguagePlugin();
function parseVerilog(source: string, filePath = 'design.sv') {
  const result = verilogPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('VerilogLanguagePlugin (upgraded)', () => {
  it('has correct manifest and extensions', () => {
    expect(verilogPlugin.manifest.name).toBe('verilog-language');
    expect(verilogPlugin.supportedExtensions).toEqual(['.v', '.sv', '.svh', '.vh']);
  });

  // ── Basic module/interface ───────────────────────────────────

  it('extracts module', () => {
    const r = parseVerilog(`
module counter (
  input wire clk,
  input wire reset,
  output reg [7:0] count
);
endmodule
`);
    expect(r.symbols.some((s: any) => s.name === 'counter' && s.kind === 'module')).toBe(true);
  });

  it('extracts module with automatic qualifier', () => {
    const r = parseVerilog('module automatic my_mod;\nendmodule');
    expect(r.symbols.some((s: any) => s.name === 'my_mod' && s.kind === 'module')).toBe(true);
  });

  it('extracts interface', () => {
    const r = parseVerilog(`
interface axi_if;
  logic [31:0] awaddr;
  modport master(output awaddr);
  modport slave(input awaddr);
endinterface
`);
    expect(r.symbols.some((s: any) => s.name === 'axi_if' && s.kind === 'interface')).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'master' && s.metadata?.verilogKind === 'modport'),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'slave' && s.metadata?.verilogKind === 'modport'),
    ).toBe(true);
  });

  it('extracts program block', () => {
    const r = parseVerilog('program automatic test_prog;\nendprogram');
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'test_prog' && s.kind === 'module' && s.metadata?.verilogKind === 'program',
      ),
    ).toBe(true);
  });

  // ── Classes ──────────────────────────────────────────────────

  it('extracts class and virtual class', () => {
    const r = parseVerilog(`
class Transaction;
  rand bit [7:0] data;
endclass

virtual class BaseTest;
endclass
`);
    expect(r.symbols.some((s: any) => s.name === 'Transaction' && s.kind === 'class')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'BaseTest' && s.kind === 'class')).toBe(true);
  });

  // ── Functions & Tasks ────────────────────────────────────────

  it('extracts function with automatic qualifier', () => {
    const r = parseVerilog('function automatic void reset_all;\nendfunction');
    expect(r.symbols.some((s: any) => s.name === 'reset_all' && s.kind === 'function')).toBe(true);
  });

  it('extracts function with static qualifier', () => {
    const r = parseVerilog('function static int get_count;\nendfunction');
    expect(r.symbols.some((s: any) => s.name === 'get_count' && s.kind === 'function')).toBe(true);
  });

  it('extracts task with automatic qualifier', () => {
    const r = parseVerilog('task automatic drive_data;\nendtask');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'drive_data' && s.kind === 'function' && s.metadata?.task === true,
      ),
    ).toBe(true);
  });

  it('extracts protected/local methods', () => {
    const r = parseVerilog(`
protected function void do_work;
endfunction

local task helper_task;
endtask
`);
    expect(r.symbols.some((s: any) => s.name === 'do_work' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'helper_task' && s.kind === 'function')).toBe(
      true,
    );
  });

  it('extracts extern function', () => {
    const r = parseVerilog('extern function void init;');
    expect(r.symbols.some((s: any) => s.name === 'init' && s.kind === 'function')).toBe(true);
  });

  // ── Parameters ───────────────────────────────────────────────

  it('extracts parameter and localparam', () => {
    const r = parseVerilog(`
parameter DATA_WIDTH = 32;
localparam ADDR_WIDTH = 16;
parameter integer DEPTH = 256;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'DATA_WIDTH' &&
          s.kind === 'constant' &&
          s.metadata?.verilogKind === 'parameter',
      ),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'ADDR_WIDTH' &&
          s.kind === 'constant' &&
          s.metadata?.verilogKind === 'localparam',
      ),
    ).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'DEPTH' && s.kind === 'constant')).toBe(true);
  });

  it('extracts `define macros', () => {
    const r = parseVerilog(`
\`define MAX_SIZE 1024
\`define ASSERT(cond) if (!(cond)) $error("fail")
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'MAX_SIZE' && s.kind === 'constant' && s.metadata?.macro === true,
      ),
    ).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'ASSERT' && s.kind === 'constant')).toBe(true);
  });

  // ── Typedefs ─────────────────────────────────────────────────

  it('extracts typedef enum', () => {
    const r = parseVerilog(`
typedef enum logic [1:0] {
  IDLE  = 2'b00,
  RUN   = 2'b01,
  DONE  = 2'b10
} state_t;
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'state_t' && s.kind === 'type' && s.metadata?.verilogKind === 'enum',
      ),
    ).toBe(true);
  });

  it('extracts typedef struct', () => {
    const r = parseVerilog(`
typedef struct packed {
  logic [31:0] addr;
  logic [31:0] data;
  logic        valid;
} bus_req_t;
`);
    expect(r.symbols.some((s: any) => s.name === 'bus_req_t' && s.kind === 'type')).toBe(true);
  });

  it('extracts simple typedef alias', () => {
    const r = parseVerilog('typedef logic [7:0] byte_t;');
    expect(r.symbols.some((s: any) => s.name === 'byte_t' && s.kind === 'type')).toBe(true);
  });

  it('extracts typedef class forward declaration', () => {
    const r = parseVerilog('typedef class my_trans;');
    expect(r.symbols.some((s: any) => s.name === 'my_trans' && s.kind === 'type')).toBe(true);
  });

  // ── Ports ────────────────────────────────────────────────────

  it('extracts input/output/inout ports', () => {
    const r = parseVerilog(`
input wire clk,
output reg [7:0] data_out,
inout wire data_bus
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'clk' && s.kind === 'property' && s.metadata?.verilogKind === 'port',
      ),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'data_out' && s.metadata?.verilogKind === 'port'),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'data_bus' && s.metadata?.verilogKind === 'port'),
    ).toBe(true);
  });

  // ── SystemVerilog Verification ───────────────────────────────

  it('extracts covergroup', () => {
    const r = parseVerilog('covergroup cg_addr;\nendgroup');
    expect(
      r.symbols.some((s: any) => s.name === 'cg_addr' && s.metadata?.verilogKind === 'covergroup'),
    ).toBe(true);
  });

  it('extracts constraint', () => {
    const r = parseVerilog('constraint c_data { data inside {[0:255]}; }');
    expect(
      r.symbols.some((s: any) => s.name === 'c_data' && s.metadata?.verilogKind === 'constraint'),
    ).toBe(true);
  });

  it('extracts property and sequence', () => {
    const r = parseVerilog(`
property p_handshake;
  @(posedge clk) req |-> ##[1:3] ack;
endproperty

sequence s_burst;
  req ##1 data[*4];
endsequence
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'p_handshake' && s.metadata?.verilogKind === 'property',
      ),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 's_burst' && s.metadata?.verilogKind === 'sequence'),
    ).toBe(true);
  });

  it('extracts clocking block', () => {
    const r = parseVerilog('default clocking cb_main @(posedge clk);\nendclocking');
    expect(
      r.symbols.some((s: any) => s.name === 'cb_main' && s.metadata?.verilogKind === 'clocking'),
    ).toBe(true);
  });

  // ── Imports ──────────────────────────────────────────────────

  it('extracts import edges', () => {
    const r = parseVerilog(`
import uvm_pkg::*;
import my_pkg::my_class;
`);
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e: any) => e.edgeType === 'imports');
    const modules = imports.map((e: any) => e.metadata?.module);
    expect(modules).toContain('uvm_pkg');
    expect(modules).toContain('my_pkg');
  });

  it('extracts `include edges', () => {
    const r = parseVerilog(`
\`include "uvm_macros.svh"
\`include <my_header.vh>
`);
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e: any) => e.edgeType === 'imports');
    const modules = imports.map((e: any) => e.metadata?.module);
    expect(modules).toContain('uvm_macros.svh');
    expect(modules).toContain('my_header.vh');
  });

  // ── Package ──────────────────────────────────────────────────

  it('extracts package', () => {
    const r = parseVerilog(`
package my_types;
  typedef enum { A, B, C } abc_t;
  parameter int WIDTH = 32;
endpackage
`);
    expect(r.symbols.some((s: any) => s.name === 'my_types' && s.kind === 'namespace')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'abc_t' && s.kind === 'type')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'WIDTH' && s.kind === 'constant')).toBe(true);
  });

  // ── Generate ─────────────────────────────────────────────────

  it('extracts genvar', () => {
    const r = parseVerilog('genvar i;');
    expect(r.symbols.some((s: any) => s.name === 'i' && s.kind === 'variable')).toBe(true);
  });

  it('extracts labeled begin block', () => {
    const r = parseVerilog('gen_loop : begin\nend');
    expect(
      r.symbols.some((s: any) => s.name === 'gen_loop' && s.metadata?.verilogKind === 'block'),
    ).toBe(true);
  });

  // ── Checker ──────────────────────────────────────────────────

  it('extracts checker block', () => {
    const r = parseVerilog('checker my_checker;\nendchecker');
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'my_checker' && s.kind === 'class' && s.metadata?.verilogKind === 'checker',
      ),
    ).toBe(true);
  });

  // ── Wire/Logic/Reg declarations ─────────────────────────────

  it('extracts wire declarations', () => {
    const r = parseVerilog(`
wire [7:0] data_bus;
wire enable;
`);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'data_bus' && s.kind === 'variable' && s.metadata?.verilogKind === 'wire',
      ),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'enable' && s.metadata?.verilogKind === 'wire'),
    ).toBe(true);
  });

  it('extracts logic declarations', () => {
    const r = parseVerilog(`
logic [31:0] addr;
logic valid;
`);
    expect(
      r.symbols.some((s: any) => s.name === 'addr' && s.metadata?.verilogKind === 'logic'),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'valid' && s.metadata?.verilogKind === 'logic'),
    ).toBe(true);
  });

  it('extracts reg declarations', () => {
    const r = parseVerilog('reg [3:0] state;');
    expect(
      r.symbols.some((s: any) => s.name === 'state' && s.metadata?.verilogKind === 'reg'),
    ).toBe(true);
  });

  it('extracts integer and real declarations', () => {
    const r = parseVerilog(`
integer count;
real voltage;
`);
    expect(
      r.symbols.some((s: any) => s.name === 'count' && s.metadata?.verilogKind === 'integer'),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'voltage' && s.metadata?.verilogKind === 'real'),
    ).toBe(true);
  });

  // ── Always blocks (labeled) ─────────────────────────────────

  it('extracts labeled always_ff block', () => {
    const r = parseVerilog('ff_proc : always_ff @(posedge clk)');
    expect(
      r.symbols.some((s: any) => s.name === 'ff_proc' && s.metadata?.verilogKind === 'always_ff'),
    ).toBe(true);
  });

  it('extracts labeled always_comb block', () => {
    const r = parseVerilog('comb_logic : always_comb');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'comb_logic' && s.metadata?.verilogKind === 'always_comb',
      ),
    ).toBe(true);
  });

  it('extracts labeled always_latch block', () => {
    const r = parseVerilog('latch_proc : always_latch');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'latch_proc' && s.metadata?.verilogKind === 'always_latch',
      ),
    ).toBe(true);
  });

  it('extracts labeled always @(...) block', () => {
    const r = parseVerilog('sens_proc : always @(posedge clk or negedge rst)');
    expect(
      r.symbols.some((s: any) => s.name === 'sens_proc' && s.metadata?.verilogKind === 'always'),
    ).toBe(true);
  });

  // ── Assertions ──────────────────────────────────────────────

  it('extracts labeled assert property', () => {
    const r = parseVerilog('a_req_ack : assert property (p_handshake);');
    expect(
      r.symbols.some((s: any) => s.name === 'a_req_ack' && s.metadata?.verilogKind === 'assertion'),
    ).toBe(true);
  });

  it('extracts labeled assume and cover property', () => {
    const r = parseVerilog(`
a_valid_input : assume property (@(posedge clk) valid |-> !$isunknown(data));
c_burst_seen : cover property (@(posedge clk) s_burst);
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'a_valid_input' && s.metadata?.verilogKind === 'assumption',
      ),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'c_burst_seen' && s.metadata?.verilogKind === 'cover'),
    ).toBe(true);
  });

  it('extracts labeled cover sequence', () => {
    const r = parseVerilog('c_seq : cover sequence (s_burst);');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'c_seq' && s.metadata?.verilogKind === 'cover_sequence',
      ),
    ).toBe(true);
  });

  // ── UVM macros ──────────────────────────────────────────────

  it('extracts `uvm_component_utils', () => {
    const r = parseVerilog('`uvm_component_utils(my_driver)');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my_driver' && s.metadata?.verilogKind === 'uvm_component',
      ),
    ).toBe(true);
  });

  it('extracts `uvm_object_utils', () => {
    const r = parseVerilog('`uvm_object_utils(my_transaction)');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my_transaction' && s.metadata?.verilogKind === 'uvm_object',
      ),
    ).toBe(true);
  });

  it('extracts `uvm_component_utils_begin', () => {
    const r = parseVerilog('`uvm_component_utils_begin(my_agent)');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my_agent' && s.metadata?.verilogKind === 'uvm_component',
      ),
    ).toBe(true);
  });

  it('extracts `uvm_object_utils_begin', () => {
    const r = parseVerilog('`uvm_object_utils_begin(my_seq_item)');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my_seq_item' && s.metadata?.verilogKind === 'uvm_object',
      ),
    ).toBe(true);
  });

  it('extracts param variants of UVM macros', () => {
    const r = parseVerilog(`
\`uvm_component_param_utils(my_param_comp)
\`uvm_object_param_utils(my_param_obj)
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my_param_comp' && s.metadata?.verilogKind === 'uvm_component',
      ),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my_param_obj' && s.metadata?.verilogKind === 'uvm_object',
      ),
    ).toBe(true);
  });

  // ── DPI-C ───────────────────────────────────────────────────

  it('extracts DPI-C import function', () => {
    const r = parseVerilog('import "DPI-C" function int c_compute(int a, int b);');
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'c_compute' &&
          s.kind === 'function' &&
          s.metadata?.verilogKind === 'dpi_import',
      ),
    ).toBe(true);
  });

  it('extracts DPI-C import task', () => {
    const r = parseVerilog('import "DPI-C" context task c_wait(int cycles);');
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'c_wait' &&
          s.kind === 'function' &&
          s.metadata?.verilogKind === 'dpi_import' &&
          s.metadata?.task === true,
      ),
    ).toBe(true);
  });

  it('extracts DPI-C pure function', () => {
    const r = parseVerilog('import "DPI-C" pure function int c_abs(int val);');
    expect(
      r.symbols.some((s: any) => s.name === 'c_abs' && s.metadata?.verilogKind === 'dpi_import'),
    ).toBe(true);
  });

  it('extracts DPI-C export', () => {
    const r = parseVerilog(`
export "DPI-C" function sv_callback;
export "DPI-C" task sv_work;
`);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'sv_callback' && s.metadata?.verilogKind === 'dpi_export',
      ),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'sv_work' &&
          s.metadata?.verilogKind === 'dpi_export' &&
          s.metadata?.task === true,
      ),
    ).toBe(true);
  });

  it('extracts DPI (without -C) import', () => {
    const r = parseVerilog('import "DPI" function void legacy_fn;');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'legacy_fn' && s.metadata?.verilogKind === 'dpi_import',
      ),
    ).toBe(true);
  });

  // ── Bind ────────────────────────────────────────────────────

  it('extracts bind statement target', () => {
    const r = parseVerilog('bind cpu_core checker_mod chk_inst (.*);');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'cpu_core' && s.metadata?.verilogKind === 'bind_target',
      ),
    ).toBe(true);
  });

  // ── Specparam ───────────────────────────────────────────────

  it('extracts specparam', () => {
    const r = parseVerilog('specparam tRISE = 2.5;');
    expect(
      r.symbols.some(
        (s: any) =>
          s.name === 'tRISE' && s.kind === 'constant' && s.metadata?.verilogKind === 'specparam',
      ),
    ).toBe(true);
  });

  // ── Let construct ───────────────────────────────────────────

  it('extracts let declaration', () => {
    const r = parseVerilog('let max(a, b) = (a > b) ? a : b;');
    expect(r.symbols.some((s: any) => s.name === 'max' && s.metadata?.verilogKind === 'let')).toBe(
      true,
    );
  });

  // ── Complete SV design example ───────────────────────────────

  it('handles a complete SystemVerilog testbench', () => {
    const r = parseVerilog(`
\`include "uvm_macros.svh"
import uvm_pkg::*;

class my_transaction extends uvm_sequence_item;
  rand bit [7:0] data;
  rand bit [3:0] addr;

  constraint c_addr { addr inside {[0:15]}; }

  function void display;
    $display("addr=%0h data=%0h", addr, data);
  endfunction
endclass

module tb_top;
  parameter CLK_PERIOD = 10;

  logic clk = 0;
  always #(CLK_PERIOD/2) clk = ~clk;

  initial begin
    run_test("my_test");
  end
endmodule
`);
    // Class
    expect(r.symbols.some((s: any) => s.name === 'my_transaction' && s.kind === 'class')).toBe(
      true,
    );
    // Constraint
    expect(
      r.symbols.some((s: any) => s.name === 'c_addr' && s.metadata?.verilogKind === 'constraint'),
    ).toBe(true);
    // Function
    expect(r.symbols.some((s: any) => s.name === 'display' && s.kind === 'function')).toBe(true);
    // Module
    expect(r.symbols.some((s: any) => s.name === 'tb_top' && s.kind === 'module')).toBe(true);
    // Parameter
    expect(r.symbols.some((s: any) => s.name === 'CLK_PERIOD' && s.kind === 'constant')).toBe(true);
    // Include + import
    expect(r.edges!.length).toBeGreaterThanOrEqual(2);
  });

  // ── Complete UVM testbench example ───────────────────────────

  it('handles a full UVM testbench with DPI, assertions, and macros', () => {
    const r = parseVerilog(`
\`include "uvm_macros.svh"
import uvm_pkg::*;

import "DPI-C" pure function int c_golden_model(int a, int b);
export "DPI-C" function sv_get_status;

checker protocol_checker(logic clk, logic req, logic ack);
  property p_req_ack;
    @(posedge clk) req |-> ##[1:5] ack;
  endproperty
  a_check : assert property (p_req_ack);
endchecker

class my_driver extends uvm_driver;
  \`uvm_component_utils(my_driver)

  constraint c_valid { data > 0; }

  function void build_phase(uvm_phase phase);
    super.build_phase(phase);
  endfunction

  task automatic run_phase(uvm_phase phase);
  endtask
endclass

module tb_top;
  parameter CLK_PERIOD = 10;
  localparam RESET_CYCLES = 5;

  wire clk;
  logic reset;
  logic [7:0] data;
  integer test_count;

  ff_block : always_ff @(posedge clk)
    data <= data + 1;

  comb_block : always_comb
    test_count = 0;

  bind tb_top protocol_checker pc_inst (.clk(clk), .req(req), .ack(ack));

  genvar gi;
  gen_array : begin
  end
endmodule
`);
    // Checker
    expect(
      r.symbols.some(
        (s: any) => s.name === 'protocol_checker' && s.metadata?.verilogKind === 'checker',
      ),
    ).toBe(true);
    // DPI import/export
    expect(
      r.symbols.some(
        (s: any) => s.name === 'c_golden_model' && s.metadata?.verilogKind === 'dpi_import',
      ),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'sv_get_status' && s.metadata?.verilogKind === 'dpi_export',
      ),
    ).toBe(true);
    // Class
    expect(r.symbols.some((s: any) => s.name === 'my_driver' && s.kind === 'class')).toBe(true);
    // UVM macro
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my_driver' && s.metadata?.verilogKind === 'uvm_component',
      ),
    ).toBe(true);
    // Constraint
    expect(
      r.symbols.some((s: any) => s.name === 'c_valid' && s.metadata?.verilogKind === 'constraint'),
    ).toBe(true);
    // Functions and tasks
    expect(r.symbols.some((s: any) => s.name === 'build_phase' && s.kind === 'function')).toBe(
      true,
    );
    expect(r.symbols.some((s: any) => s.name === 'run_phase' && s.metadata?.task === true)).toBe(
      true,
    );
    // Property + assertion
    expect(
      r.symbols.some((s: any) => s.name === 'p_req_ack' && s.metadata?.verilogKind === 'property'),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'a_check' && s.metadata?.verilogKind === 'assertion'),
    ).toBe(true);
    // Module + params
    expect(r.symbols.some((s: any) => s.name === 'tb_top' && s.kind === 'module')).toBe(true);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'CLK_PERIOD' && s.metadata?.verilogKind === 'parameter',
      ),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'RESET_CYCLES' && s.metadata?.verilogKind === 'localparam',
      ),
    ).toBe(true);
    // Net declarations
    expect(
      r.symbols.some((s: any) => s.name === 'data' && s.metadata?.verilogKind === 'logic'),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'test_count' && s.metadata?.verilogKind === 'integer'),
    ).toBe(true);
    // Always blocks
    expect(
      r.symbols.some((s: any) => s.name === 'ff_block' && s.metadata?.verilogKind === 'always_ff'),
    ).toBe(true);
    expect(
      r.symbols.some(
        (s: any) => s.name === 'comb_block' && s.metadata?.verilogKind === 'always_comb',
      ),
    ).toBe(true);
    // Bind
    expect(
      r.symbols.some((s: any) => s.name === 'tb_top' && s.metadata?.verilogKind === 'bind_target'),
    ).toBe(true);
    // Imports
    expect(r.edges!.length).toBeGreaterThanOrEqual(2);
  });
});
