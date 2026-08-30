export const update = {
  staleRoots: 'MCP 客户端仍在使用 v{{version}}',
  staleRootsTitle:
    '你的编辑器从 {{pkgDir}} 启动 trace-mcp，那份副本是 v{{version}}。它由另一个 npm 安装，因此更新本应用不会影响它——在它更新之前，所有 MCP 客户端都会继续使用旧版服务器。\n\n在终端里更新它：\n{{command}}',
  copyStaleRootCommand: '复制更新命令',

  headerVersion: '版本 {{version}}',
  headerChecking: '检查中…',
  headerAvailable: '有新版本 {{version}}',
  headerManualInstall: '版本 {{version}} 需要手动安装',
  headerUpToDate: '已是最新 · {{when}}检查过',

  cardReadyTitle: 'v{{version}} 已就绪',
  cardReadySubtitle: '重启以安装 · v{{current}}',
  cardRestart: '重启以安装',
  cardStuckTitle: 'v{{version}} 需要手动安装',
  cardStuckSubtitle:
    '命令行工具已更新，但应用本身仍是 v{{current}}——它无法替换自己的程序包。请下载发行版并拖入「应用程序」。',
  cardDownload: '下载 v{{version}}',
  cardStuckQuarantine:
    'macOS 会说下载的文件已损坏。其实没有——移入「应用程序」后执行一次这条命令：',
  copyQuarantineCommand: '复制命令',
  cardAvailableTitle: '有新版本 v{{version}}',
  cardAvailableSubtitle: '当前 v{{current}} · {{when}}检查过',
  cardUpdate: '更新',
  cardUpdating: '更新中…',
} as const;
