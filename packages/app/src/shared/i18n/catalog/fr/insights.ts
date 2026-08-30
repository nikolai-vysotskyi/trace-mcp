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
} as const;
