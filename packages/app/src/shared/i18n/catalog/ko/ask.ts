export const ask = {
  title: 'Ask',

  noProviderTitle: 'AI 제공자 연결',
  noProviderSubtitle:
    'Ask는 사용자가 지정한 모델로 이 프로젝트에 대한 질문에 답합니다. 설정에서 제공자를 추가하면 켜집니다.',
  openAiSettings: 'AI 설정 열기',

  chats: '대화',
  newChat: '새 대화',
  noChats: '아직 대화가 없습니다.',
  untitled: '제목 없음',
  deleteChat: '대화 삭제 (⌫)',
  connectingProvider: '연결 중…',
  noProvider: '제공자 없음',

  showContextPanel: '컨텍스트 패널 표시',
  hideContextPanel: '컨텍스트 패널 숨기기',
  showContext: '컨텍스트 표시',
  hideContext: '컨텍스트 숨기기',
  loadingChat: '대화 불러오는 중',
  conversation: '대화 내용',

  emptyTitle: '이 코드베이스에 대해 무엇이든 물어보세요',
  emptySubtitle:
    '답변은 인덱싱된 그래프 — 이 프로젝트에 이미 있는 파일, 심볼, 결정 — 에 근거합니다.',
  slashCommands: '슬래시 명령',
  slashFind: '이름으로 심볼 검색',
  slashImpact: '심볼의 변경 영향 표시',
  slashScan: '보안 스캔 실행 (OWASP 주요 항목)',
  suggestionAuth: '인증은 어떻게 동작하나요?',
  suggestionPlugins: '플러그인 시스템을 설명해 주세요',
  suggestionRoutes: 'API 라우트는 어디에 있나요?',

  retrieving: '코드베이스 검색 중',
  thinking: '생각하는 중',
  sendAgain: '다시 보내기',

  composerLabel: '이 프로젝트에 대해 질문',
  composerPlaceholder: '이 프로젝트에 대해 질문하거나 /를 입력해 명령을 사용하세요',
  stopGenerating: '생성 중지',
  sendMessage: '메시지 보내기',
  sendShortcut: '보내기 (⌘↵)',
  copyCode: '코드 복사',
  copied: '복사됨',

  context: '컨텍스트',
  noContextTitle: '아직 컨텍스트 없음',
  noContextSubtitle:
    '메시지를 보내면 모델이 읽은 파일, 심볼, 결정이 여기에 표시됩니다. 슬래시 명령은 컨텍스트를 가져오지 않습니다.',
  filesRead: '읽은 파일',
  noFilesRead: '읽은 파일이 없습니다.',
  symbolsRead: '읽은 심볼',
  decisionsConsulted: '참고한 결정',

  loadSessionFailed: '세션을 불러오지 못했습니다',
  createSessionFailed: '세션을 만들지 못했습니다',
  noSession: '대화 세션을 시작할 수 없습니다',
  slashFailed: '슬래시 명령이 실패했습니다',
  unknownError: '알 수 없는 오류',
} as const;
