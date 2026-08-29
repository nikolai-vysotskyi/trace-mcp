export const insights = {
  title: 'インサイト',
  reportPicker: 'レポート',
  run: '実行',
  refresh: '更新',
  running: '実行中…',
  runAction: '{{report}}を{{action}}',
  unknownError: '不明なエラー',
  errorInit: 'デーモンとのセッションを開始できませんでした（HTTP {{status}}）。',
  errorNoSession: 'デーモンはセッションを開始しましたが、名前を返しませんでした。',
  errorHttp: 'レポートのリクエストが失敗しました（HTTP {{status}}）。{{detail}}',
  errorToolFailed: 'レポートは実行されませんでした。',

  reportDriftTitle: 'CLAUDE.md のずれ',
  reportDriftDescription: 'エージェント設定ファイル内の古いパスと存在しないシンボル参照。',
  reportPagerankTitle: '中心的なファイル',
  reportPagerankDescription: 'インポートグラフの PageRank で見た、構造上もっとも中心的なファイル。',
  reportRiskTitle: 'リスクの高い箇所',
  reportRiskDescription: '複雑度が高く、git の変更頻度も高いファイル。',

  runningDrift: 'エージェント設定をインデックスと照合しています…',
  runningPagerank: 'インポートの中心性でファイルを順位付けしています…',
  runningRisk: '複雑度と git の変更頻度を突き合わせています…',

  emptyTitle: '報告する項目はありません',
  emptyBody: 'このレポートは空でした — 現時点で該当するものはプロジェクトにありません。',

  noDescription: '（説明なし）',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: '対処: {{fix}}',
  rowScore: 'スコア {{score}}',
  rowHotspot: '複雑度 {{complexity}} · コミット {{commits}} 件',
  rowHotspotConfidence: '複雑度 {{complexity}} · コミット {{commits}} 件 · {{confidence}}',
} as const;
