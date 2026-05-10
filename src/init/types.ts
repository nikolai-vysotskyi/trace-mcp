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
    | 'factory-droid';
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

export const GUARD_HOOK_VERSION = '0.9.0';
export const REINDEX_HOOK_VERSION = '0.1.0';
export const PRECOMPACT_HOOK_VERSION = '0.2.0';
export const WORKTREE_HOOK_VERSION = '0.2.0';
export const SESSION_START_HOOK_VERSION = '0.1.0';
export const USER_PROMPT_SUBMIT_HOOK_VERSION = '0.1.0';
export const STOP_HOOK_VERSION = '0.1.0';
export const SESSION_END_HOOK_VERSION = '0.1.0';
export const LAUNCHER_VERSION = '0.2.0';
