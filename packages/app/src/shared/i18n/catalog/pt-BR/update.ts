export const update = {
  staleRoots: 'Os clientes MCP ainda usam a v{{version}}',
  staleRootsTitle:
    'Seus editores iniciam o trace-mcp a partir de {{pkgDir}}, que está na v{{version}}. Essa cópia foi instalada por outro npm, então atualizar este app não mexeu nela — até que ela seja atualizada, todo cliente MCP continua usando o servidor antigo.\n\nAtualize-a por um terminal:\n{{command}}',
  copyStaleRootCommand: 'Copiar o comando de atualização',

  headerVersion: 'Versão {{version}}',
  headerChecking: 'Verificando…',
  headerAvailable: 'Versão {{version}} disponível',
  headerManualInstall: 'A versão {{version}} exige instalação manual',
  headerUpToDate: 'Atualizado · verificado {{when}}',

  cardReadyTitle: 'v{{version}} pronta',
  cardReadySubtitle: 'Reinicie para instalar · v{{current}}',
  cardRestart: 'Reiniciar para instalar',
  cardStuckTitle: 'A v{{version}} exige instalação manual',
  cardStuckSubtitle:
    'A ferramenta de linha de comando foi atualizada, mas o app em si continua na v{{current}} — ele não conseguiu substituir o próprio pacote. Baixe a release e arraste-a para Aplicativos.',
  cardDownload: 'Baixar a v{{version}}',
  cardStuckQuarantine:
    'O macOS vai dizer que o download está danificado. Não está — rode isto uma vez depois de movê-lo para Aplicativos:',
  copyQuarantineCommand: 'Copiar comando',
  cardAvailableTitle: 'v{{version}} disponível',
  cardAvailableSubtitle: 'Você está na v{{current}} · verificado {{when}}',
  cardUpdate: 'Atualizar',
  cardUpdating: 'Atualizando…',
} as const;
