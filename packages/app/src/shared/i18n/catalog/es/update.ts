export const update = {
  staleRoots: 'Los clientes MCP siguen usando la v{{version}}',
  staleRootsTitle:
    'Tus editores lanzan trace-mcp desde {{pkgDir}}, que está en la v{{version}}. Esa copia la instaló otro npm, así que actualizar esta app no la tocó: hasta que se actualice, todos los clientes MCP seguirán usando el servidor antiguo.\n\nActualízala desde un terminal:\n{{command}}',
  copyStaleRootCommand: 'Copiar el comando de actualización',

  headerVersion: 'Versión {{version}}',
  headerChecking: 'Comprobando…',
  headerAvailable: 'Versión {{version}} disponible',
  headerUpToDate: 'Actualizado · comprobado {{when}}',

  cardReadyTitle: 'v{{version}} lista',
  cardReadySubtitle: 'Reinicia para instalarla · v{{current}}',
  cardRestart: 'Reiniciar para instalar',
  cardAvailableTitle: 'v{{version}} disponible',
  cardAvailableSubtitle: 'Ahora en la v{{current}} · comprobado {{when}}',
  cardUpdate: 'Actualizar',
  cardUpdating: 'Actualizando…',
} as const;
