/** Types for the init/upgrade detection and configuration system. */

export interface PackageManagerInfo {
  type: 'npm' | 'yarn' | 'pnpm' | 'bun' | 'composer' | 'pip' | 'poetry' | 'uv' | 'go' | 'cargo' | 'bundler' | 'maven' | 'gradle';
  lockfile?: string;
}

export interface DetectedFramework {
  name: string;
  version?: string;
  category?: 'framework' | 'orm' | 'validation' | 'state' | 'api' | 'realtime' | 'testing' | 'tooling' | 'view';
}

export interface DetectedMcpClient {
  name: 'claude-code' | 'claw-code' | 'claude-desktop' | 'cursor' | 'windsurf' | 'continue';
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

export const GUARD_HOOK_VERSION = '0.2.0';
export const REINDEX_HOOK_VERSION = '0.1.0';
