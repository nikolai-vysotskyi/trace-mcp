/* Ask — the chat surface.

   Only the chrome is here. What the model streams back, and the slash-command
   syntax the user types (`/find <query>`), are not ours to translate: one is
   generated text, the other is an identifier the parser matches on. */

export const ask = {
  title: 'Ask',

  noProviderTitle: 'Connect an AI provider',
  noProviderSubtitle:
    'Ask answers questions about this project using a model you supply. Add one in Settings to turn it on.',
  openAiSettings: 'Open AI settings',

  chats: 'Chats',
  newChat: 'New chat',
  noChats: 'No chats yet.',
  untitled: 'Untitled',
  deleteChat: 'Delete chat (⌫)',
  connectingProvider: 'Connecting…',
  noProvider: 'No provider',

  showContextPanel: 'Show the context panel',
  hideContextPanel: 'Hide the context panel',
  showContext: 'Show context',
  hideContext: 'Hide context',
  loadingChat: 'Loading chat',
  conversation: 'Conversation',

  emptyTitle: 'Ask anything about this codebase',
  emptySubtitle:
    'Answers are grounded in the indexed graph — the files, symbols and decisions this project already has.',
  slashCommands: 'Slash commands',
  slashFind: 'Search symbols by name',
  slashImpact: 'Show change impact for a symbol',
  slashScan: 'Run security scan (OWASP top findings)',
  suggestionAuth: 'How does auth work?',
  suggestionPlugins: 'Explain the plugin system',
  suggestionRoutes: 'Where are API routes?',

  retrieving: 'Searching the codebase',
  thinking: 'Thinking',
  sendAgain: 'Send again',

  composerLabel: 'Ask about this project',
  composerPlaceholder: 'Ask about this project, or type / for commands',
  stopGenerating: 'Stop generating',
  sendMessage: 'Send message',
  sendShortcut: 'Send (⌘↵)',
  copyCode: 'Copy code',
  copied: 'Copied',

  context: 'Context',
  noContextTitle: 'No context yet',
  noContextSubtitle:
    'The files, symbols and decisions the model read appear here after you send a message. Slash commands do not retrieve context.',
  filesRead: 'Files read',
  noFilesRead: 'No files were read.',
  symbolsRead: 'Symbols read',
  decisionsConsulted: 'Decisions consulted',

  loadSessionFailed: 'Failed to load session',
  createSessionFailed: 'Failed to create session',
  noSession: 'Could not establish a chat session',
  slashFailed: 'Slash command failed',
  unknownError: 'Unknown error',
} as const;
