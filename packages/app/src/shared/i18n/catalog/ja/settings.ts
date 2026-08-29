export const settings = {
  title: '設定',
  back: '戻る',
  moreActions: 'その他の操作',
  search: '設定を検索',
  copyDaemon: 'デーモンの情報をコピー',
  editConfigFile: '設定ファイルを編集…',
  noMatches: '「{{query}}」に一致する設定はありません。',

  'group.general': '一般',
  'group.intelligence': 'インテリジェンス',
  'group.quality': '品質とセキュリティ',
  'group.infrastructure': 'インフラ',
  'group.development': '開発',
  'group.monitoring': 'モニタリング',
  'group.advanced': '詳細',

  'daemon.title': 'デーモン',
  'daemon.state': '稼働中',
  'daemon.summary': '稼働中 · ポート {{port}} · 稼働時間 {{uptime}}',
  'uptime.seconds': '{{value}}秒',
  'uptime.minutes': '{{value}}分',
  'uptime.hours': '{{value}}時間',
  'uptime.hoursMinutes': '{{hours}}時間 {{minutes}}分',

  'app.title': 'アプリ',
  'app.language': '言語',
  'appearance.theme': 'テーマ',

  'empty.loading': '設定を読み込み中…',
  'empty.unreadableTitle': '設定を読み込めませんでした',
  'empty.unreadableBody':
    'デーモンは動作していますが、設定を返しませんでした。再起動すると解消することが多いです。',
  'empty.unreachableTitle': 'デーモンに接続できません',
  'empty.unreachableBody':
    '設定はデーモンの設定ファイルにあるため、デーモンが動作していないと読み込めません。',
  'empty.starting': '起動中…',
  'empty.restart': 'デーモンを再起動',
  'empty.start': 'デーモンを起動',

  modified: '変更あり',
  issues_other: '{{count}} 件の問題',

  reset: 'リセット',
  resetSection: 'このセクションを初期値に戻す',
  notSet: '未設定',
  'field.aria': '{{label}}: {{value}}',
  'field.ariaUnset': '{{label}}: 未設定',
  invalidJson: 'JSON が不正です',

  'models.select': 'モデルを選択…',
  'models.filter': 'モデルを絞り込む',
  'models.loading': 'モデルを読み込み中…',
  'models.retry': '再試行',
  'models.none': 'モデルが見つかりません',
  'models.noMatches': '一致なし',
  'models.clear': '選択を解除',
  'models.type': 'モデル名を入力…',
  'models.typeAria': 'モデル名を入力',
  'models.failed': 'モデル一覧を取得できませんでした',
  'models.httpError': '{{provider}}: {{status}}',
  'models.authError': '{{provider}}: {{status}}（API キーを確認してください）',

  'projects.title': 'プロジェクトごとの上書き',
  'projects.intro':
    '特定のプロジェクトでグローバル設定を上書きします。値はグローバル設定に重ねて適用されます。',
  'projects.done': '完了',
  'projects.edit': '編集',
  'projects.remove': '削除',
  'projects.apply': '適用',
  'projects.add': '追加',
  'projects.pathAria': 'プロジェクトのパス',
  'projects.overridesAria': '{{path}} の上書き設定',

  'diff.title': '未適用の変更',
  'diff.hide': '隠す',
  'bar.hasErrors': '保存する前に上の問題を解決してください',
  'bar.saved': '保存しました',
  'bar.saveFailed': '保存できませんでした — デーモンが変更を拒否しました',
  'bar.unsaved_other': '未保存の変更 {{count}} 件',
  'bar.hideChanges': '変更を隠す',
  'bar.reviewChanges': '変更を確認',
  'bar.discard': '破棄',
  'bar.saving': '保存中…',
  'bar.save': '保存',

  'activity.title': 'AI アクティビティ',
  'activity.armed': '次に開くプロジェクトウインドウは、アクティビティ → AI リクエストで開きます。',
  'activity.idle':
    '最近の埋め込み・LLM・リランクのリクエストは、プロジェクトウインドウのアクティビティにあります。',
  'activity.ready': '準備完了',
  'activity.open': '次はそこを開く',

  'validate.boolean': 'true または false を指定してください',
  'validate.number': '数値を指定してください',
  'validate.min': '最小: {{min}}',
  'validate.max': '最大: {{max}}',
  'validate.string': '文字列を指定してください',
  'validate.tooLong': '長すぎます（最大 {{max}} 文字）',
  'validate.pattern': '次の形式に一致させてください: {{pattern}}',
  'validate.oneOf': '次のいずれかを指定してください: {{options}}',
  'validate.list': 'リストを指定してください',
  'validate.json': '有効な JSON を指定してください（文字列は不可）',

  'schema._root.label': '一般',
  'schema._root.description': '自動アップデートと全体設定',
  'schema.ai.label': 'AI と埋め込み',
  'schema.ai.description': 'セマンティック検索、要約、意図分類に使う AI プロバイダ',
  'schema.security.label': 'セキュリティ',
  'schema.security.description': 'シークレット検出とファイルの上限',
  'schema.predictive.label': '予測分析',
  'schema.predictive.description': 'バグ予測、技術的負債のスコア、変更リスク',
  'schema.intent.label': '意図とドメイン',
  'schema.intent.description': 'ドメイン分類と自動タグ付け',
  'schema.runtime.label': 'ランタイムトレース（OTLP）',
  'schema.runtime.description': 'OpenTelemetry のスパン取り込みとトレース分析',
  'schema.topology.label': 'リポジトリ横断のトポロジー',
  'schema.topology.description': 'サブプロジェクトとサービス間の依存関係の追跡',
  'schema.lsp.label': 'LSP による補完',
  'schema.lsp.description': 'Language Server Protocol によるコンパイラ精度のコールグラフ解決',
  'schema.quality_gates.label': '品質ゲート',
  'schema.quality_gates.description': 'コミットと PR に対する自動品質チェック',
  'schema.tools.label': 'ツールの公開',
  'schema.tools.description': 'どの MCP ツールをどう公開するかを制御します',
  'schema.ignore.label': '除外ルール',
  'schema.ignore.description': 'インデックス時にスキップする追加のディレクトリとパターン',
  'schema.frameworks.label': 'フレームワーク',
  'schema.frameworks.description': 'フレームワーク固有の設定（Laravel など）',
  'schema.logging.label': 'ログ',
  'schema.logging.description': 'ファイルへのログ出力とローテーション',
  'schema.watch.label': 'ファイル監視',
  'schema.watch.description': 'ファイル変更時の自動再インデックス',

  'schema.f.enabled': '有効',
  'schema.f.baseUrl': 'ベース URL',
  'schema.f.apiKey': 'API キー',
  'schema.f.inferenceModel': '推論モデル',
  'schema.f.fastModel': '高速モデル',
  'schema.f.embeddingModel': '埋め込みモデル',
  'schema.f.rerankerModel': 'リランカーモデル',
  'schema.f.autoDetect': 'サーバーを自動検出',
  'schema.f.batchSize': 'バッチサイズ',

  'schema._root.auto_update.label': '自動アップデート',
  'schema._root.interval.label': 'アップデート確認の間隔（時間）',
  'schema._root.logLevel.label': 'デーモンのログレベル',

  'schema.ai.provider.label': 'プロバイダ',
  'schema.ai.provider.description':
    'onnx = ローカルで設定不要。ollama/lmstudio = ローカルでモデルを選択可能。gemini = Google Generative Language API（一般向け、AIza キー）。vertex = Google Vertex AI（GCP、OAuth ベアラートークン + プロジェクト/リージョン）。voyage = Voyage AI の埋め込みのみ。その他 = クラウド API。',
  'schema.ai.embedding.label': '埋め込みを使う',
  'schema.ai.embedding.description':
    'セマンティック検索とリランクのためにベクトル埋め込みを生成します。オフにすると、推論は残したままセマンティック検索を無効にできます。',
  'schema.ai.inference.label': '推論を使う',
  'schema.ai.inference.description':
    '要約、意図分類、Ask のために LLM を呼び出します。オフにすると、埋め込みは残したまま LLM の呼び出しをすべて省略します。',
  'schema.ai.fast_inference.label': '高速推論を使う',
  'schema.ai.fast_inference.description':
    '低レイテンシの処理に高速モデルを使います。オフにすると高速パスの呼び出し元は空の応答を受け取ります。デバッグ時以外はオンのままにしてください。',

  'schema.ai.ollama.base_url.description':
    'Ollama サーバーのエンドポイント。別のホストやポートで動かす場合に変更します。',
  'schema.ai.lmstudio.base_url.description': 'LM Studio のローカルサーバーのエンドポイント。',
  'schema.ai.openai.base_url.description':
    'OpenAI API のエンドポイント。Azure OpenAI や互換プロバイダを使う場合に変更します。',
  'schema.ai.openai.api_key.description': '必須です。環境変数 OPENAI_API_KEY でも設定できます。',
  'schema.ai.anthropic.api_key.description':
    'console.anthropic.com で取得した Anthropic の API キー。環境変数 ANTHROPIC_API_KEY でも設定できます。',
  'schema.ai.gemini.api_key.description':
    'ai.google.dev で取得した Google Generative Language API のキー（AIza で始まります）。環境変数 GEMINI_API_KEY でも設定できます。GCP/Vertex を使う場合は「vertex」プロバイダを選んでください。',
  'schema.ai.vertex.api_key.label': 'アクセストークン',
  'schema.ai.vertex.api_key.description':
    'OAuth2 のベアラートークン（有効期間は約 1 時間）。gcloud auth print-access-token で生成します。環境変数 GOOGLE_ACCESS_TOKEN でも設定できます。',
  'schema.ai.vertex.project.label': 'GCP プロジェクト',
  'schema.ai.vertex.project.description':
    'Vertex AI をホストする Google Cloud のプロジェクト ID。環境変数 GOOGLE_CLOUD_PROJECT でも設定できます。',
  'schema.ai.vertex.location.label': 'GCP リージョン',
  'schema.ai.vertex.location.description':
    'Vertex AI のリージョン（例: us-central1、europe-west4、asia-northeast1）。環境変数 GOOGLE_CLOUD_LOCATION でも設定できます。',
  'schema.ai.voyage.base_url.description': 'Voyage AI のエンドポイント。通常は既定値のままで構いません。',
  'schema.ai.voyage.api_key.description':
    'dash.voyageai.com で取得した Voyage の API キー。環境変数 VOYAGE_API_KEY でも設定できます。埋め込み専用で、推論はできません。',
  'schema.ai.mistral.base_url.description': 'Mistral API のエンドポイント。',
  'schema.ai.mistral.api_key.description':
    'console.mistral.ai で取得した Mistral の API キー。環境変数 MISTRAL_API_KEY でも設定できます。',
  'schema.ai.groq.base_url.description': 'Groq API のエンドポイント。',
  'schema.ai.groq.api_key.description':
    'console.groq.com で取得した Groq の API キー。環境変数 GROQ_API_KEY でも設定できます。',
  'schema.ai.together.base_url.description': 'Together AI API のエンドポイント。',
  'schema.ai.together.api_key.description':
    'api.together.ai で取得した Together の API キー。環境変数 TOGETHER_API_KEY でも設定できます。',
  'schema.ai.deepseek.base_url.description': 'DeepSeek API のエンドポイント。',
  'schema.ai.deepseek.api_key.description':
    'platform.deepseek.com で取得した DeepSeek の API キー。環境変数 DEEPSEEK_API_KEY でも設定できます。',
  'schema.ai.xai.base_url.description': 'xAI（Grok）API のエンドポイント。',
  'schema.ai.xai.api_key.description':
    'console.x.ai で取得した xAI の API キー。環境変数 XAI_API_KEY でも設定できます。',

  'schema.ai.ollama.inference_model.description': '要約と意図分類に使う LLM。',
  'schema.ai.ollama.fast_model.description':
    '低レイテンシの処理に使う小型で高速な LLM。未設定の場合は推論モデルを使います。',
  'schema.ai.ollama.embedding_model.description':
    'セマンティック検索用の埋め込みモデル。embedding_dimensions と一致している必要があります。',
  'schema.ai.ollama.reranker_model.description': '検索結果の再順位付けに使うクロスエンコーダ。',
  'schema.ai.lmstudio.inference_model.description': 'LM Studio に読み込まれている LLM。',
  'schema.ai.lmstudio.fast_model.description': '低レイテンシの処理に使う高速な LLM。',
  'schema.ai.lmstudio.embedding_model.description': 'LM Studio に読み込まれている埋め込みモデル。',
  'schema.ai.openai.inference_model.description': '要約と意図分類に使う LLM。',
  'schema.ai.openai.fast_model.description':
    'より高速で安価な LLM。未設定の場合は推論モデルを使います。',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small（安価）または text-embedding-3-large（高精度）。',
  'schema.ai.anthropic.inference_model.description': '要約と推論に使う Claude モデル。',
  'schema.ai.anthropic.fast_model.description': '低レイテンシの処理に使う最速の Claude モデル。',
  'schema.ai.gemini.inference_model.description': '要約に使う Gemini モデル。',
  'schema.ai.gemini.fast_model.description': '低レイテンシの処理に使う高速な Gemini モデル。',
  'schema.ai.gemini.embedding_model.description':
    'Gemini の埋め込みモデル。text-embedding-004（768 次元）を推奨します。',
  'schema.ai.vertex.inference_model.description':
    '要約に使う Vertex 上のモデル（例: gemini-2.5-flash、gemini-2.5-pro）。',
  'schema.ai.vertex.fast_model.description': '低レイテンシの処理に使う高速な Vertex モデル。',
  'schema.ai.vertex.embedding_model.description':
    'Vertex の埋め込みモデル（例: text-embedding-005 768 次元、gemini-embedding-001 3072 次元）。',
  'schema.ai.voyage.embedding_model.description':
    'Voyage の埋め込みモデル。voyage-code-3（1024 次元）はソースコード向けに調整されています。',
  'schema.ai.mistral.inference_model.description': '要約に使う Mistral の LLM。',
  'schema.ai.mistral.fast_model.description': '高速な Mistral モデル。',
  'schema.ai.mistral.embedding_model.description': 'Mistral の埋め込みモデル（1024 次元）。',
  'schema.ai.groq.inference_model.description': 'Groq 上の LLM。非常に高速な推論。',
  'schema.ai.groq.fast_model.description': '低レイテンシの処理に使う最速の Groq モデル。',
  'schema.ai.groq.embedding_model.description': 'Groq の埋め込みモデル。',
  'schema.ai.together.inference_model.description': 'Together 上の LLM。',
  'schema.ai.together.fast_model.description': '高速な Together モデル。',
  'schema.ai.together.embedding_model.description': 'Together の埋め込みモデル。',
  'schema.ai.deepseek.inference_model.description': '要約と推論に使う DeepSeek V3。',
  'schema.ai.deepseek.fast_model.description': 'DeepSeek の高速モデル。',
  'schema.ai.xai.inference_model.description': '要約に使う Grok モデル。',
  'schema.ai.xai.fast_model.description': '高速な Grok モデル。',
  'schema.ai.onnx.embedding_model.description':
    'ローカル埋め込み用の ONNX モデル。既定値のままで動作します。',

  'schema.ai.dimensions.label': '埋め込みの次元数',
  'schema.ai.dimensions.description':
    'ベクトルのサイズ。モデルと一致させる必要があります（MiniLM は 384、nomic/Gemini/Vertex text-embedding-005 は 768、Mistral/voyage-code-3 は 1024、OpenAI は 1536、gemini-embedding-001 は 3072）。',
  'schema.ai.summarize.label': 'インデックス時に要約',
  'schema.ai.summarize.description':
    'インデックス中に自然言語の要約を生成します。推論モデルを持つプロバイダが必要です。',
  'schema.ai.summarize_batch.label': '要約のバッチサイズ',
  'schema.ai.summarize_batch.description': '1 バッチで並列に要約するシンボルの数。',
  'schema.ai.summarize_kinds.label': '要約するシンボルの種類',
  'schema.ai.summarize_kinds.description': 'どの種類のシンボルの要約を生成するか。',
  'schema.ai.concurrency.label': '並列数',
  'schema.ai.concurrency.description':
    'AI リクエストの並列数。Ollama では OLLAMA_NUM_PARALLEL に合わせてください。',

  'schema.security.secret_patterns.label': 'シークレットのパターン',
  'schema.security.max_file_size.label': 'ファイルサイズの上限（バイト）',
  'schema.security.max_files.label': 'プロジェクトあたりのファイル数の上限',

  'schema.predictive.cache_ttl.label': 'キャッシュの TTL（分）',
  'schema.predictive.git_since.label': 'git 履歴の期間（日）',
  'schema.predictive.module_depth.label': 'モジュールの深さ',
  'schema.predictive.weights.label': '重み',
  'schema.predictive.weights.description': 'バグ・負債・リスクのスコアの重み',

  'schema.intent.auto_classify.label': 'インデックス時に自動分類',
  'schema.intent.domain_hints.label': 'ドメインのヒント',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': 'カスタムドメイン',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  'schema.runtime.port.label': 'OTLP のポート',
  'schema.runtime.host.label': 'OTLP のホスト',
  'schema.runtime.max_body.label': 'ボディの最大バイト数',
  'schema.runtime.max_span_age.label': 'スパンの保持期間（日）',
  'schema.runtime.max_aggregate_age.label': '集計値の保持期間（日）',
  'schema.runtime.prune_interval.label': '削除の実行間隔',
  'schema.runtime.fqn_attributes.label': 'FQN の属性',
  'schema.runtime.route_patterns.label': 'ルートのパターン',

  'schema.topology.auto_detect.label': 'リポジトリを自動検出',
  'schema.topology.auto_discover.label': 'サブプロジェクトを自動検出',
  'schema.topology.repos.label': '追加のリポジトリパス',
  'schema.topology.contract_globs.label': 'コントラクトの glob',

  'schema.lsp.enabled.description': 'インデックス後に LSP による補完パスを実行します',
  'schema.lsp.auto_detect.description':
    '利用可能な LSP サーバーを自動検出します（tsserver、pyright、gopls、rust-analyzer）',
  'schema.lsp.max_servers.label': '同時に動かすサーバーの上限',
  'schema.lsp.max_servers.description': '並列で動く LSP サーバープロセスの数を制限します',
  'schema.lsp.timeout.label': '補完のタイムアウト（ミリ秒）',
  'schema.lsp.timeout.description': 'LSP による補完パス全体のタイムアウト',
  'schema.lsp.batch_size.description': '1 バッチで処理するシンボルの数',
  'schema.lsp.servers.label': 'サーバーの上書き設定',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  'schema.quality_gates.fail_on.label': '失敗とする条件',
  'schema.quality_gates.rules.label': 'ルール',
  'schema.quality_gates.rules.description': 'ルールのしきい値と重大度',

  'schema.tools.preset.label': 'プリセット',
  'schema.tools.include.label': '公開するツール',
  'schema.tools.exclude.label': '除外するツール',
  'schema.tools.description_verbosity.label': '説明の詳しさ',
  'schema.tools.instructions_verbosity.label': '指示の詳しさ',
  'schema.tools.meta_fields.label': 'メタフィールド',
  'schema.tools.compact_schemas.label': 'スキーマを簡略化',
  'schema.tools.compact_schemas.description':
    'ツールのスキーマから高度なパラメータを取り除き、トークンの消費を約 42% 削減します',
  'schema.tools.descriptions.label': 'カスタムの説明',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  'schema.ignore.directories.label': 'ディレクトリ',
  'schema.ignore.patterns.label': 'パターン',

  'schema.frameworks.config.label': '設定',
  'schema.frameworks.config.description': 'フレームワークの上書き設定',

  'schema.logging.file.label': 'ファイルへのログ出力を有効にする',
  'schema.logging.path.label': 'ログファイルのパス',
  'schema.logging.level.label': 'ログレベル',
  'schema.logging.max_size.label': 'ログサイズの上限（MB）',

  'schema.watch.debounce.label': 'デバウンス（ミリ秒）',
} as const;
