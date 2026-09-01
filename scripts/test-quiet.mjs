#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

const child = spawn('pnpm', ['exec', 'vitest', 'run', ...args], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

child.on('close', (code) => {
  if (code === 0) {
    const rawLines = stdout.split('\n');
    const cleanLines = rawLines.map((l) => stripAnsi(l).trim()).filter(Boolean);
    const testFiles = cleanLines.find((l) => l.startsWith('Test Files'));
    const tests = cleanLines.find((l) => l.startsWith('Tests'));
    const duration = cleanLines.find((l) => l.startsWith('Duration'));

    const parts = [testFiles, tests, duration].filter(Boolean);
    if (parts.length > 0) {
      console.log('✓ ' + parts.join(' · '));
    } else {
      console.log('✓ All tests passed');
    }
    process.exit(0);
  } else {
    if (stdout.trim()) console.log(stdout);
    if (stderr.trim()) console.error(stderr);
    process.exit(code ?? 1);
  }
});
