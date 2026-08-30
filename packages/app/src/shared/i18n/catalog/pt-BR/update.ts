export const update = {
  staleRoots: 'Os clientes MCP ainda usam a v{{version}}',
  staleRootsTitle:
    'Seus editores iniciam o trace-mcp a partir de {{pkgDir}}, que está na v{{version}}. Essa cópia foi instalada por outro npm, então atualizar este app não mexeu nela — até que ela seja atualizada, todo cliente MCP continua usando o servidor antigo.\n\nAtualize-a por um terminal:\n{{command}}',
  copyStaleRootCommand: 'Copiar o comando de atualização',

  headerVersion: 'Versão {{version}}',
  headerChecking: 'Verificando…',
  headerAvailable: 'Versão {{version}} disponível',
  headerUpToDate: 'Atualizado · verificado {{when}}',

  cardReadyTitle: 'v{{version}} pronta',
  cardReadySubtitle: 'Reinicie para instalar · v{{current}}',
  cardRestart: 'Reiniciar para instalar',
  cardAvailableTitle: 'v{{version}} disponível',
  cardAvailableSubtitle: 'Você está na v{{current}} · verificado {{when}}',
  cardUpdate: 'Atualizar',
  cardUpdating: 'Atualizando…',
} as const;
