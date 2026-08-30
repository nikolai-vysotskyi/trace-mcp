export const clients = {
  title: 'Clientes MCP',
  refresh: 'Atualizar clientes',

  supported: 'Clientes compatíveis',
  sessions: 'Sessões ativas',
  detecting: 'Detectando clientes',
  loadingSessions: 'Carregando sessões',

  noSessionsTitle: 'Nenhuma sessão ativa',
  noSessionsSubtitle: 'Uma sessão aparece aqui quando um cliente se conecta ao daemon.',
  unnamedSession: 'Sessão sem nome',

  sessionActive: 'Ativa',
  sessionIdle: 'Ociosa',
  sessionStale: 'Obsoleta',

  connected: 'Conectado',
  connect: 'Conectar',
  connecting: 'Conectando…',
  updateAvailable: 'Atualização disponível',
  update: 'Atualizar',
  updating: 'Atualizando…',
  updateAll: 'Atualizar tudo',
  updatingProgress: 'Atualizando {{done}} de {{total}}',
  writeFailed: 'Não foi possível gravar a configuração.',
  driftedField: 'Campo divergente: {{field}}',
  setUpManually: 'Configurar manualmente…',
  hideSteps: 'Ocultar os passos',

  enforcementLevel: 'Nível de aplicação',
  levelBase: 'Básico',
  levelBaseHint: 'Só CLAUDE.md — regras de roteamento sugeridas',
  levelStandard: 'Padrão',
  levelStandardHint: 'CLAUDE.md e hooks',
  levelMax: 'Máximo',
  levelMaxHint: 'CLAUDE.md, hooks e tweakcc — recomendado',
} as const;
