/* The desktop app runs this CLI through its own Electron binary with
   ELECTRON_RUN_AS_NODE=1 (TRA-438), so `process.versions.electron` is set in a
   process that is, as far as argv is concerned, plain Node.

   Commander sniffs that variable and switches to an argv layout with no script
   argument — argv[1] becomes the first user argument. Under it the LaunchAgent's
   `serve-http --port 3741` came out as `error: unknown option '--port'` and the
   daemon never started. `from: 'node'` is what pins the layout; this asserts the
   call site still passes it. */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cli argv parsing', () => {
  it('parses argv with an explicit node layout, never commander auto-detection', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/cli.ts'), 'utf-8');
    expect(src).toContain("program.parse(process.argv, { from: 'node' })");
    expect(src).not.toMatch(/^program\.parse\(\);$/m);
  });
});
