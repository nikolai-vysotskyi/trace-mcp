#!/usr/bin/env node
/**
 * Regenerates src/telemetry/tz-country.ts from the OS tzdata `zone.tab`
 * (public domain). Run after a tzdata bump: `pnpm run gen:tz-country`.
 */
import fs from 'node:fs';

const TAB = process.argv[2] ?? '/usr/share/zoneinfo/zone.tab';
const OUT = 'src/telemetry/tz-country.ts';

const byCountry = new Map();
for (const line of fs.readFileSync(TAB, 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [cc, , zone] = line.split('\t');
  if (!cc || !zone) continue;
  if (!byCountry.has(cc)) byCountry.set(cc, []);
  byCountry.get(cc).push(zone);
}

const packed = [...byCountry.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([cc, zones]) => `${cc}|${zones.sort().join(',')}`)
  .join(';');

// Chunk into string literals so the generated file stays under the line-length lint.
const chunks = packed.match(/.{1,92}/g) ?? [];
const literal = chunks
  .map((c) => `  '${c}' +`)
  .join('\n')
  .replace(/ \+$/, '');

const header = fs.readFileSync(OUT, 'utf8').split('const PACKED =')[0];
const tail = fs.readFileSync(OUT, 'utf8').split(';\n\nlet index')[1];
fs.writeFileSync(OUT, `${header}const PACKED =\n${literal};\n\nlet index${tail}`);
console.log(`zones: ${[...byCountry.values()].flat().length}, countries: ${byCountry.size}`);
