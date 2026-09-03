export const update = {
  staleRoots: 'MCP 클라이언트가 아직 v{{version}}을 사용합니다',
  staleRootsTitle:
    '편집기는 {{pkgDir}}에서 trace-mcp를 실행하며, 그 위치는 v{{version}}입니다. 다른 npm으로 설치한 사본이라 이 앱을 업데이트해도 바뀌지 않았습니다. 업데이트하기 전까지 모든 MCP 클라이언트는 예전 서버를 계속 사용합니다.\n\n터미널에서 업데이트하세요:\n{{command}}',
  copyStaleRootCommand: '업데이트 명령 복사',

  duplicateApps: '두 곳 이상에 설치됨',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — 실행 중',
  duplicateAppsTitle:
    '이 Mac에 trace-mcp 사본이 두 개 이상 있습니다:\n\n{{list}}\n\n업데이트는 실행한 사본에만 적용되므로 다음에 여는 사본이 버전을 결정합니다. 사용하는 사본을 남기고 다른 하나는 휴지통으로 옮기거나, 다른 사본을 한 번 열어 스스로 업데이트하게 하세요.',
  revealDuplicateApp: '다른 사본을 Finder에서 보기',

  headerVersion: '버전 {{version}}',
  headerChecking: '확인하는 중…',
  headerAvailable: '버전 {{version}} 사용 가능',
  headerUpToDate: '최신 상태 · {{when}} 확인',
  headerDaemonAvailable: '데몬 업데이트 사용 가능 · v{{version}}',
  headerBothAvailable: '앱과 데몬 업데이트가 모두 있습니다',

  cardReadyTitle: 'v{{version}} 준비됨',
  cardReadySubtitle: '다시 시작하면 설치 · 현재 v{{current}}',
  cardRestart: '다시 시작해 설치',
  cardAvailableTitle: 'v{{version}} 사용 가능',
  cardAvailableSubtitle: '현재 v{{current}} · {{when}} 확인',
  cardUpdate: '업데이트',
  cardUpdating: '업데이트 중…',

  settingsTitle: '업데이트',
  settingsAppRow: '앱',
  settingsDaemonRow: '데몬',
  settingsCheck: '업데이트 확인',
} as const;
