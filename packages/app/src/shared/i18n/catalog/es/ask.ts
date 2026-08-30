export const ask = {
  title: 'Preguntar',

  noProviderTitle: 'Conecta un proveedor de IA',
  noProviderSubtitle:
    'Preguntar responde sobre este proyecto usando un modelo que tú aportas. Añade uno en Ajustes para activarlo.',
  openAiSettings: 'Abrir los ajustes de IA',

  chats: 'Conversaciones',
  newChat: 'Nueva conversación',
  noChats: 'Todavía no hay conversaciones.',
  untitled: 'Sin título',
  deleteChat: 'Eliminar la conversación (⌫)',
  connectingProvider: 'Conectando…',
  noProvider: 'Sin proveedor',

  showContextPanel: 'Mostrar el panel de contexto',
  hideContextPanel: 'Ocultar el panel de contexto',
  showContext: 'Mostrar el contexto',
  hideContext: 'Ocultar el contexto',
  loadingChat: 'Cargando la conversación',
  conversation: 'Conversación',

  emptyTitle: 'Pregunta lo que quieras sobre este código',
  emptySubtitle:
    'Las respuestas se apoyan en el grafo indexado: los archivos, símbolos y decisiones que este proyecto ya tiene.',
  slashCommands: 'Comandos de barra',
  slashFind: 'Buscar símbolos por nombre',
  slashImpact: 'Ver el impacto de cambiar un símbolo',
  slashScan: 'Ejecutar un escaneo de seguridad (principales hallazgos OWASP)',
  suggestionAuth: '¿Cómo funciona la autenticación?',
  suggestionPlugins: 'Explica el sistema de plugins',
  suggestionRoutes: '¿Dónde están las rutas de la API?',

  retrieving: 'Buscando en el código',
  thinking: 'Pensando',
  sendAgain: 'Enviar de nuevo',

  composerLabel: 'Pregunta sobre este proyecto',
  composerPlaceholder: 'Pregunta sobre este proyecto, o escribe / para ver los comandos',
  stopGenerating: 'Detener la generación',
  sendMessage: 'Enviar el mensaje',
  sendShortcut: 'Enviar (⌘↵)',
  copyCode: 'Copiar el código',
  copied: 'Copiado',

  context: 'Contexto',
  noContextTitle: 'Todavía no hay contexto',
  noContextSubtitle:
    'Los archivos, símbolos y decisiones que lea el modelo aparecerán aquí después de enviar un mensaje. Los comandos de barra no recuperan contexto.',
  filesRead: 'Archivos leídos',
  noFilesRead: 'No se leyó ningún archivo.',
  symbolsRead: 'Símbolos leídos',
  decisionsConsulted: 'Decisiones consultadas',

  loadSessionFailed: 'No se pudo cargar la sesión',
  createSessionFailed: 'No se pudo crear la sesión',
  noSession: 'No se pudo establecer una sesión de conversación',
  slashFailed: 'El comando de barra falló',
  unknownError: 'Error desconocido',
} as const;
