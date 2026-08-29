export const clients = {
  title: 'MCP 클라이언트',
  refresh: '클라이언트 새로고침',

  supported: '지원되는 클라이언트',
  sessions: '활성 세션',
  detecting: '클라이언트 탐지 중',
  loadingSessions: '세션 불러오는 중',

  daemonDownTitle: '데몬에 연결할 수 없음',
  daemonDownSubtitle:
    'trace-mcp 클라이언트는 로컬 데몬을 통해 연결됩니다. 데몬을 시작하면 확인하고 설정할 수 있습니다.',
  startDaemon: '데몬 시작',
  starting: '시작하는 중…',

  noSessionsTitle: '활성 세션 없음',
  noSessionsSubtitle: '클라이언트가 데몬에 연결하면 세션이 여기에 표시됩니다.',
  unnamedSession: '이름 없는 세션',

  sessionActive: '활성',
  sessionIdle: '대기',
  sessionStale: '오래됨',

  connected: '연결됨',
  connect: '연결',
  connecting: '연결 중…',
  updateAvailable: '업데이트 있음',
  update: '업데이트',
  updating: '업데이트 중…',
  driftedField: '어긋난 필드: {{field}}',
  setUpManually: '수동으로 설정…',
  hideSteps: '단계 숨기기',

  enforcementLevel: '적용 수준',
  levelBase: '기본',
  levelBaseHint: 'CLAUDE.md만 — 느슨한 라우팅 규칙',
  levelStandard: '표준',
  levelStandardHint: 'CLAUDE.md와 훅',
  levelMax: '최대',
  levelMaxHint: 'CLAUDE.md, 훅, tweakcc — 권장',
} as const;
