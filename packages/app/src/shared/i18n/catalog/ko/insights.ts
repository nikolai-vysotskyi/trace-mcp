export const insights = {
  title: '인사이트',
  reportPicker: '리포트',
  run: '실행',
  refresh: '새로고침',
  running: '실행 중…',
  runAction: '{{report}} {{action}}',
  unknownError: '알 수 없는 오류',
  errorInit: '데몬과 세션을 시작하지 못했습니다 (HTTP {{status}}).',
  errorNoSession: '데몬이 세션을 시작했지만 이름을 반환하지 않았습니다.',
  errorHttp: '리포트 요청이 실패했습니다 (HTTP {{status}}). {{detail}}',
  errorToolFailed: '리포트가 실행되지 않았습니다.',

  reportDriftTitle: 'CLAUDE.md 불일치',
  reportDriftDescription: '에이전트 설정 파일의 오래된 경로와 사라진 심볼 참조.',
  reportPagerankTitle: '중심 파일 상위',
  reportPagerankDescription: '임포트 그래프의 PageRank 기준으로 구조상 가장 중심이 되는 파일.',
  reportRiskTitle: '위험 핫스팟',
  reportRiskDescription: '복잡도가 높고 git 변경도 잦은 파일.',

  runningDrift: '에이전트 설정을 인덱스와 대조하는 중…',
  runningPagerank: '임포트 중심성으로 파일 순위를 매기는 중…',
  runningRisk: '복잡도와 git 변경 빈도를 대조하는 중…',

  emptyTitle: '보고할 내용 없음',
  emptyBody: '이 리포트는 비어 있습니다 — 지금 프로젝트에 해당하는 항목이 없습니다.',

  noDescription: '(설명 없음)',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: '수정: {{fix}}',
  rowScore: '점수 {{score}}',
  rowHotspot: '복잡도 {{complexity}} · 커밋 {{commits}}',
  rowHotspotConfidence: '복잡도 {{complexity}} · 커밋 {{commits}} · {{confidence}}',
} as const;
