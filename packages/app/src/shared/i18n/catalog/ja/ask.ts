export const ask = {
  title: '質問',

  noProviderTitle: 'AI プロバイダを接続',
  noProviderSubtitle:
    '「質問」機能は、設定したモデルを使ってこのプロジェクトに関する質問に答えます。設定でプロバイダを追加すると有効になります。',
  openAiSettings: 'AI の設定を開く',

  chats: 'チャット',
  newChat: '新規チャット',
  noChats: 'チャットはまだありません。',
  untitled: '無題',
  deleteChat: 'チャットを削除（⌫）',
  connectingProvider: '接続中…',
  noProvider: 'プロバイダなし',

  showContextPanel: 'コンテキストパネルを表示',
  hideContextPanel: 'コンテキストパネルを隠す',
  showContext: 'コンテキストを表示',
  hideContext: 'コンテキストを隠す',
  loadingChat: 'チャットを読み込み中',
  conversation: '会話',

  emptyTitle: 'このコードベースについて何でも聞いてください',
  emptySubtitle:
    '回答は、インデックス済みのグラフ（このプロジェクトにあるファイル・シンボル・決定事項）に基づいています。',
  slashCommands: 'スラッシュコマンド',
  slashFind: '名前でシンボルを検索',
  slashImpact: 'シンボルの変更影響を表示',
  slashScan: 'セキュリティスキャンを実行（OWASP の主要な検出）',
  suggestionAuth: '認証はどう動いていますか？',
  suggestionPlugins: 'プラグインの仕組みを説明して',
  suggestionRoutes: 'API のルートはどこにありますか？',

  retrieving: 'コードベースを検索中',
  thinking: '考えています',
  sendAgain: 'もう一度送信',

  composerLabel: 'このプロジェクトについて質問',
  composerPlaceholder: 'このプロジェクトについて質問、または / でコマンド',
  stopGenerating: '生成を停止',
  sendMessage: 'メッセージを送信',
  sendShortcut: '送信（⌘↵）',
  copyCode: 'コードをコピー',
  copied: 'コピーしました',

  context: 'コンテキスト',
  noContextTitle: 'コンテキストはまだありません',
  noContextSubtitle:
    'メッセージを送信すると、モデルが読んだファイル・シンボル・決定事項がここに表示されます。スラッシュコマンドはコンテキストを取得しません。',
  filesRead: '読み取ったファイル',
  noFilesRead: 'ファイルは読み取られませんでした。',
  symbolsRead: '読み取ったシンボル',
  decisionsConsulted: '参照した決定事項',

  loadSessionFailed: 'セッションを読み込めませんでした',
  createSessionFailed: 'セッションを作成できませんでした',
  noSession: 'チャットセッションを確立できませんでした',
  slashFailed: 'スラッシュコマンドが失敗しました',
  unknownError: '不明なエラー',
} as const;
