export const update = {
  staleRoots: 'Les clients MCP utilisent toujours la v{{version}}',
  staleRootsTitle:
    'Vos éditeurs lancent trace-mcp depuis {{pkgDir}}, qui est en v{{version}}. Cette copie a été installée par un autre npm : mettre à jour cette app ne l’a pas touchée — tant qu’elle n’est pas mise à jour, tous les clients MCP continuent d’utiliser l’ancien serveur.\n\nMettez-la à jour depuis un terminal :\n{{command}}',
  copyStaleRootCommand: 'Copier la commande de mise à jour',

  headerVersion: 'Version {{version}}',
  headerChecking: 'Vérification…',
  headerAvailable: 'Version {{version}} disponible',
  headerManualInstall: 'La version {{version}} demande une installation manuelle',
  headerUpToDate: 'À jour · vérifié {{when}}',

  cardReadyTitle: 'v{{version}} prête',
  cardReadySubtitle: 'Redémarrer pour installer · v{{current}}',
  cardRestart: 'Redémarrer pour installer',
  cardStuckTitle: 'La v{{version}} demande une installation manuelle',
  cardStuckSubtitle:
    'L’outil en ligne de commande a été mis à jour, mais l’app elle-même est encore en v{{current}} — elle n’a pas pu remplacer son propre bundle. Téléchargez la version et glissez-la dans Applications.',
  cardDownload: 'Télécharger la v{{version}}',
  cardStuckQuarantine:
    'macOS dira que le téléchargement est endommagé. Il ne l’est pas — lancez ceci une fois après l’avoir déplacé dans Applications :',
  copyQuarantineCommand: 'Copier la commande',
  cardAvailableTitle: 'v{{version}} disponible',
  cardAvailableSubtitle: 'Actuellement v{{current}} · vérifié {{when}}',
  cardUpdate: 'Mettre à jour',
  cardUpdating: 'Mise à jour…',
} as const;
