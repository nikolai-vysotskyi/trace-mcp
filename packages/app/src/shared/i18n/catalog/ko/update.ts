export const update = {
  staleRoots: 'MCP 클라이언트가 아직 v{{version}}을 사용합니다',
  staleRootsTitle:
    '편집기는 {{pkgDir}}에서 trace-mcp를 실행하며, 그 위치는 v{{version}}입니다. 다른 npm으로 설치한 사본이라 이 앱을 업데이트해도 바뀌지 않았습니다. 업데이트하기 전까지 모든 MCP 클라이언트는 예전 서버를 계속 사용합니다.\n\n터미널에서 업데이트하세요:\n{{command}}',
  copyStaleRootCommand: '업데이트 명령 복사',

  headerVersion: '버전 {{version}}',
  headerChecking: '확인하는 중…',
  headerAvailable: '버전 {{version}} 사용 가능',
  headerManualInstall: '버전 {{version}}은 수동 설치가 필요합니다',
  headerUpToDate: '최신 상태 · {{when}} 확인',

  cardReadyTitle: 'v{{version}} 준비됨',
  cardReadySubtitle: '다시 시작하면 설치 · 현재 v{{current}}',
  cardRestart: '다시 시작해 설치',
  cardStuckTitle: 'v{{version}}은 수동 설치가 필요합니다',
  cardStuckSubtitle:
    '명령줄 도구는 업데이트됐지만 앱 자체는 여전히 v{{current}}입니다 — 자기 번들을 교체하지 못했습니다. 릴리스를 내려받아 응용 프로그램 폴더로 끌어다 놓으세요.',
  cardDownload: 'v{{version}} 내려받기',
  cardStuckQuarantine:
    'macOS가 내려받은 파일을 손상됐다고 알릴 수 있습니다. 실제로는 정상입니다 — 응용 프로그램 폴더로 옮긴 뒤 아래를 한 번 실행하세요:',
  copyQuarantineCommand: '명령 복사',
  cardAvailableTitle: 'v{{version}} 사용 가능',
  cardAvailableSubtitle: '현재 v{{current}} · {{when}} 확인',
  cardUpdate: '업데이트',
  cardUpdating: '업데이트 중…',
} as const;
