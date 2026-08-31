export const update = {
  staleRoots: 'MCP クライアントは v{{version}} を使用中です',
  staleRootsTitle:
    'エディタは {{pkgDir}} から trace-mcp を起動しており、そこは v{{version}} です。このコピーは別の npm でインストールされたため、アプリを更新しても変わりません。更新するまで、すべての MCP クライアントは古いサーバーを使い続けます。\n\nターミナルから更新してください:\n{{command}}',
  copyStaleRootCommand: '更新コマンドをコピー',

  headerVersion: 'バージョン {{version}}',
  headerChecking: '確認中…',
  headerAvailable: 'バージョン {{version}} が利用できます',
  headerUpToDate: '最新です · {{when}}に確認',

  cardReadyTitle: 'v{{version}} の準備ができました',
  cardReadySubtitle: '再起動でインストール · v{{current}}',
  cardRestart: '再起動してインストール',
  cardAvailableTitle: 'v{{version}} が利用できます',
  cardAvailableSubtitle: '現在は v{{current}} · {{when}}に確認',
  cardUpdate: 'アップデート',
  cardUpdating: 'アップデート中…',
} as const;
