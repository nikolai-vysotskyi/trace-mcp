export const update = {
  staleRoots: 'Los clientes MCP siguen usando la v{{version}}',
  staleRootsTitle:
    'Tus editores lanzan trace-mcp desde {{pkgDir}}, que está en la v{{version}}. Esa copia la instaló otro npm, así que actualizar esta app no la tocó: hasta que se actualice, todos los clientes MCP seguirán usando el servidor antiguo.\n\nActualízala desde un terminal:\n{{command}}',
  copyStaleRootCommand: 'Copiar el comando de actualización',

  duplicateApps: 'Instalada más de una vez',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — en ejecución',
  duplicateAppsTitle:
    'Este Mac tiene más de una copia de trace-mcp:\n\n{{list}}\n\nSolo se actualiza la copia que abres, así que la que inicies la próxima vez decide tu versión. Conserva la que usas y mueve la otra a la Papelera, o ábrela una vez y deja que se actualice sola.',
  revealDuplicateApp: 'Mostrar la otra copia en el Finder',

  headerVersion: 'Versión {{version}}',
  headerChecking: 'Comprobando…',
  headerAvailable: 'Versión {{version}} disponible',
  headerUpToDate: 'Actualizado · comprobado {{when}}',
  headerDaemonAvailable: 'Actualización del daemon disponible · v{{version}}',
  headerBothAvailable: 'Hay actualizaciones de la app y del daemon',

  cardReadyTitle: 'v{{version}} lista',
  cardReadySubtitle: 'Reinicia para instalarla · v{{current}}',
  cardRestart: 'Reiniciar para instalar',
  cardAvailableTitle: 'v{{version}} disponible',
  cardAvailableSubtitle: 'Ahora en la v{{current}} · comprobado {{when}}',
  cardUpdate: 'Actualizar',
  cardUpdating: 'Actualizando…',

  settingsTitle: 'Actualizaciones',
  settingsAppRow: 'App',
  settingsDaemonRow: 'Daemon',
  settingsCheck: 'Buscar actualizaciones',
} as const;
