export const clients = {
  title: 'MCP 客户端',
  refresh: '刷新客户端',

  supported: '支持的客户端',
  sessions: '活跃会话',
  detecting: '正在检测客户端',
  loadingSessions: '正在加载会话',

  daemonDownTitle: '无法连接守护进程',
  daemonDownSubtitle: 'trace-mcp 的客户端通过本地守护进程连接。启动它才能查看和配置。',
  startDaemon: '启动守护进程',
  starting: '启动中…',

  noSessionsTitle: '没有活跃会话',
  noSessionsSubtitle: '当有客户端连接到守护进程时，会话会出现在这里。',
  unnamedSession: '未命名会话',

  sessionActive: '活跃',
  sessionIdle: '空闲',
  sessionStale: '已过期',

  connected: '已连接',
  connect: '连接',
  connecting: '连接中…',
  updateAvailable: '有可用更新',
  update: '更新',
  updating: '更新中…',
  driftedField: '偏移字段：{{field}}',
  setUpManually: '手动配置…',
  hideSteps: '隐藏步骤',

  enforcementLevel: '强制级别',
  levelBase: '基础',
  levelBaseHint: '仅 CLAUDE.md — 软性路由规则',
  levelStandard: '标准',
  levelStandardHint: 'CLAUDE.md 与 hooks',
  levelMax: '最高',
  levelMaxHint: 'CLAUDE.md、hooks 与 tweakcc — 推荐',
} as const;
