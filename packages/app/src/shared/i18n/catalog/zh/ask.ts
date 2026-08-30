export const ask = {
  title: '提问',

  noProviderTitle: '连接一个 AI 提供方',
  noProviderSubtitle: '「提问」用你自己提供的模型来回答关于这个项目的问题。在设置中添加一个即可启用。',
  openAiSettings: '打开 AI 设置',

  chats: '对话',
  newChat: '新建对话',
  noChats: '还没有对话。',
  untitled: '未命名',
  deleteChat: '删除对话（⌫）',
  connectingProvider: '连接中…',
  noProvider: '没有提供方',

  showContextPanel: '显示上下文面板',
  hideContextPanel: '隐藏上下文面板',
  showContext: '显示上下文',
  hideContext: '隐藏上下文',
  loadingChat: '正在加载对话',
  conversation: '对话',

  emptyTitle: '关于这份代码，随便问',
  emptySubtitle: '回答基于已索引的图谱——这个项目里现有的文件、符号和决策。',
  slashCommands: '斜杠命令',
  slashFind: '按名称搜索符号',
  slashImpact: '查看某个符号的变更影响',
  slashScan: '运行安全扫描（OWASP 主要问题）',
  suggestionAuth: '认证是怎么实现的？',
  suggestionPlugins: '讲讲插件系统',
  suggestionRoutes: 'API 路由在哪里？',

  retrieving: '正在检索代码库',
  thinking: '思考中',
  sendAgain: '重新发送',

  composerLabel: '提问关于这个项目的问题',
  composerPlaceholder: '提问关于这个项目的问题，或输入 / 查看命令',
  stopGenerating: '停止生成',
  sendMessage: '发送消息',
  sendShortcut: '发送（⌘↵）',
  copyCode: '复制代码',
  copied: '已复制',

  context: '上下文',
  noContextTitle: '还没有上下文',
  noContextSubtitle:
    '发送消息后，模型读过的文件、符号和决策会显示在这里。斜杠命令不会检索上下文。',
  filesRead: '读取的文件',
  noFilesRead: '没有读取任何文件。',
  symbolsRead: '读取的符号',
  decisionsConsulted: '参考的决策',

  loadSessionFailed: '加载会话失败',
  createSessionFailed: '创建会话失败',
  noSession: '无法建立对话会话',
  slashFailed: '斜杠命令执行失败',
  unknownError: '未知错误',
} as const;
