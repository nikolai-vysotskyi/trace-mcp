/**
 * Unified refactoring preview facade — always runs in dry-run mode.
 * Returns all {old_text, new_text} pairs for any refactoring type
 * without applying any changes.
 */

import type { Store } from '../../db/store.js';
import type { EsModuleResolver } from '../../indexer/resolvers/es-modules.js';
import { changeSignature, type SignatureChange } from './change-signature.js';
import { applyMove } from './move.js';
import { applyRename, extractFunction } from './refactor.js';
import type { RefactorResult } from './shared.js';

export interface PlanRefactoringParams {
  type: 'rename' | 'move' | 'extract' | 'signature';

  // Rename params
  symbol_id?: string;
  new_name?: string;

  // Move params (symbol mode)
  target_file?: string;

  // Move params (file mode)
  source_file?: string;
  new_path?: string;

  // Extract params
  file_path?: string;
  start_line?: number;
  end_line?: number;
  function_name?: string;

  // Signature params
  changes?: SignatureChange[];
}

/**
 * Preview any refactoring without applying.
 * Always forces dry_run=true on the underlying tool.
 */
export function planRefactoring(
  store: Store,
  projectRoot: string,
  params: PlanRefactoringParams,
  resolver?: EsModuleResolver,
): RefactorResult {
  switch (params.type) {
    case 'rename': {
      if (!params.symbol_id || !params.new_name) {
        return errorResult('plan_refactoring', 'Rename requires symbol_id and new_name');
      }
      return applyRename(store, projectRoot, params.symbol_id, params.new_name, true);
    }

    case 'move': {
      if (params.symbol_id && params.target_file) {
        return applyMove(
          store,
          projectRoot,
          {
            mode: 'symbol',
            symbol_id: params.symbol_id,
            target_file: params.target_file,
            dry_run: true,
          },
          resolver,
        );
      }
      if (params.source_file && params.new_path) {
        return applyMove(
          store,
          projectRoot,
          {
            mode: 'file',
            source_file: params.source_file,
            new_path: params.new_path,
            dry_run: true,
          },
          resolver,
        );
      }
      return errorResult(
        'plan_refactoring',
        'Move requires (symbol_id + target_file) or (source_file + new_path)',
      );
    }

    case 'extract': {
      if (!params.file_path || !params.start_line || !params.end_line || !params.function_name) {
        return errorResult(
          'plan_refactoring',
          'Extract requires file_path, start_line, end_line, and function_name',
        );
      }
      return extractFunction(
        store,
        projectRoot,
        params.file_path,
        params.start_line,
        params.end_line,
        params.function_name,
        true,
      );
    }

    case 'signature': {
      if (!params.symbol_id || !params.changes || params.changes.length === 0) {
        return errorResult('plan_refactoring', 'Signature change requires symbol_id and changes[]');
      }
      return changeSignature(store, projectRoot, params.symbol_id, params.changes, true);
    }

    default:
      return errorResult(
        'plan_refactoring',
        `Unknown refactoring type: ${(params as { type: string }).type}`,
      );
  }
}

function errorResult(tool: string, error: string): RefactorResult {
  return {
    success: false,
    tool,
    edits: [],
    files_modified: [],
    warnings: [],
    error,
  };
}
