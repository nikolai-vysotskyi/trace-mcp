import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server/types.js';
import { changeSignature, type SignatureChange } from '../refactoring/change-signature.js';
import { applyMove } from '../refactoring/move.js';
import { type PlanRefactoringParams, planRefactoring } from '../refactoring/plan-refactoring.js';
import {
  applyCodemod,
  applyRename,
  extractFunction,
  removeDeadCode,
} from '../refactoring/refactor.js';

export function registerRefactoringTools(server: McpServer, ctx: ServerContext): void {
  const { store, projectRoot, guardPath, j } = ctx;

  // --- Refactoring Execution Tools ---

  server.tool(
    'apply_rename',
    'Rename a symbol across all usages (definition + all importing files). Runs collision detection first and aborts on conflicts. Returns the list of edits applied. Modifies source files. Use check_rename first to verify safety; use plan_refactoring with type="rename" to preview edits. Returns JSON: { success, edits: [{ file, old_text, new_text }], filesModified }.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to rename (from search or outline)'),
      new_name: z.string().min(1).max(256).describe('New name for the symbol'),
      dry_run: z
        .boolean()
        .default(false)
        .describe('Preview changes without applying (default: false)'),
    },
    async ({ symbol_id, new_name, dry_run }) => {
      const result = applyRename(store, projectRoot, symbol_id, new_name, dry_run);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'remove_dead_code',
    'Safely remove a dead symbol from its file. Verifies the symbol is actually dead (multi-signal detection or zero incoming edges) before removal. Warns about orphaned imports in other files. Destructive — deletes code from source files. Use get_dead_code first to identify candidates. Returns JSON: { success, removed: { symbol_id, file }, orphanedImports }.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to remove (from get_dead_code results)'),
      dry_run: z
        .boolean()
        .default(false)
        .describe('Preview changes without applying (default: false)'),
    },
    async ({ symbol_id, dry_run }) => {
      const result = removeDeadCode(store, projectRoot, symbol_id, dry_run);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'extract_function',
    'Extract a range of lines into a new named function. Detects parameters (variables from outer scope) and return values (variables used after the range). Supports TypeScript/JavaScript, Python, and Go. Modifies source files. Use plan_refactoring with type="extract" to preview first. Returns JSON: { success, edits: [{ file, old_text, new_text }], extractedFunction }.',
    {
      file_path: z.string().max(512).describe('File path (relative to project root)'),
      start_line: z.number().int().min(1).describe('First line to extract (1-indexed, inclusive)'),
      end_line: z.number().int().min(1).describe('Last line to extract (1-indexed, inclusive)'),
      function_name: z.string().min(1).max(256).describe('Name for the extracted function'),
      dry_run: z
        .boolean()
        .default(false)
        .describe('Preview changes without applying (default: false)'),
    },
    async ({ file_path, start_line, end_line, function_name, dry_run }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = extractFunction(
        store,
        projectRoot,
        file_path,
        start_line,
        end_line,
        function_name,
        dry_run,
      );
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'apply_codemod',
    'Bulk regex find-and-replace across files. Dry-run by default — first call shows preview, second call with dry_run=false applies. Use for mechanical changes like adding async/await, renaming patterns, updating imports across many files. Potentially destructive — can modify or delete code. Always preview with dry_run=true first. Returns JSON: { success, matchedFiles, changes: [{ file, matches }], applied }.',
    {
      pattern: z
        .string()
        .min(1)
        .max(1000)
        .describe('Regex pattern to match (JavaScript regex syntax)'),
      replacement: z.string().max(1000).describe('Replacement string ($1, $2 for capture groups)'),
      file_pattern: z
        .string()
        .min(1)
        .max(512)
        .describe('Glob pattern for files to scan (e.g. "tests/**/*.test.ts", "src/**/*.py")'),
      dry_run: z
        .boolean()
        .default(true)
        .describe('Preview changes without writing (default: true). Set to false to apply.'),
      confirm_large: z
        .boolean()
        .optional()
        .describe('Required when >20 files affected. Acknowledges large-scale change.'),
      filter_content: z
        .string()
        .max(500)
        .optional()
        .describe('Only process files containing this substring (narrows scope)'),
      multiline: z
        .boolean()
        .optional()
        .describe('Enable multiline mode (dot matches newlines, patterns span lines)'),
    },
    async ({
      pattern,
      replacement,
      file_pattern,
      dry_run,
      confirm_large,
      filter_content,
      multiline,
    }) => {
      const result = await applyCodemod(projectRoot, pattern, replacement, file_pattern, {
        dryRun: dry_run,
        confirmLarge: confirm_large,
        filterContent: filter_content,
        multiline: multiline,
      });
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'apply_move',
    'Move a symbol to a different file or rename/move a file, updating all import paths across the codebase. Dry-run by default (safe preview). Modifies source files. Use plan_refactoring with type="move" to preview first. Returns JSON: { success, edits: [{ file, old_text, new_text }], filesModified }.',
    {
      symbol_id: z.string().max(512).optional().describe('Symbol ID to move (mode: symbol)'),
      target_file: z
        .string()
        .max(512)
        .optional()
        .describe('Target file path for the symbol (mode: symbol)'),
      source_file: z.string().max(512).optional().describe('File to move/rename (mode: file)'),
      new_path: z.string().max(512).optional().describe('New file path (mode: file)'),
      dry_run: z
        .boolean()
        .default(true)
        .describe('Preview changes without applying (default: true)'),
    },
    async ({ symbol_id, target_file, source_file, new_path, dry_run }) => {
      // Determine mode
      if (symbol_id && target_file) {
        const blocked = guardPath(target_file);
        if (blocked) return blocked;
        const result = applyMove(store, projectRoot, {
          mode: 'symbol',
          symbol_id,
          target_file,
          dry_run,
        });
        if (!result.success) {
          return { content: [{ type: 'text', text: j(result) }], isError: true };
        }
        return { content: [{ type: 'text', text: j(result) }] };
      }

      if (source_file && new_path) {
        const blocked = guardPath(new_path);
        if (blocked) return blocked;
        const result = applyMove(store, projectRoot, {
          mode: 'file',
          source_file,
          new_path,
          dry_run,
        });
        if (!result.success) {
          return { content: [{ type: 'text', text: j(result) }], isError: true };
        }
        return { content: [{ type: 'text', text: j(result) }] };
      }

      return {
        content: [
          {
            type: 'text',
            text: j({
              success: false,
              error:
                'Provide either (symbol_id + target_file) for symbol move, or (source_file + new_path) for file move',
            }),
          },
        ],
        isError: true,
      };
    },
  );

  const signatureChangeSchema = z.object({
    add_param: z
      .object({
        name: z.string().min(1).max(256),
        type: z.string().max(256).optional(),
        default_value: z.string().max(256).optional(),
        position: z.number().int().min(0).optional(),
      })
      .optional(),
    remove_param: z
      .object({
        name: z.string().min(1).max(256),
      })
      .optional(),
    rename_param: z
      .object({
        old_name: z.string().min(1).max(256),
        new_name: z.string().min(1).max(256),
      })
      .optional(),
    reorder_params: z.array(z.string().min(1).max(256)).optional(),
  });

  server.tool(
    'change_signature',
    'Change a function/method signature (add/remove/rename/reorder parameters) and update all call sites. Dry-run by default (safe preview). Modifies source files. Use plan_refactoring with type="signature" to preview first. Returns JSON: { success, edits: [{ file, old_text, new_text }], callSitesUpdated }.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID of the function/method to modify'),
      changes: z.array(signatureChangeSchema).min(1).max(20).describe('Array of changes to apply'),
      dry_run: z
        .boolean()
        .default(true)
        .describe('Preview changes without applying (default: true)'),
    },
    async ({ symbol_id, changes: rawChanges, dry_run }) => {
      const result = changeSignature(
        store,
        projectRoot,
        symbol_id,
        rawChanges as SignatureChange[],
        dry_run,
      );
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  const planSignatureChangeSchema = z.object({
    add_param: z
      .object({
        name: z.string().min(1).max(256),
        type: z.string().max(256).optional(),
        default_value: z.string().max(256).optional(),
        position: z.number().int().min(0).optional(),
      })
      .optional(),
    remove_param: z.object({ name: z.string().min(1).max(256) }).optional(),
    rename_param: z
      .object({
        old_name: z.string().min(1).max(256),
        new_name: z.string().min(1).max(256),
      })
      .optional(),
    reorder_params: z.array(z.string().min(1).max(256)).optional(),
  });

  server.tool(
    'plan_refactoring',
    'Preview any refactoring (rename, move, extract, signature) without applying. Returns all edits as {old_text, new_text} pairs. Read-only (does not modify files). Use to review the blast radius before calling apply_rename, apply_move, change_signature, or extract_function. Returns JSON: { success, type, edits: [{ file, old_text, new_text }], filesAffected }.',
    {
      type: z
        .enum(['rename', 'move', 'extract', 'signature'])
        .describe('Type of refactoring to preview'),
      symbol_id: z
        .string()
        .max(512)
        .optional()
        .describe('Symbol ID (for rename, move symbol, signature)'),
      new_name: z.string().max(256).optional().describe('New name (for rename)'),
      target_file: z.string().max(512).optional().describe('Target file (for move symbol)'),
      source_file: z.string().max(512).optional().describe('Source file (for move file)'),
      new_path: z.string().max(512).optional().describe('New path (for move file)'),
      file_path: z.string().max(512).optional().describe('File path (for extract)'),
      start_line: z.number().int().min(1).optional().describe('Start line (for extract)'),
      end_line: z.number().int().min(1).optional().describe('End line (for extract)'),
      function_name: z.string().max(256).optional().describe('Function name (for extract)'),
      changes: z
        .array(planSignatureChangeSchema)
        .optional()
        .describe('Signature changes (for signature)'),
    },
    async (params) => {
      const result = planRefactoring(store, projectRoot, params as PlanRefactoringParams);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );
}
