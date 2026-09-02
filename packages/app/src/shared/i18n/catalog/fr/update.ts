export const update = {
  staleRoots: 'Les clients MCP utilisent toujours la v{{version}}',
  staleRootsTitle:
    'Vos éditeurs lancent trace-mcp depuis {{pkgDir}}, qui est en v{{version}}. Cette copie a été installée par un autre npm : mettre à jour cette app ne l’a pas touchée — tant qu’elle n’est pas mise à jour, tous les clients MCP continuent d’utiliser l’ancien serveur.\n\nMettez-la à jour depuis un terminal :\n{{command}}',
  copyStaleRootCommand: 'Copier la commande de mise à jour',

  duplicateApps: 'Installé plusieurs fois',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — en cours d’exécution',
  duplicateAppsTitle:
    'Ce Mac contient plusieurs copies de trace-mcp :\n\n{{list}}\n\nSeule la copie que vous ouvrez est mise à jour : celle que vous lancerez ensuite décidera de votre version. Gardez celle que vous utilisez et placez l’autre dans la corbeille, ou ouvrez l’autre une fois et laissez-la se mettre à jour.',
  revealDuplicateApp: 'Afficher l’autre copie dans le Finder',

  headerVersion: 'Version {{version}}',
  headerChecking: 'Vérification…',
  headerAvailable: 'Version {{version}} disponible',
  headerUpToDate: 'À jour · vérifié {{when}}',

  cardReadyTitle: 'v{{version}} prête',
  cardReadySubtitle: 'Redémarrer pour installer · v{{current}}',
  cardRestart: 'Redémarrer pour installer',
  cardAvailableTitle: 'v{{version}} disponible',
  cardAvailableSubtitle: 'Actuellement v{{current}} · vérifié {{when}}',
  cardUpdate: 'Mettre à jour',
  cardUpdating: 'Mise à jour…',
} as const;
