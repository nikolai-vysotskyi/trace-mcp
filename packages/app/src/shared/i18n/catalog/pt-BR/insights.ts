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
} as const;
