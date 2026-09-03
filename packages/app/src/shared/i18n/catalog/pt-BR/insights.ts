export const insights = {
  title: 'Análises',
  reportPicker: 'Relatório',
  run: 'Executar',
  refresh: 'Atualizar',
  running: 'Executando…',
  runAction: '{{action}} {{report}}',
  unknownError: 'Erro desconhecido',
  errorInit: 'Não foi possível abrir uma sessão com o daemon (HTTP {{status}}).',
  errorNoSession: 'O daemon abriu uma sessão, mas não a identificou.',
  errorHttp: 'A requisição do relatório falhou (HTTP {{status}}). {{detail}}',
  errorToolFailed: 'O relatório não foi executado.',

  reportDriftTitle: 'Desvio do CLAUDE.md',
  reportDriftDescription:
    'Caminhos obsoletos e referências a símbolos inexistentes nos arquivos de configuração do agente.',
  reportPagerankTitle: 'Arquivos mais centrais',
  reportPagerankDescription:
    'Arquivos arquiteturalmente mais centrais por PageRank no grafo de imports.',
  reportRiskTitle: 'Pontos críticos de risco',
  reportRiskDescription: 'Arquivos que combinam alta complexidade com alta rotatividade no git.',

  runningDrift: 'Conferindo a configuração do agente com o índice…',
  runningPagerank: 'Ordenando arquivos por centralidade de imports…',
  runningRisk: 'Correlacionando complexidade com rotatividade no git…',

  emptyTitle: 'Nada a relatar',
  emptyBody: 'Este relatório voltou vazio — nada no projeto se encaixa nele agora.',

  noDescription: '(sem descrição)',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: 'Correção: {{fix}}',
  rowScore: 'pontuação {{score}}',
  rowHotspot: 'complexidade {{complexity}} · {{commits}} commits',
  rowHotspotConfidence: 'complexidade {{complexity}} · {{commits}} commits · {{confidence}}',

  reportStartupTitle: 'Contexto de inicialização',
  reportStartupDescription:
    'O que cada sessão paga antes da sua primeira mensagem, quanto custa e o que faz esse custo ser pago duas vezes. Lido dos registros de sessão deste Mac; nada é enviado a lugar nenhum.',
  runningStartup: 'Medindo o bloco de inicialização nos seus registros de sessão…',

  startupBlockRow: 'Bloco de inicialização — {{tokens}} tokens',
  startupBlockDetail: 'mediana · p10 {{p10}} · p90 {{p90}} · {{sessions}} sessões em {{days}} dias',
  startupCostRow: 'Custo da inicialização — {{usd}}',
  startupCostDetail: 'de {{total}} gastos em entrada ao longo de {{days}} dias',
  startupSourceRow: '{{source}} — {{tokens}} tokens',
  startupSourceDetail: 'medido em {{sessions}} sessões',
  startupResidualDetail:
    'Sem detalhamento — o prompt do sistema, os esquemas de ferramentas e o CLAUDE.md nunca chegam ao registro de sessão',
  startupRebuildRow: 'Cache reconstruído: {{cause}} — {{events}} vezes',
  startupRebuildDetail: '{{usd}} além de ler os mesmos tokens do cache',
  startupServerRow: '{{server}} — em {{sessions}} blocos de inicialização',
  startupServerDetail: 'chamado {{calls}} vezes',

  sourceResidual: 'Prompt do sistema, esquemas de ferramentas e instruções',
  sourceSkills: 'Lista de habilidades',
  sourceDeferredTools: 'Lista de ferramentas adiadas',
  sourceAgentListing: 'Lista de agentes',
  sourceMcpInstructions: 'Instruções dos servidores MCP',
  sourceMemory: 'Arquivos de memória',
  sourceOther: 'Outras inserções',
  sourceHook: 'Hook: {{name}}',

  causeCompact: 'contexto compactado',
  causeTtlExpiry: 'cache expirou entre mensagens',
  causeModelSwitch: 'modelo mudou',
  causeToolsChanged: 'conjunto de ferramentas mudou',
  causeListingChanged: 'lista de habilidades ou agentes mudou',
  causeUnexplained: 'causa não identificada',
} as const;
