export const update = {
  staleRoots: 'MCP 客户端仍在使用 v{{version}}',
  staleRootsTitle:
    '你的编辑器从 {{pkgDir}} 启动 trace-mcp，那份副本是 v{{version}}。它由另一个 npm 安装，因此更新本应用不会影响它——在它更新之前，所有 MCP 客户端都会继续使用旧版服务器。\n\n在终端里更新它：\n{{command}}',
  copyStaleRootCommand: '复制更新命令',

  duplicateApps: '已安装多份',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — 正在运行',
  duplicateAppsTitle:
    '这台 Mac 上有多份 trace-mcp:\n\n{{list}}\n\n只有你打开的那份会更新，所以下次启动哪一份就决定了你的版本。保留你在用的那份，把另一份移到废纸篓——或者打开另一份一次，让它自行更新。',
  revealDuplicateApp: '在访达中显示另一份',

  headerVersion: '版本 {{version}}',
  headerChecking: '检查中…',
  headerAvailable: '有新版本 {{version}}',
  headerUpToDate: '已是最新 · {{when}}检查过',
  headerDaemonAvailable: '守护进程有更新 · v{{version}}',
  headerBothAvailable: '应用和守护进程都有更新',

  cardReadyTitle: 'v{{version}} 已就绪',
  cardReadySubtitle: '重启以安装 · v{{current}}',
  cardRestart: '重启以安装',
  cardAvailableTitle: '有新版本 v{{version}}',
  cardAvailableSubtitle: '当前 v{{current}} · {{when}}检查过',
  cardUpdate: '更新',
  cardUpdating: '更新中…',

  settingsTitle: '更新',
  settingsAppRow: '应用',
  settingsDaemonRow: '守护进程',
  settingsCheck: '检查更新',
} as const;
