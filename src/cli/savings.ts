/**
 * `trace savings` — how much input token spend trace-mcp gave back to this
 * install (TRA-1091).
 *
 * Reads `~/.trace/savings.json` locally. No network, no account, nothing
 * added to the usage ping. All of the arithmetic and every honesty rule live
 * in `src/savings-report.ts`; this file only chooses text or JSON.
 */
import { Command } from 'commander';
import { buildSavingsReport, formatSavingsReport } from '../savings-report.js';

export const savingsCommand = new Command('savings')
  .description('Show the input tokens trace-mcp gave back to this install (measured, local).')
  .option('--json', 'Emit the report as JSON')
  .action((opts: { json?: boolean }) => {
    const report = buildSavingsReport();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${formatSavingsReport(report)}\n`);
  });
