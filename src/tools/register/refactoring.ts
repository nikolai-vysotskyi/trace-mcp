import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server-types.js';
import { applyRename, removeDeadCode, extractFunction } from '../refactor.js';

export function registerRefactoringTools(server: McpServer, ctx: ServerContext): void {
  const { store, projectRoot, guardPath, j } = ctx;

  // --- Refactoring Execution Tools ---

  server.tool(
    'apply_rename',
    'Rename a symbol across all usages (definition + all importing files). Runs collision detection first and aborts on conflicts. Returns the list of edits applied.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to rename (from search or outline)'),
      new_name: z.string().min(1).max(256).describe('New name for the symbol'),
    },
    async ({ symbol_id, new_name }) => {
      const result = applyRename(store, projectRoot, symbol_id, new_name);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'remove_dead_code',
    'Safely remove a dead symbol from its file. Verifies the symbol is actually dead (multi-signal detection or zero incoming edges) before removal. Warns about orphaned imports in other files.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to remove (from get_dead_code results)'),
    },
    async ({ symbol_id }) => {
      const result = removeDeadCode(store, projectRoot, symbol_id);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'extract_function',
    'Extract a range of lines into a new named function. Detects parameters (variables from outer scope) and return values (variables used after the range). Supports TypeScript/JavaScript, Python, and Go.',
    {
      file_path: z.string().max(512).describe('File path (relative to project root)'),
      start_line: z.number().int().min(1).describe('First line to extract (1-indexed, inclusive)'),
      end_line: z.number().int().min(1).describe('Last line to extract (1-indexed, inclusive)'),
      function_name: z.string().min(1).max(256).describe('Name for the extracted function'),
    },
    async ({ file_path, start_line, end_line, function_name }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = extractFunction(store, projectRoot, file_path, start_line, end_line, function_name);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );
}
