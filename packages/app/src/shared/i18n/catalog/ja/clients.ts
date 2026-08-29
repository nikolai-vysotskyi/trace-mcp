export const clients = {
  title: 'MCP クライアント',
  refresh: 'クライアントを再検出',

  supported: '対応クライアント',
  sessions: 'アクティブなセッション',
  detecting: 'クライアントを検出中',
  loadingSessions: 'セッションを読み込み中',

  daemonDownTitle: 'デーモンに接続できません',
  daemonDownSubtitle:
    'trace-mcp のクライアントはローカルのデーモン経由で接続します。デーモンを起動すると表示・設定できます。',
  startDaemon: 'デーモンを起動',
  starting: '起動中…',

  noSessionsTitle: 'アクティブなセッションはありません',
  noSessionsSubtitle: 'クライアントがデーモンに接続すると、ここにセッションが表示されます。',
  unnamedSession: '名前のないセッション',

  sessionActive: 'アクティブ',
  sessionIdle: '待機中',
  sessionStale: '古い',

  connected: '接続済み',
  connect: '接続',
  connecting: '接続中…',
  updateAvailable: 'アップデートあり',
  update: 'アップデート',
  updating: 'アップデート中…',
  driftedField: '差異のある項目: {{field}}',
  setUpManually: '手動で設定…',
  hideSteps: '手順を隠す',

  enforcementLevel: '強制レベル',
  levelBase: 'ベース',
  levelBaseHint: 'CLAUDE.md のみ — 緩やかなルーティング規則',
  levelStandard: '標準',
  levelStandardHint: 'CLAUDE.md とフック',
  levelMax: '最大',
  levelMaxHint: 'CLAUDE.md、フック、tweakcc — 推奨',
} as const;
