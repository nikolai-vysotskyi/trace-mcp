export const update = {
  staleRoots: 'Les clients MCP utilisent toujours la v{{version}}',
  staleRootsTitle:
    'Vos éditeurs lancent trace-mcp depuis {{pkgDir}}, qui est en v{{version}}. Cette copie a été installée par un autre npm : mettre à jour cette app ne l’a pas touchée — tant qu’elle n’est pas mise à jour, tous les clients MCP continuent d’utiliser l’ancien serveur.\n\nMettez-la à jour depuis un terminal :\n{{command}}',
  copyStaleRootCommand: 'Copier la commande de mise à jour',

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
