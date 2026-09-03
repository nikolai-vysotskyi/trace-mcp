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

  reportStartupTitle: 'Contexto de arranque',
  reportStartupDescription:
    'Lo que cada sesión paga antes de tu primer mensaje, cuánto cuesta y qué hace que se pague dos veces. Se lee de los registros de sesión de este Mac; no se envía nada a ninguna parte.',
  runningStartup: 'Midiendo el bloque de arranque en tus registros de sesión…',

  startupBlockRow: 'Bloque de arranque: {{tokens}} tokens',
  startupBlockDetail: 'mediana · p10 {{p10}} · p90 {{p90}} · {{sessions}} sesiones en {{days}} días',
  startupCostRow: 'Coste del arranque: {{usd}}',
  startupCostDetail: 'de {{total}} gastados en entrada durante {{days}} días',
  startupSourceRow: '{{source}}: {{tokens}} tokens',
  startupSourceDetail: 'medido en {{sessions}} sesiones',
  startupResidualDetail:
    'Sin desglosar: el prompt del sistema, los esquemas de herramientas y CLAUDE.md nunca llegan al registro de sesión',
  startupRebuildRow: 'Caché reconstruida: {{cause}} — {{events}} veces',
  startupRebuildDetail: '{{usd}} además de leer esos mismos tokens de la caché',
  startupServerRow: '{{server}}: en {{sessions}} bloques de arranque',
  startupServerDetail: 'llamado {{calls}} veces',

  sourceResidual: 'Prompt del sistema, esquemas de herramientas e instrucciones',
  sourceSkills: 'Lista de habilidades',
  sourceDeferredTools: 'Lista de herramientas diferidas',
  sourceAgentListing: 'Lista de agentes',
  sourceMcpInstructions: 'Instrucciones de los servidores MCP',
  sourceMemory: 'Archivos de memoria',
  sourceOther: 'Otras inserciones',
  sourceHook: 'Hook: {{name}}',

  causeCompact: 'contexto compactado',
  causeTtlExpiry: 'la caché caducó entre mensajes',
  causeModelSwitch: 'cambió el modelo',
  causeToolsChanged: 'cambió el conjunto de herramientas',
  causeListingChanged: 'cambió la lista de habilidades o agentes',
  causeUnexplained: 'causa no identificada',

  recUnusedMcpServer: 'Servidor MCP {{target}}: nunca se llamó',
  recUnusedSkill: 'Habilidad {{target}}: nunca se usó',
  recDuplicateInstructions: 'Texto de instrucciones duplicado en {{target}}',
  recDetail:
    'En {{sessions}} de {{total}} arranques durante {{days}} días · {{tokens}} tokens en cada uno · {{usd}}',
  recBadge: 'sin usar',
} as const;
