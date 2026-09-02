import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRACE_MCP_ROUTING_BLOCK } from '../../src/init/md-block.js';
import { buildInstructions } from '../../src/server/instructions.js';
import { allToolNames } from '../docs/tool-surface.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * TRA-579 / GitHub #706:
 * Ensure that all MCP tool names referenced in user/agent facing entry points
 * (routing blocks, response hints, and server instructions) match real,
 * registered tool names. Stale aliases or unregistered tool references cause
 * agents to call tools that do not exist or are impossible to route.
 */
describe('tool references integrity', () => {
  const registered = new Set(allToolNames());

  describe('src/init/md-block.ts', () => {
    it('every tool in the routing table matches a registered tool name', () => {
      // Parse markdown table rows: | Task | trace-mcp tool | Instead of |
      const lines = TRACE_MCP_ROUTING_BLOCK.split('\n');
      const tableLines = lines.filter(
        (l) => l.startsWith('|') && !l.includes('---') && !l.includes('Task |'),
      );
      const referencedTools: string[] = [];

      for (const line of tableLines) {
        const cols = line.split('|').map((c) => c.trim());
        if (cols.length >= 3) {
          const toolCol = cols[2]; // column 2 is "trace-mcp tool"
          // Find backticked tool names
          const matches = [...toolCol.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]);
          for (const match of matches) {
            // Skip non-tool keywords like mode / filter params
            if (['implements', 'exports_only'].includes(match)) continue;
            referencedTools.push(match);
          }
        }
      }

      // Also check footer tools (e.g. get_project_map)
      const footerMatches = [...TRACE_MCP_ROUTING_BLOCK.matchAll(/`([a-z0-9_]+)`/g)].map(
        (m) => m[1],
      );
      for (const match of footerMatches) {
        if (registered.has(match)) {
          referencedTools.push(match);
        }
      }

      expect(referencedTools.length).toBeGreaterThan(10);
      const invalid = referencedTools.filter((name) => !registered.has(name));
      expect(invalid, `md-block.ts references invalid tool names: ${invalid.join(', ')}`).toEqual(
        [],
      );
    });
  });

  describe('src/tools/shared/hints.ts', () => {
    const hintsSource = readFileSync(join(ROOT, 'src/tools/shared/hints.ts'), 'utf8');

    it('every hintGenerator key matches a registered tool name', () => {
      // hintGenerators: Record<string, HintGenerator> = { ... }
      // Match generator keys: '  tool_name(r) {'
      const generatorKeys = [...hintsSource.matchAll(/^\s{2}([a-z0-9_]+)\(r\)\s*\{/gm)].map(
        (m) => m[1],
      );

      expect(generatorKeys.length).toBeGreaterThan(15);
      const invalid = generatorKeys.filter((name) => !registered.has(name));
      expect(invalid, `hints.ts generator keys not registered: ${invalid.join(', ')}`).toEqual([]);
    });

    it('every suggested tool in hints matches a registered tool name', () => {
      // Match: tool: 'tool_name'
      const suggestedTools = [...hintsSource.matchAll(/tool:\s*['"]([a-z0-9_]+)['"]/g)].map(
        (m) => m[1],
      );

      expect(suggestedTools.length).toBeGreaterThan(20);
      const invalid = [...new Set(suggestedTools)].filter((name) => !registered.has(name));
      expect(invalid, `hints.ts suggests invalid tool names: ${invalid.join(', ')}`).toEqual([]);
    });
  });

  describe('src/server/instructions.ts', () => {
    it('every tool name referenced in instructions matches a registered tool name', () => {
      const fullInstructions = buildInstructions('TypeScript, React', 'full', 'strict');
      const minimalInstructions = buildInstructions('TypeScript, React', 'minimal', 'minimal');
      const combined = `${fullInstructions}\n${minimalInstructions}`;

      // Extract all backticked identifiers and check if any look like tool names
      // Tool names follow snake_case convention (or single words like search, batch, reindex, pin)
      const backticked = [...new Set([...combined.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]))];

      // Known non-tool backticked terms in instructions (e.g. options, args, concepts)
      const nonToolKeywords = new Set([
        'read',
        'content-match',
        'glob',
        'fusion',
        'implements',
        'extends',
        'exports_only',
        'dry_run',
        'confirm_large',
        'file_path',
        'true',
        'false',
        'today',
      ]);

      const toolCandidates = backticked.filter(
        (w) => !nonToolKeywords.has(w) && !w.startsWith('_'),
      );
      const toolsFound = toolCandidates.filter((w) => registered.has(w));

      expect(toolsFound.length).toBeGreaterThan(20);

      // Any candidate that looks like a tool name (contains '_' or is a known registered tool) must be registered
      const unknownTools = toolCandidates.filter(
        (w) =>
          (w.includes('_') || ['search', 'batch', 'reindex', 'pin'].includes(w)) &&
          !registered.has(w),
      );
      expect(
        unknownTools,
        `instructions.ts references unregistered tools: ${unknownTools.join(', ')}`,
      ).toEqual([]);
    });
  });
});
