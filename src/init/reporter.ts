/**
 * Format init/upgrade results for human-readable and JSON output.
 */

import type { DetectionResult, InitStepResult, InitReport } from './types.js';

export function formatReport(report: InitReport, json: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return formatHuman(report);
}

function formatHuman(report: InitReport): string {
  const { detection, steps } = report;
  const lines: string[] = [];

  // Detection summary
  lines.push('');
  lines.push('  Detected:');
  if (detection.languages.length > 0) {
    lines.push(`    Languages    ${detection.languages.join(', ')}`);
  }
  // Group detected plugins by category
  const fwByCategory = new Map<string, string[]>();
  for (const f of detection.frameworks) {
    const cat = f.category ?? 'framework';
    const label = f.version ? `${f.name} ${f.version}` : f.name;
    if (!fwByCategory.has(cat)) fwByCategory.set(cat, []);
    fwByCategory.get(cat)!.push(label);
  }
  const categoryLabels: Record<string, string> = {
    framework: 'Frameworks', orm: 'ORMs', view: 'UI/View',
    api: 'API', validation: 'Validation', state: 'State mgmt',
    realtime: 'Realtime', testing: 'Testing', tooling: 'Tooling',
  };
  for (const [cat, items] of fwByCategory) {
    const label = (categoryLabels[cat] ?? cat).padEnd(12);
    lines.push(`    ${label} ${items.join(', ')}`);
  }
  if (detection.packageManagers.length > 0) {
    lines.push(`    Package mgr  ${detection.packageManagers.map((p) => p.type).join(', ')}`);
  }
  if (detection.mcpClients.length > 0) {
    lines.push(`    MCP clients  ${detection.mcpClients.map((c) => c.name).join(', ')}`);
  }
  if (detection.languages.length === 0 && detection.frameworks.length === 0) {
    lines.push('    (no frameworks detected — using generic patterns)');
  }

  // Group steps by action
  const created = steps.filter((s) => s.action === 'created');
  const updated = steps.filter((s) => s.action === 'updated');
  const alreadyOk = steps.filter((s) => s.action === 'already_configured');
  const skipped = steps.filter((s) => s.action === 'skipped');

  if (created.length > 0) {
    lines.push('');
    lines.push('  Created:');
    for (const s of created) lines.push(`    ${shortPath(s.target).padEnd(24)} ${s.detail ?? ''}`);
  }
  if (updated.length > 0) {
    lines.push('');
    lines.push('  Updated:');
    for (const s of updated) lines.push(`    ${shortPath(s.target).padEnd(24)} ${s.detail ?? ''}`);
  }
  if (alreadyOk.length > 0) {
    lines.push('');
    lines.push('  Already configured:');
    for (const s of alreadyOk) lines.push(`    ${shortPath(s.target).padEnd(24)} ${s.detail ?? ''}`);
  }
  if (skipped.length > 0) {
    lines.push('');
    lines.push('  Skipped:');
    for (const s of skipped) lines.push(`    ${shortPath(s.target).padEnd(24)} ${s.detail ?? ''}`);
  }

  lines.push('');
  return lines.join('\n');
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  const cwd = process.cwd();
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1) || '.';
  return p;
}
