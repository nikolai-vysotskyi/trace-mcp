/** Types for the init/upgrade detection and configuration system. */

export interface PackageManagerInfo {
  type:
    | 'npm'
    | 'yarn'
    | 'pnpm'
    | 'bun'
    | 'composer'
    | 'pip'
    | 'poetry'
    | 'uv'
    | 'go'
    | 'cargo'
    | 'bundler'
    | 'maven'
    | 'gradle';
  lockfile?: string;
}

export interface DetectedFramework {
  name: string;
  version?: string;
  category?:
    | 'framework'
    | 'orm'
    | 'validation'
    | 'state'
    | 'api'
    | 'realtime'
    | 'messaging'
    | 'testing'
    | 'tooling'
    | 'view';
}

export interface DetectedMcpClient {
  name:
    | 'claude-code'
    | 'claw-code'
    | 'claude-desktop'
    | 'cursor'
    | 'windsurf'
    | 'continue'
    | 'junie'
    | 'jetbrains-ai'
    | 'codex'
    | 'hermes'
    | 'amp'
    | 'warp'
    | 'factory-droid'
    | 'cline'
    | 'kilocode'
    | 'antigravity'
    | 'kimi';
  configPath: string;
  hasTraceMcp: boolean;
}

export interface DetectionResult {
  projectRoot: string;
  packageManagers: PackageManagerInfo[];
  frameworks: DetectedFramework[];
  languages: string[];
  mcpClients: DetectedMcpClient[];
  existingConfig: { path: string } | null;
  existingDb: { path: string; schemaVersion: number; fileCount: number } | null;
  hasClaudeMd: boolean;
  claudeMdHasTraceMcpBlock: boolean;
  hasGuardHook: boolean;
  guardHookVersion: string | null;
}

type InitAction = 'created' | 'updated' | 'skipped' | 'already_configured';

export interface InitStepResult {
  target: string;
  action: InitAction;
  detail?: string;
}

export interface InitReport {
  detection: DetectionResult;
  steps: InitStepResult[];
}

// Versions bumped for the Windows hidden-hook launcher (issue #230): every
// Windows hook now registers as a hidden PowerShell command instead of
// `cmd /c`. The bump makes `trace-mcp init` treat existing installs as
// outdated and rewrite the registered command + install the hidden-run shim.
export const GUARD_HOOK_VERSION = '0.12.0';
// 0.5.0 (TRA-694): the reindex dispatch is detached, so an edit no longer
// blocks the agent on the daemon round trip. Existing installs must be
// rewritten to pick it up.
export const REINDEX_HOOK_VERSION = '0.5.0';
export const PRECOMPACT_HOOK_VERSION = '0.3.0';
export const WORKTREE_HOOK_VERSION = '0.3.0';
export const SESSION_START_HOOK_VERSION = '0.2.0';
export const USER_PROMPT_SUBMIT_HOOK_VERSION = '0.2.0';
export const STOP_HOOK_VERSION = '0.2.0';
export const SESSION_END_HOOK_VERSION = '0.2.0';
export const LAUNCHER_VERSION = '0.4.0';
