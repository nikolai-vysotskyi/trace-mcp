#!/usr/bin/env node
/**
 * Standalone entry point for the eval harness.
 *
 * Exists so the harness can be exercised end-to-end without touching
 * `src/cli.ts`, which is owned by a parallel agent in the current
 * branch ordering. When cli.ts is unblocked the standard route will be
 * `trace-mcp eval ...`; this binary will become a fallback for users
 * running the source tree via `tsx src/eval/bin.ts ...`.
 */

import { Command } from 'commander';
import { evalCommand } from '../cli/eval.js';

const program = new Command()
  .name('trace-mcp-eval')
  .description('Standalone runner for trace-mcp code-intelligence benchmarks (P04 slice).');

program.addCommand(evalCommand);
program.parse();
