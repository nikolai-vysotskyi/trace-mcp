/**
 * trace-mcp VS Code extension entry point.
 *
 * Listens for onDidSaveTextDocument across all open workspace folders and
 * shells out to `trace-mcp register-edit <relPath>` after a per-file
 * debounce window. Closes the parallel-session staleness gap for any MCP
 * client running inside VS Code that doesn't fire Claude Code PostToolUse
 * hooks (Copilot Chat, Continue, Cline, Roo Code, etc.). Mirrors
 * jcodemunch v1.81.0.
 *
 * Keep this file thin — the testable bits live in reindex-queue.ts,
 * spawn-cli.ts, and exclude.ts.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { shouldExclude } from './exclude.js';
import { createReindexQueue, type ReindexQueue } from './reindex-queue.js';
import { spawnReindex } from './spawn-cli.js';

let queue: ReindexQueue | undefined;
let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('trace-mcp');
  context.subscriptions.push(output);

  queue = buildQueue();
  context.subscriptions.push({ dispose: () => queue?.dispose() });

  // Re-build the queue when the user changes debounce-affecting config
  // — without this, edits to `traceMcp.debounceMs` or `commandPath` only
  // take effect after window reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('traceMcp.debounceMs') ||
        e.affectsConfiguration('traceMcp.commandPath') ||
        e.affectsConfiguration('traceMcp.timeoutMs')
      ) {
        queue?.dispose();
        queue = buildQueue();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      handleSave(doc);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traceMcp.reindexCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showInformationMessage('No active editor');
        return;
      }
      handleSave(editor.document);
    }),
    vscode.commands.registerCommand('traceMcp.reindexWorkspace', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      for (const folder of folders) {
        await runReindexCli(folder.uri.fsPath, '.', folder.name);
      }
    }),
  );
}

export function deactivate(): void {
  queue?.dispose();
  queue = undefined;
}

function handleSave(doc: vscode.TextDocument): void {
  const config = vscode.workspace.getConfiguration('traceMcp');
  if (!config.get<boolean>('enabled', true)) return;
  if (doc.uri.scheme !== 'file') return;

  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return; // file is outside any workspace folder — skip

  const languages = config.get<string[]>('languages', []) ?? [];
  if (languages.length > 0 && !languages.includes(doc.languageId)) return;

  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  if (!rel || rel.startsWith('..')) return; // outside the folder somehow

  const excludeGlobs = config.get<string[]>('excludeGlobs', []) ?? [];
  if (shouldExclude(rel, excludeGlobs)) return;

  // Use the absolute fs path as the queue key so two folders with the
  // same relative path don't collapse onto each other.
  queue?.enqueue(`${folder.uri.fsPath}::${rel}`);
}

function buildQueue(): ReindexQueue {
  const config = vscode.workspace.getConfiguration('traceMcp');
  const debounceMs = config.get<number>('debounceMs', 500);

  return createReindexQueue({
    debounceMs,
    spawn: async (key: string) => {
      const sep = key.indexOf('::');
      if (sep < 0) return;
      const cwd = key.slice(0, sep);
      const rel = key.slice(sep + 2);
      const folderName = path.basename(cwd);
      await runReindexCli(cwd, rel, folderName);
    },
    onError: (key, err) => {
      output?.appendLine(
        `[trace-mcp] reindex error for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });
}

async function runReindexCli(cwd: string, relativePath: string, folderName: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('traceMcp');
  const commandPath = config.get<string>('commandPath', 'trace-mcp') ?? 'trace-mcp';
  const timeoutMs = config.get<number>('timeoutMs', 30_000);

  const result = await spawnReindex({
    commandPath,
    cwd,
    relativePath,
    timeoutMs,
    log: (msg) => output?.appendLine(`[${folderName}] ${msg}`),
  });

  if (result.ok) {
    output?.appendLine(`[${folderName}] reindexed ${relativePath}`);
  }
}
