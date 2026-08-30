export const settings = {
  title: '설정',
  back: '뒤로',
  moreActions: '추가 작업',
  search: '설정 검색',
  copyDaemon: '데몬 정보 복사',
  editConfigFile: '설정 파일 편집…',
  noMatches: '“{{query}}”와 일치하는 설정이 없습니다.',

  'group.general': '일반',
  'group.intelligence': '인텔리전스',
  'group.quality': '품질 및 보안',
  'group.infrastructure': '인프라',
  'group.development': '개발',
  'group.monitoring': '모니터링',
  'group.advanced': '고급',

  'daemon.title': '데몬',
  'daemon.state': '실행 중',
  'daemon.summary': '실행 중 · 포트 {{port}} · 가동 {{uptime}}',
  'uptime.seconds': '{{value}}초',
  'uptime.minutes': '{{value}}분',
  'uptime.hours': '{{value}}시간',
  'uptime.hoursMinutes': '{{hours}}시간 {{minutes}}분',

  'app.title': '앱',
  'app.language': '언어',
  'appearance.theme': '테마',

  'empty.loading': '설정을 불러오는 중…',
  'empty.unreadableTitle': '설정을 읽지 못했습니다',
  'empty.unreadableBody':
    '데몬은 실행 중이지만 설정을 반환하지 않았습니다. 데몬을 다시 시작하면 대개 해결됩니다.',
  'empty.unreachableTitle': '데몬에 연결할 수 없음',
  'empty.unreachableBody':
    '설정은 데몬의 설정 파일에 있으므로 데몬이 실행 중이어야 읽을 수 있습니다.',
  'empty.starting': '시작하는 중…',
  'empty.restart': '데몬 다시 시작',
  'empty.start': '데몬 시작',

  modified: '변경됨',
  issues_other: '문제 {{count}}개',

  reset: '초기화',
  resetSection: '이 섹션을 기본값으로 되돌리기',
  notSet: '설정 안 됨',
  'field.aria': '{{label}}: {{value}}',
  'field.ariaUnset': '{{label}}: 설정 안 됨',
  invalidJson: '잘못된 JSON',

  'models.select': '모델 선택…',
  'models.filter': '모델 필터',
  'models.loading': '모델을 불러오는 중…',
  'models.retry': '다시 시도',
  'models.none': '모델을 찾지 못함',
  'models.noMatches': '일치 항목 없음',
  'models.clear': '선택 해제',
  'models.type': '또는 모델 이름을 입력…',
  'models.typeAria': '모델 이름 입력',
  'models.failed': '모델 목록을 가져오지 못했습니다',
  'models.httpError': '{{provider}}: {{status}}',
  'models.authError': '{{provider}}: {{status}} (API 키 확인)',

  'projects.title': '프로젝트별 재정의',
  'projects.intro':
    '특정 프로젝트에 대해 전역 설정을 재정의합니다. 값은 전역 설정 위에 병합됩니다.',
  'projects.done': '완료',
  'projects.edit': '편집',
  'projects.remove': '제거',
  'projects.apply': '적용',
  'projects.add': '추가',
  'projects.pathAria': '프로젝트 경로',
  'projects.overridesAria': '{{path}}의 재정의',

  'diff.title': '적용 대기 중인 변경',
  'diff.hide': '숨기기',
  'bar.hasErrors': '저장하기 전에 위 문제를 해결하세요',
  'bar.saved': '저장됨',
  'bar.saveFailed': '저장하지 못했습니다 — 데몬이 변경을 거부했습니다',
  'bar.unsaved_other': '저장하지 않은 변경 {{count}}개',
  'bar.hideChanges': '변경 사항 숨기기',
  'bar.reviewChanges': '변경 사항 검토',
  'bar.discard': '취소',
  'bar.saving': '저장하는 중…',
  'bar.save': '저장',

  'activity.title': 'AI 활동',
  'activity.armed': '다음에 여는 프로젝트 창은 활동 → AI 호출로 열립니다.',
  'activity.idle': '최근 임베딩, LLM, 재순위 요청은 프로젝트 창의 활동에서 볼 수 있습니다.',
  'activity.ready': '준비됨',
  'activity.open': '다음에 여기서 열기',

  'validate.boolean': 'true 또는 false여야 합니다',
  'validate.number': '숫자여야 합니다',
  'validate.min': '최소: {{min}}',
  'validate.max': '최대: {{max}}',
  'validate.string': '문자열이어야 합니다',
  'validate.tooLong': '너무 깁니다 (최대 {{max}}자)',
  'validate.pattern': '다음과 일치해야 합니다: {{pattern}}',
  'validate.oneOf': '다음 중 하나여야 합니다: {{options}}',
  'validate.list': '목록이어야 합니다',
  'validate.json': '문자열이 아닌 올바른 JSON이어야 합니다',

  'schema._root.label': '일반',
  'schema._root.description': '자동 업데이트 및 최상위 설정',
  'schema.ai.label': 'AI 및 임베딩',
  'schema.ai.description': '시맨틱 검색, 요약, 의도 분류에 사용할 AI 제공자',
  'schema.security.label': '보안',
  'schema.security.description': '시크릿 탐지 및 파일 제한',
  'schema.predictive.label': '예측 분석',
  'schema.predictive.description': '버그 예측, 기술 부채 점수, 변경 위험',
  'schema.intent.label': '의도 및 도메인',
  'schema.intent.description': '도메인 분류 및 자동 태깅',
  'schema.runtime.label': '런타임 트레이싱 (OTLP)',
  'schema.runtime.description': 'OpenTelemetry 스팬 수집 및 트레이스 분석',
  'schema.topology.label': '리포지터리 간 토폴로지',
  'schema.topology.description': '하위 프로젝트 및 서비스 간 의존성 추적',
  'schema.lsp.label': 'LSP 보강',
  'schema.lsp.description': 'Language Server Protocol을 이용한 컴파일러 수준 호출 그래프 해석',
  'schema.quality_gates.label': '품질 게이트',
  'schema.quality_gates.description': '커밋과 PR에 대한 자동 품질 검사',
  'schema.tools.label': '툴 노출',
  'schema.tools.description': '어떤 MCP 툴을 어떻게 노출할지 제어',
  'schema.ignore.label': '제외 규칙',
  'schema.ignore.description': '인덱싱에서 건너뛸 추가 디렉터리와 패턴',
  'schema.frameworks.label': '프레임워크',
  'schema.frameworks.description': '프레임워크별 설정 (Laravel 등)',
  'schema.logging.label': '로깅',
  'schema.logging.description': '파일 로깅 및 로테이션',
  'schema.watch.label': '파일 감시',
  'schema.watch.description': '파일 변경 시 자동 재인덱싱',

  'schema.f.enabled': '사용',
  'schema.f.baseUrl': '기본 URL',
  'schema.f.apiKey': 'API 키',
  'schema.f.inferenceModel': '추론 모델',
  'schema.f.fastModel': '고속 모델',
  'schema.f.embeddingModel': '임베딩 모델',
  'schema.f.rerankerModel': '재순위 모델',
  'schema.f.autoDetect': '서버 자동 감지',
  'schema.f.batchSize': '배치 크기',

  'schema._root.auto_update.label': '자동 업데이트',
  'schema._root.interval.label': '업데이트 확인 주기 (시간)',
  'schema._root.logLevel.label': '데몬 로그 수준',

  'schema.ai.provider.label': '제공자',
  'schema.ai.provider.description':
    'onnx = 설정 없이 로컬 실행. ollama/lmstudio = 모델을 고를 수 있는 로컬 실행. gemini = Google Generative Language API (개인용, AIza 키). vertex = Google Vertex AI (GCP, OAuth 베어러 토큰 + 프로젝트/리전). voyage = Voyage AI 임베딩 전용. 그 외 = 클라우드 API.',
  'schema.ai.embedding.label': '임베딩 사용',
  'schema.ai.embedding.description':
    '시맨틱 검색과 재순위를 위한 벡터 임베딩을 생성합니다. 끄면 추론은 유지한 채 시맨틱 검색만 비활성화됩니다.',
  'schema.ai.inference.label': '추론 사용',
  'schema.ai.inference.description':
    '요약, 의도 분류, Ask에 LLM을 호출합니다. 끄면 임베딩은 유지한 채 모든 LLM 호출을 건너뜁니다.',
  'schema.ai.fast_inference.label': '고속 추론 사용',
  'schema.ai.fast_inference.description':
    '지연이 짧아야 하는 작업에 고속 모델을 사용합니다. 끄면 고속 경로 호출자는 빈 응답을 받습니다 — 디버깅 중이 아니면 켜 두세요.',

  'schema.ai.ollama.base_url.description':
    'Ollama 서버 엔드포인트. 다른 호스트나 포트에서 실행 중이면 변경하세요.',
  'schema.ai.lmstudio.base_url.description': 'LM Studio 로컬 서버 엔드포인트.',
  'schema.ai.openai.base_url.description':
    'OpenAI API 엔드포인트. Azure OpenAI나 호환 제공자를 쓰려면 변경하세요.',
  'schema.ai.openai.api_key.description': '필수. 또는 OPENAI_API_KEY 환경 변수를 설정하세요.',
  'schema.ai.anthropic.api_key.description':
    'console.anthropic.com에서 발급한 Anthropic API 키. 또는 ANTHROPIC_API_KEY 환경 변수를 설정하세요.',
  'schema.ai.gemini.api_key.description':
    'ai.google.dev에서 발급한 Google Generative Language API 키 (AIza로 시작). 또는 GEMINI_API_KEY 환경 변수를 설정하세요. GCP/Vertex를 쓴다면 "vertex" 제공자를 사용하세요.',
  'schema.ai.vertex.api_key.label': '액세스 토큰',
  'schema.ai.vertex.api_key.description':
    'OAuth2 베어러 토큰 (수명 약 1시간). gcloud auth print-access-token으로 발급하거나 GOOGLE_ACCESS_TOKEN 환경 변수를 설정하세요.',
  'schema.ai.vertex.project.label': 'GCP 프로젝트',
  'schema.ai.vertex.project.description':
    'Vertex AI를 호스팅하는 Google Cloud 프로젝트 ID. 또는 GOOGLE_CLOUD_PROJECT 환경 변수를 설정하세요.',
  'schema.ai.vertex.location.label': 'GCP 리전',
  'schema.ai.vertex.location.description':
    'Vertex AI 리전 (예: us-central1, europe-west4, asia-northeast1). 또는 GOOGLE_CLOUD_LOCATION 환경 변수를 설정하세요.',
  'schema.ai.voyage.base_url.description': 'Voyage AI 엔드포인트. 보통 기본값을 씁니다.',
  'schema.ai.voyage.api_key.description':
    'dash.voyageai.com에서 발급한 Voyage API 키. 또는 VOYAGE_API_KEY 환경 변수를 설정하세요. 임베딩 전용 — 추론은 지원하지 않습니다.',
  'schema.ai.mistral.base_url.description': 'Mistral API 엔드포인트.',
  'schema.ai.mistral.api_key.description':
    'console.mistral.ai에서 발급한 Mistral API 키. 또는 MISTRAL_API_KEY 환경 변수를 설정하세요.',
  'schema.ai.groq.base_url.description': 'Groq API 엔드포인트.',
  'schema.ai.groq.api_key.description':
    'console.groq.com에서 발급한 Groq API 키. 또는 GROQ_API_KEY 환경 변수를 설정하세요.',
  'schema.ai.together.base_url.description': 'Together AI API 엔드포인트.',
  'schema.ai.together.api_key.description':
    'api.together.ai에서 발급한 Together API 키. 또는 TOGETHER_API_KEY 환경 변수를 설정하세요.',
  'schema.ai.deepseek.base_url.description': 'DeepSeek API 엔드포인트.',
  'schema.ai.deepseek.api_key.description':
    'platform.deepseek.com에서 발급한 DeepSeek API 키. 또는 DEEPSEEK_API_KEY 환경 변수를 설정하세요.',
  'schema.ai.xai.base_url.description': 'xAI (Grok) API 엔드포인트.',
  'schema.ai.xai.api_key.description':
    'console.x.ai에서 발급한 xAI API 키. 또는 XAI_API_KEY 환경 변수를 설정하세요.',

  'schema.ai.ollama.inference_model.description': '요약과 의도 분류에 쓰는 LLM.',
  'schema.ai.ollama.fast_model.description':
    '지연이 짧아야 하는 작업용 소형·고속 LLM. 없으면 추론 모델로 대체됩니다.',
  'schema.ai.ollama.embedding_model.description':
    '시맨틱 검색용 임베딩 모델. embedding_dimensions와 일치해야 합니다.',
  'schema.ai.ollama.reranker_model.description': '검색 결과 재순위용 크로스 인코더.',
  'schema.ai.lmstudio.inference_model.description': 'LM Studio에 로드된 LLM.',
  'schema.ai.lmstudio.fast_model.description': '지연이 짧아야 하는 작업용 고속 LLM.',
  'schema.ai.lmstudio.embedding_model.description': 'LM Studio에 로드된 임베딩 모델.',
  'schema.ai.openai.inference_model.description': '요약과 의도 분류에 쓰는 LLM.',
  'schema.ai.openai.fast_model.description':
    '더 빠르고 저렴한 LLM. 없으면 추론 모델로 대체됩니다.',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small (저렴) 또는 text-embedding-3-large (정확).',
  'schema.ai.anthropic.inference_model.description': '요약과 추론에 쓰는 Claude 모델.',
  'schema.ai.anthropic.fast_model.description': '지연이 짧아야 하는 작업용 가장 빠른 Claude 모델.',
  'schema.ai.gemini.inference_model.description': '요약용 Gemini 모델.',
  'schema.ai.gemini.fast_model.description': '지연이 짧아야 하는 작업용 고속 Gemini 모델.',
  'schema.ai.gemini.embedding_model.description':
    'Gemini 임베딩 모델. text-embedding-004 (768차원)을 권장합니다.',
  'schema.ai.vertex.inference_model.description':
    'Vertex에서 호스팅하는 요약용 모델 (예: gemini-2.5-flash, gemini-2.5-pro).',
  'schema.ai.vertex.fast_model.description': '지연이 짧아야 하는 작업용 고속 Vertex 모델.',
  'schema.ai.vertex.embedding_model.description':
    'Vertex 임베딩 모델 (예: text-embedding-005 768차원, gemini-embedding-001 3072차원).',
  'schema.ai.voyage.embedding_model.description':
    'Voyage 임베딩 모델. voyage-code-3 (1024차원)은 소스 코드에 맞게 튜닝돼 있습니다.',
  'schema.ai.mistral.inference_model.description': '요약용 Mistral LLM.',
  'schema.ai.mistral.fast_model.description': '고속 Mistral 모델.',
  'schema.ai.mistral.embedding_model.description': 'Mistral 임베딩 모델 (1024차원).',
  'schema.ai.groq.inference_model.description': 'Groq에서 호스팅하는 LLM. 매우 빠른 추론.',
  'schema.ai.groq.fast_model.description': '지연이 짧아야 하는 작업용 가장 빠른 Groq 모델.',
  'schema.ai.groq.embedding_model.description': 'Groq 임베딩 모델.',
  'schema.ai.together.inference_model.description': 'Together에서 호스팅하는 LLM.',
  'schema.ai.together.fast_model.description': '고속 Together 모델.',
  'schema.ai.together.embedding_model.description': 'Together 임베딩 모델.',
  'schema.ai.deepseek.inference_model.description': '요약과 추론에 쓰는 DeepSeek V3.',
  'schema.ai.deepseek.fast_model.description': 'DeepSeek 고속 모델.',
  'schema.ai.xai.inference_model.description': '요약용 Grok 모델.',
  'schema.ai.xai.fast_model.description': '고속 Grok 모델.',
  'schema.ai.onnx.embedding_model.description':
    '로컬 임베딩용 ONNX 모델. 기본값 그대로 바로 동작합니다.',

  'schema.ai.dimensions.label': '임베딩 차원 수',
  'schema.ai.dimensions.description':
    '벡터 크기. 모델과 일치해야 합니다 (MiniLM 384, nomic/Gemini/Vertex text-embedding-005 768, Mistral/voyage-code-3 1024, OpenAI 1536, gemini-embedding-001 3072).',
  'schema.ai.summarize.label': '인덱싱 시 요약',
  'schema.ai.summarize.description':
    '인덱싱 중에 자연어 요약을 생성합니다. 추론 모델이 있는 제공자가 필요합니다.',
  'schema.ai.summarize_batch.label': '요약 배치 크기',
  'schema.ai.summarize_batch.description': '배치당 병렬로 요약할 심볼 수.',
  'schema.ai.summarize_kinds.label': '요약할 심볼 종류',
  'schema.ai.summarize_kinds.description': '어떤 심볼 종류에 요약을 생성할지 지정합니다.',
  'schema.ai.concurrency.label': '동시 실행 수',
  'schema.ai.concurrency.description':
    '병렬 AI 요청 수. Ollama에서는 OLLAMA_NUM_PARALLEL과 맞추세요.',

  'schema.security.secret_patterns.label': '시크릿 패턴',
  'schema.security.max_file_size.label': '최대 파일 크기 (바이트)',
  'schema.security.max_files.label': '프로젝트당 최대 파일 수',

  'schema.predictive.cache_ttl.label': '캐시 TTL (분)',
  'schema.predictive.git_since.label': 'git 기록 범위 (일)',
  'schema.predictive.module_depth.label': '모듈 깊이',
  'schema.predictive.weights.label': '가중치',
  'schema.predictive.weights.description': '버그/부채/위험 점수 가중치',

  'schema.intent.auto_classify.label': '인덱싱 시 자동 분류',
  'schema.intent.domain_hints.label': '도메인 힌트',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': '사용자 정의 도메인',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  'schema.runtime.port.label': 'OTLP 포트',
  'schema.runtime.host.label': 'OTLP 호스트',
  'schema.runtime.max_body.label': '최대 본문 바이트',
  'schema.runtime.max_span_age.label': '스팬 최대 보관 기간 (일)',
  'schema.runtime.max_aggregate_age.label': '집계 최대 보관 기간 (일)',
  'schema.runtime.prune_interval.label': '정리 주기',
  'schema.runtime.fqn_attributes.label': 'FQN 속성',
  'schema.runtime.route_patterns.label': '라우트 패턴',

  'schema.topology.auto_detect.label': '리포지터리 자동 감지',
  'schema.topology.auto_discover.label': '하위 프로젝트 자동 탐색',
  'schema.topology.repos.label': '추가 리포지터리 경로',
  'schema.topology.contract_globs.label': '계약 파일 glob',

  'schema.lsp.enabled.description': '인덱싱 후 LSP 보강 단계 실행',
  'schema.lsp.auto_detect.description':
    '사용 가능한 LSP 서버 자동 감지 (tsserver, pyright, gopls, rust-analyzer)',
  'schema.lsp.max_servers.label': '최대 동시 서버 수',
  'schema.lsp.max_servers.description': '병렬로 실행할 LSP 서버 프로세스 수 제한',
  'schema.lsp.timeout.label': '보강 제한 시간 (ms)',
  'schema.lsp.timeout.description': 'LSP 보강 단계 전체의 제한 시간',
  'schema.lsp.batch_size.description': '배치당 처리할 심볼 수',
  'schema.lsp.servers.label': '서버 재정의',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  'schema.quality_gates.fail_on.label': '실패 기준',
  'schema.quality_gates.rules.label': '규칙',
  'schema.quality_gates.rules.description': '규칙 임계값과 심각도',

  'schema.tools.preset.label': '프리셋',
  'schema.tools.include.label': '포함할 툴',
  'schema.tools.exclude.label': '제외할 툴',
  'schema.tools.description_verbosity.label': '설명 상세도',
  'schema.tools.instructions_verbosity.label': '지침 상세도',
  'schema.tools.meta_fields.label': '메타 필드',
  'schema.tools.compact_schemas.label': '스키마 축약',
  'schema.tools.compact_schemas.description':
    '툴 스키마에서 고급 파라미터를 제거해 토큰 사용량을 약 42% 줄입니다',
  'schema.tools.descriptions.label': '사용자 정의 설명',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  'schema.ignore.directories.label': '디렉터리',
  'schema.ignore.patterns.label': '패턴',

  'schema.frameworks.config.label': '구성',
  'schema.frameworks.config.description': '프레임워크 재정의',

  'schema.logging.file.label': '파일 로깅 사용',
  'schema.logging.path.label': '로그 파일 경로',
  'schema.logging.level.label': '로그 수준',
  'schema.logging.max_size.label': '최대 로그 크기 (MB)',

  'schema.watch.debounce.label': '디바운스 (ms)',
} as const;
