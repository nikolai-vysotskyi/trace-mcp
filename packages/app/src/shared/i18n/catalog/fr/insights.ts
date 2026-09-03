export const insights = {
  title: 'Analyses',
  reportPicker: 'Rapport',
  run: 'Lancer',
  refresh: 'Actualiser',
  running: 'En cours…',
  runAction: '{{action}} {{report}}',
  unknownError: 'Erreur inconnue',
  errorInit: 'Impossible d’ouvrir une session avec le démon (HTTP {{status}}).',
  errorNoSession: 'Le démon a ouvert une session mais ne l’a pas nommée.',
  errorHttp: 'La demande de rapport a échoué (HTTP {{status}}). {{detail}}',
  errorToolFailed: 'Le rapport n’a pas été exécuté.',

  reportDriftTitle: 'Dérive de CLAUDE.md',
  reportDriftDescription:
    'Chemins obsolètes et références de symboles mortes dans les fichiers de config des agents.',
  reportPagerankTitle: 'Fichiers les plus centraux',
  reportPagerankDescription:
    'Fichiers les plus centraux dans l’architecture, selon le PageRank du graphe d’imports.',
  reportRiskTitle: 'Points chauds à risque',
  reportRiskDescription: 'Fichiers alliant forte complexité et forte activité git.',

  runningDrift: 'Comparaison de la config des agents avec l’index…',
  runningPagerank: 'Classement des fichiers par centralité des imports…',
  runningRisk: 'Corrélation entre complexité et activité git…',

  emptyTitle: 'Rien à signaler',
  emptyBody: 'Ce rapport est revenu vide — rien dans le projet n’y correspond pour l’instant.',

  noDescription: '(aucune description)',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: 'Correctif : {{fix}}',
  rowScore: 'score {{score}}',
  rowHotspot: 'complexité {{complexity}} · {{commits}} commits',
  rowHotspotConfidence: 'complexité {{complexity}} · {{commits}} commits · {{confidence}}',

  reportStartupTitle: 'Contexte de démarrage',
  reportStartupDescription:
    'Ce que chaque session paie avant votre premier message, ce que cela coûte et ce qui le fait payer deux fois. Lu dans les journaux de session de ce Mac ; rien n’est envoyé nulle part.',
  runningStartup: 'Mesure du bloc de démarrage dans vos journaux de session…',

  startupBlockRow: 'Bloc de démarrage — {{tokens}} jetons',
  startupBlockDetail: 'médiane · p10 {{p10}} · p90 {{p90}} · {{sessions}} sessions en {{days}} jours',
  startupCostRow: 'Coût du démarrage — {{usd}}',
  startupCostDetail: 'sur {{total}} dépensés en entrée pendant {{days}} jours',
  startupSourceRow: '{{source}} — {{tokens}} jetons',
  startupSourceDetail: 'mesuré sur {{sessions}} sessions',
  startupResidualDetail:
    'Non détaillé — l’invite système, les schémas d’outils et CLAUDE.md n’atteignent jamais le journal de session',
  startupRebuildRow: 'Cache reconstruit : {{cause}} — {{events}} fois',
  startupRebuildDetail: '{{usd}} en plus de la lecture des mêmes jetons depuis le cache',
  startupServerRow: '{{server}} — dans {{sessions}} blocs de démarrage',
  startupServerDetail: 'appelé {{calls}} fois',

  sourceResidual: 'Invite système, schémas d’outils et instructions',
  sourceSkills: 'Liste des compétences',
  sourceDeferredTools: 'Liste des outils différés',
  sourceAgentListing: 'Liste des agents',
  sourceMcpInstructions: 'Instructions des serveurs MCP',
  sourceMemory: 'Fichiers de mémoire',
  sourceOther: 'Autres insertions',
  sourceHook: 'Hook : {{name}}',

  causeCompact: 'contexte compacté',
  causeTtlExpiry: 'cache expiré entre deux messages',
  causeModelSwitch: 'changement de modèle',
  causeToolsChanged: 'changement de la panoplie d’outils',
  causeListingChanged: 'changement de la liste des compétences ou des agents',
  causeUnexplained: 'cause non identifiée',

  recUnusedMcpServer: 'Serveur MCP {{target}} — jamais appelé',
  recUnusedSkill: 'Compétence {{target}} — jamais utilisée',
  recDuplicateInstructions: 'Texte d’instructions dupliqué dans {{target}}',
  recDetail:
    'Dans {{sessions}} démarrages sur {{total}} en {{days}} jours · {{tokens}} jetons à chaque fois · {{usd}}',
  recBadge: 'inutilisé',
} as const;
