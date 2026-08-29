export const insights = {
  title: '洞察',
  reportPicker: '报告',
  run: '运行',
  refresh: '刷新',
  running: '运行中…',
  runAction: '{{action}}：{{report}}',
  unknownError: '未知错误',
  errorInit: '无法与守护进程建立会话（HTTP {{status}}）。',
  errorNoSession: '守护进程创建了会话，但没有返回会话名。',
  errorHttp: '报告请求失败（HTTP {{status}}）。{{detail}}',
  errorToolFailed: '报告没有运行。',

  reportDriftTitle: 'CLAUDE.md 偏移',
  reportDriftDescription: '智能体配置文件中失效的路径和不存在的符号引用。',
  reportPagerankTitle: '最核心的文件',
  reportPagerankDescription: '按导入图 PageRank 排出的架构最核心文件。',
  reportRiskTitle: '风险热点',
  reportRiskDescription: '同时具备高复杂度和高 git 变更频率的文件。',

  runningDrift: '正在用索引核对智能体配置…',
  runningPagerank: '正在按导入中心度给文件排序…',
  runningRisk: '正在关联复杂度与 git 变更频率…',

  emptyTitle: '没有可报告的内容',
  emptyBody: '这份报告是空的——项目中目前没有符合的内容。',

  noDescription: '（无描述）',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: '修复：{{fix}}',
  rowScore: '得分 {{score}}',
  rowHotspot: '复杂度 {{complexity}} · {{commits}} 次提交',
  rowHotspotConfidence: '复杂度 {{complexity}} · {{commits}} 次提交 · {{confidence}}',
} as const;
