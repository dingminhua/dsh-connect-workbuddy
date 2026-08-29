/**
 * Plugin-card copy registered under the settings.workbuddy locale namespace.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — `row.*` 的文案键约定与中英 1:1 键对齐（`zh: Record<Key, string>`
 *     强制双语同步）来自该项目，其又继承自
 *     dingminhua/dsh-subagent-default-model（MIT）。
 * 改动：文案按 WorkBuddy 的实际情况改写（积分套餐、模型倍率、多账号）。
 *
 * @module dsh-connect-workbuddy/client/locales
 */

export const en = {
  'row.title': 'WorkBuddy credits & models (dsh-connect-workbuddy)',
  'row.desc': 'Use the models in the WorkBuddy desktop app directly in DSH, and see your remaining credits at a glance.',
  'row.expand': 'Expand',
  'row.collapse': 'Collapse',
  'row.signedOut': 'Not signed in',
  'row.signedOutHint': 'Sign in once in the WorkBuddy desktop app; this plugin follows that sign-in automatically.',
  'row.signedIn': 'Signed in: {accountName}',
  'row.tokenExpiry': 'Access token expires {expiresAt} (auto-renewal)',
  'row.requestFailed': 'Request failed',
  'row.creditsTotalLabel': 'Total remaining',
  'row.creditsError': 'Credit query unavailable: {message}',
  'row.creditsEmpty': 'No remaining credit in this account.',
  'row.packageCount': '× {count} packages',
  'row.refresh': 'Refresh',
  'row.refreshing': 'Refreshing…',
  'row.accountsTitle': 'WorkBuddy account',
  'row.accountsHint': 'Choose from locally detected sign-ins. Tokens are never shown or saved in DSH settings.',
  'row.accountsRescan': 'Detect accounts again',
  'row.accountsScanning': 'Detecting…',
  'row.modelsTitle': 'Models',
  'row.modelsSummary': '{count} enabled',
  'row.modelsRefresh': 'Refresh from WorkBuddy',
  'row.modelsRefreshing': 'Refreshing models…',
  'row.discard': 'Discard changes',
  'row.save': 'Save',
  'row.saving': 'Saving…',
  'row.modelContext': 'Maximum context {context}',
  'row.contextBudget': 'DSH context budget',
  'row.modelOutput': 'Output {output}',
  'row.modelRate': '{rate}x credits',
  'row.modelMultimodal': 'Multimodal',
  'row.modelReasoning': 'Reasoning: {efforts}',
  'row.modelUnknown': 'Unknown',
  'row.modelCapabilityPending': 'Only capabilities advertised by WorkBuddy are shown.',
  'row.cheer': 'Star on GitHub',
} as const

export type WorkBuddySettingsKey = keyof typeof en

export const zh: Record<WorkBuddySettingsKey, string> = {
  'row.title': '接入使用 WorkBuddy 积分与模型（dsh-connect-workbuddy）',
  'row.desc': '在 DSH 中直接使用 WorkBuddy 桌面 App 包含的模型，并随时查看剩余积分。',
  'row.expand': '展开',
  'row.collapse': '收起',
  'row.signedOut': '未登录',
  'row.signedOutHint': '在 WorkBuddy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。',
  'row.signedIn': '已登录：{accountName}',
  'row.tokenExpiry': '访问令牌 {expiresAt} 过期（自动续期）',
  'row.requestFailed': '请求失败',
  'row.creditsTotalLabel': '剩余合计',
  'row.creditsError': '积分查询失败：{message}',
  'row.creditsEmpty': '该账号当前没有剩余积分。',
  'row.packageCount': '共 {count} 个套餐',
  'row.refresh': '刷新',
  'row.refreshing': '正在刷新…',
  'row.accountsTitle': 'WorkBuddy 账号',
  'row.accountsHint': '选择本机检测到的登录账号；Token 不会显示，也不会保存到 DSH 设置。',
  'row.accountsRescan': '重新检测账号',
  'row.accountsScanning': '正在检测…',
  'row.modelsTitle': '模型',
  'row.modelsSummary': '已启用 {count} 个',
  'row.modelsRefresh': '从 WorkBuddy 刷新',
  'row.modelsRefreshing': '正在刷新模型…',
  'row.discard': '放弃修改',
  'row.save': '保存',
  'row.saving': '保存中…',
  'row.modelContext': '最大上下文 {context}',
  'row.contextBudget': 'DSH 上下文预算',
  'row.modelOutput': '最大输出 {output}',
  'row.modelRate': '积分 {rate}x',
  'row.modelMultimodal': '多模态',
  'row.modelReasoning': '推理强度：{efforts}',
  'row.modelUnknown': '未知',
  'row.modelCapabilityPending': '仅展示 WorkBuddy 接口明确公布的模型能力。',
  'row.cheer': '鼓励一下',
}
