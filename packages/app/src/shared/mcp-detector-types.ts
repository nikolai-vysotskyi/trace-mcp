export type DetectedMcpClientName =
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

export interface DetectedMcpClient {
  name: DetectedMcpClientName;
  configPath: string;
  hasTraceMcp: boolean;
}

export const MCP_CLIENT_DISPLAY_NAMES: Record<DetectedMcpClientName, string> = {
  'claude-code': 'Claude Code',
  'claw-code': 'Claw Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  continue: 'Continue',
  junie: 'Junie',
  'jetbrains-ai': 'JetBrains AI Assistant',
  codex: 'Codex',
  hermes: 'Hermes Agent',
  amp: 'AMP',
  warp: 'Warp',
  'factory-droid': 'Factory Droid',
  cline: 'Cline',
  kilocode: 'KiloCode',
  antigravity: 'Antigravity',
  kimi: 'Kimi Code CLI',
};
