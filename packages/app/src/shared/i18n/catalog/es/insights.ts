export const insights = {
  title: 'Análisis',
  reportPicker: 'Informe',
  run: 'Ejecutar',
  refresh: 'Actualizar',
  running: 'Ejecutando…',
  runAction: '{{action}}: {{report}}',
  unknownError: 'Error desconocido',
  errorInit: 'No se pudo iniciar una sesión con el daemon (HTTP {{status}}).',
  errorNoSession: 'El daemon inició una sesión pero no la identificó.',
  errorHttp: 'La petición del informe falló (HTTP {{status}}). {{detail}}',
  errorToolFailed: 'El informe no llegó a ejecutarse.',

  reportDriftTitle: 'Desvío de CLAUDE.md',
  reportDriftDescription:
    'Rutas obsoletas y referencias a símbolos muertos en los archivos de configuración de agentes.',
  reportPagerankTitle: 'Archivos más centrales',
  reportPagerankDescription:
    'Los archivos más centrales de la arquitectura según PageRank sobre el grafo de importaciones.',
  reportRiskTitle: 'Puntos de riesgo',
  reportRiskDescription: 'Archivos que combinan alta complejidad con muchos cambios en git.',

  runningDrift: 'Comparando la configuración de agentes con el índice…',
  runningPagerank: 'Ordenando los archivos por centralidad de importaciones…',
  runningRisk: 'Correlacionando la complejidad con los cambios en git…',

  emptyTitle: 'Nada que informar',
  emptyBody: 'Este informe volvió vacío: ahora mismo nada del proyecto encaja con él.',

  noDescription: '(sin descripción)',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: 'Solución: {{fix}}',
  rowScore: 'puntuación {{score}}',
  rowHotspot: 'complejidad {{complexity}} · {{commits}} commits',
  rowHotspotConfidence: 'complejidad {{complexity}} · {{commits}} commits · {{confidence}}',
} as const;
