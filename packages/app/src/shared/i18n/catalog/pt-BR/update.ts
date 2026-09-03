export const update = {
  staleRoots: 'Os clientes MCP ainda usam a v{{version}}',
  staleRootsTitle:
    'Seus editores iniciam o trace-mcp a partir de {{pkgDir}}, que está na v{{version}}. Essa cópia foi instalada por outro npm, então atualizar este app não mexeu nela — até que ela seja atualizada, todo cliente MCP continua usando o servidor antigo.\n\nAtualize-a por um terminal:\n{{command}}',
  copyStaleRootCommand: 'Copiar o comando de atualização',

  duplicateApps: 'Instalado mais de uma vez',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — em execução',
  duplicateAppsTitle:
    'Este Mac tem mais de uma cópia do trace-mcp:\n\n{{list}}\n\nSó a cópia que você abre é atualizada, então a próxima que iniciar decide sua versão. Mantenha a que usa e mova a outra para o Lixo — ou abra a outra uma vez e deixe que ela se atualize.',
  revealDuplicateApp: 'Mostrar a outra cópia no Finder',

  headerVersion: 'Versão {{version}}',
  headerChecking: 'Verificando…',
  headerAvailable: 'Versão {{version}} disponível',
  headerUpToDate: 'Atualizado · verificado {{when}}',
  headerDaemonAvailable: 'Atualização do daemon disponível · v{{version}}',
  headerBothAvailable: 'Há atualizações do app e do daemon',

  cardReadyTitle: 'v{{version}} pronta',
  cardReadySubtitle: 'Reinicie para instalar · v{{current}}',
  cardRestart: 'Reiniciar para instalar',
  cardAvailableTitle: 'v{{version}} disponível',
  cardAvailableSubtitle: 'Você está na v{{current}} · verificado {{when}}',
  cardUpdate: 'Atualizar',
  cardUpdating: 'Atualizando…',

  settingsTitle: 'Atualizações',
  settingsAppRow: 'App',
  settingsDaemonRow: 'Daemon',
  settingsCheck: 'Buscar atualizações',
} as const;
