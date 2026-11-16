/**
 * probe-core.ts — 纯函数核心：stableConversationId 探针的参数校验、SSE/usage 解析、
 * 记录校验、wiring 判定、统计与结论。
 *
 * 隐私与副作用硬约束（B1 / B5 / 场景⑫）：
 *   - 本模块 **不 import 任何东西**：不读凭证、不读文件、不发网络、不读环境变量、
 *     不碰 process.argv、不覆写 globalThis.fetch、不启动 main。
 *   - 仅 import 本模块不得产生任何可观察副作用。所有网络、凭证、时钟、随机源都
 *     由调用方（CLI / 测试）显式注入。
 *   - 本模块接收的「ID」一律是运行内合成别名或调用方内存里的不透明值；输出里
 *     绝不出现原始 ID、token、正文、响应尾部、原始异常。缺字段用 null，不用 0 补。
 *   - 合成 seed 只由调用方给定的整数产生，不由任何真实账号或正文派生。
 *
 * 本文件只使用「可擦除」的 TypeScript 语法（interface / type / as / 泛型 / 类型标注），
 * Node 24 的类型擦除可直接从 .mjs / .spec.ts import，无需编译步骤。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = '1.0.0'
export const TEMPLATE_VERSION = 'probe-template-1'

export const DEFAULT_MIN_MEAN_D = 0.20
export const DEFAULT_BOOTSTRAP_ITERATIONS = 10000
export const DEFAULT_CI_LEVEL = 0.95

/** 退出码：区分执行失败 / 数据无效 / 完整实验 / 未授权 NOT_RUN。 */
export const EXIT = {
  COMPLETE: 0,
  EXECUTION_FAILURE: 1,
  INVALID_DATA: 2,
  NOT_RUN: 3,
} as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** 固定错误类别。任何错误都只映射到这里的一个值，绝不带原始 message。 */
export const FAILURE_CODES = {
  NONE: 'NONE',
  PARAM_INVALID: 'PARAM_INVALID',
  CREDENTIAL_PARSE: 'CREDENTIAL_PARSE',
  ACCOUNT_NOT_SPECIFIED: 'ACCOUNT_NOT_SPECIFIED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  STREAM_READ_ERROR: 'STREAM_READ_ERROR',
  STREAM_TRUNCATED: 'STREAM_TRUNCATED',
  SSE_ERROR: 'SSE_ERROR',
  NO_TERMINAL_USAGE: 'NO_TERMINAL_USAGE',
  USAGE_INVALID: 'USAGE_INVALID',
  UNKNOWN: 'UNKNOWN',
  INTERNAL: 'INTERNAL',
} as const
export type FailureCode = (typeof FAILURE_CODES)[keyof typeof FAILURE_CODES]

const FAILURE_CODE_SET: ReadonlySet<string> = new Set(Object.values(FAILURE_CODES))

/** §9 禁止的过强表述。结论文本里出现任意一条即视为违规。 */
export const FORBIDDEN_CLAIMS: readonly string[] = [
  '按会话分区已被证明',
  '从首个 warm 起确定性命中',
  '与原生 sessionId 等价',
  '独立会话不会共享',
  '与所有已发布版本逐字节一致',
  '三组控制排除所有混淆',
  'VALID 即实验证实',
  'RESULT: VALID',
  '证明按 ID 分区',
  '缓存键分区已被证明',
]

// 注意：免责声明本身不能包含 FORBIDDEN_CLAIMS 里的任何字面串，否则
// containsForbiddenClaim 会把「声明不能证明」误判成「作出了过强表述」，
// 使 forbiddenClaimsFound 恒非空、守卫彻底失效。故这里换一种措辞表达同一含义。
export const MECHANISM_DISCLAIMER =
  '该实验不能区分缓存键分区与路由亲和等内部机制，也不能外推所有账号/模型；不得据此声称已厘清缓存键的分区方式。'

export const BUDGET = {
  minGroups: 1,
  maxGroups: 50,
  minWarmTurns: 1,
  maxWarmTurns: 20,
  minRepeats: 1,
  maxRepeats: 2000,
  minMaxTokens: 1,
  maxMaxTokens: 4096,
  maxRequests: 400,
  minSeed: 0,
  maxSeed: 2147483647,
} as const

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type Arm = 'OFF' | 'ON'
export type Stage = 'cold' | 'warm'
export type ExperimentKind = 'OFFLINE_SYNTHETIC' | 'REAL'
export type RequestStatus =
  | 'OK' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED'
  | 'STREAM_READ_ERROR' | 'UNKNOWN'
export type StreamStatus =
  | 'COMPLETE' | 'SSE_ERROR' | 'TRUNCATED' | 'NO_TERMINAL_USAGE' | 'NO_DONE'
  | 'EMPTY' | 'ERROR'
export type UsageStatus = 'OK' | 'CONFLICT' | 'INVALID' | 'MISSING'
export type UsageSource = 'HIT_MISS' | 'CACHED_PROMPT' | 'NONE'
export type WiringStatus = 'PASS' | 'FAIL'
export type DataStatus = 'COMPLETE' | 'INCOMPLETE' | 'INVALID'
export type EffectStatus =
  | 'NOT_EVALUATED' | 'BENEFIT_SUPPORTED' | 'NO_CLEAR_BENEFIT' | 'MIXED'

export interface ProbeParams {
  groups: number
  warmTurns: number
  repeats: number
  maxTokens: number
  accountAlias: string
  model: string
  endpointAlias: string
  seed: number
  templateVersion: string
  usageIdentity: boolean
  wireProfile: string
  experimentKind: ExperimentKind
}

export interface ValidationError {
  field: string
  code: string
  message: string
}

export type ValidationResult =
  | { ok: true; value: ProbeParams }
  | { ok: false; errors: ValidationError[] }

export type UsageObject = Record<string, unknown>

export interface SseFrame {
  index: number
  eventType: string | null
  dataLines: string[]
  commentLines: string[]
  data: string
  isDone: boolean
  isKeepalive: boolean
  parsed: unknown | null
  parseOk: boolean
}

export interface StreamAnalysis {
  frames: SseFrame[]
  streamStatus: StreamStatus
  terminal: UsageObject | null
  hasDone: boolean
  truncated: boolean
  sseErrorCodes: string[]
  candidateCount: number
}

export interface NormalizedUsage {
  usageSource: UsageSource
  hit: number | null
  miss: number | null
  prompt: number | null
  completion: number | null
  cached: number | null
  hitTokens: number | null
  missTokens: number | null
  denominator: number | null
  rate: number | null
  conflicts: string[]
  invalidCodes: string[]
  valid: boolean
}

export interface WiringSnapshot {
  group: number
  arm: Arm
  order: number
  conversationId: string | null
  requestId: string | null
  messageId: string | null
  rootId: string | null
  xRequestId: string | null
}

export interface WiringAliases {
  aliasConversationId: string
  aliasRequestId: string
  aliasMessageId: string
  aliasRootId: string
  aliasXRequestId: string
}

export interface WiringResult {
  status: WiringStatus
  codes: string[]
  checks: {
    expectedCount: number
    actualCount: number
    allIdsValid: boolean
    offConversationFresh: boolean
    onConversationStable: boolean
    messageIdsFresh: boolean
    requestIdsFresh: boolean
    rootMirrorsRequest: boolean
    xRequestMirrorsMessage: boolean
    distinctOffConversations: number
    distinctOnConversations: number
  }
}

export interface PlanEntry {
  group: number
  arm: Arm
  stage: Stage
  turn: number
  order: number
  prefixAlias: string
}

export interface ExperimentPlan {
  schemaVersion: string
  templateVersion: string
  seed: number
  totalRequests: number
  groups: number
  warmTurns: number
  entries: PlanEntry[]
  prefixAssignment: Array<{ group: number; offPrefix: string; onPrefix: string }>
}

export interface ProbeRecord {
  kind: 'record'
  schemaVersion: string
  runId: string
  templateVersion: string
  seed: number
  group: number
  arm: Arm
  stage: Stage
  turn: number
  order: number
  prefixAlias: string
  sentAt: number
  completedAt: number
  durationMs: number
  accountAlias: string
  model: string
  endpointAlias: string
  wireProfile: string
  usageIdentity: boolean
  experimentKind: ExperimentKind
  httpStatus: number | null
  requestStatus: RequestStatus
  streamStatus: StreamStatus
  usageStatus: UsageStatus
  failureCode: string
  hit: number | null
  miss: number | null
  prompt: number | null
  completion: number | null
  cached: number | null
  usageSource: UsageSource
  denominator: number | null
  rate: number | null
  conflicts: string[]
  invalidCodes: string[]
  wiring: {
    aliasConversationId: string
    aliasRequestId: string
    aliasMessageId: string
    aliasRootId: string
    aliasXRequestId: string
    snapshotValid: boolean
  }
  complete: boolean
}

export interface MetaRecord {
  kind: 'meta'
  schemaVersion: string
  runId: string
  scriptHash: string
  buildHash: string
  templateVersion: string
  seed: number
  params: ProbeParams
  plan: ExperimentPlan
  wiring: WiringResult
}

export interface RecordValidation {
  valid: boolean
  complete: boolean
  codes: string[]
}

export interface GroupStat {
  group: number
  rOff: number | null
  rOn: number | null
  d: number | null
  complete: boolean
  reason: string | null
}

export interface Stats {
  groupStats: GroupStat[]
  completeGroups: number
  plannedGroups: number
  meanD: number | null
  ciLow: number | null
  ciHigh: number | null
  bootstrapIterations: number | null
  bootstrapSeed: number | null
  firstWarmDiff: number | null
  weightedOnHitRate: number | null
  weightedOffHitRate: number | null
}

export interface Report {
  kind: 'report'
  schemaVersion: string
  runId: string
  templateVersion: string
  experimentKind: ExperimentKind
  realExperiment: 'RUN' | 'NOT_RUN'
  wiringStatus: WiringStatus
  dataStatus: DataStatus
  effectStatus: EffectStatus
  exitCode: ExitCode
  reasons: string[]
  incompleteRecords: number
  conflictRecords: number
  invalidRecords: number
  totalRecords: number
  stats: Stats
  conclusionText: string
  mechanismProven: false
  forbiddenClaimsFound: string[]
}

// ---------------------------------------------------------------------------
// 参数校验（B2）
// ---------------------------------------------------------------------------

/**
 * 严格整数解析：拒绝 NaN / 小数 / 空串 / "5abc" / "5.0" / 科学计数法。
 * 数字入参也必须本身是整数（load-bearing：1.5 是「有限」但不是整数，若直接返回
 * 会漏过 requireInt 的 NOT_INTEGER 检查；校验函数依赖 parseStrictInt 返回 NaN 表示拒绝）。
 */
export function parseStrictInt(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && Number.isInteger(value) ? value : Number.NaN
  if (typeof value !== 'string') return Number.NaN
  const s = value.trim()
  if (!/^[+-]?\d+$/.test(s)) return Number.NaN
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : Number.NaN
}

function requireInt(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  errors: ValidationError[],
): number {
  const v = raw[key]
  if (v === undefined || v === null) {
    errors.push({ field: key, code: 'MISSING', message: `${key} 缺失（拒绝不完整参数）` })
    return Number.NaN
  }
  const n = parseStrictInt(v)
  if (!Number.isFinite(n)) {
    errors.push({ field: key, code: 'NOT_FINITE', message: `${key} 必须是有限整数（拒绝 NaN/Infinity/非数字）` })
    return Number.NaN
  }
  if (!Number.isInteger(n)) {
    errors.push({ field: key, code: 'NOT_INTEGER', message: `${key} 必须是整数（拒绝小数）` })
    return Number.NaN
  }
  if (n < min || n > max) {
    errors.push({ field: key, code: 'OUT_OF_RANGE', message: `${key} 必须在 [${min}, ${max}]（拒绝负数/零/超预算）` })
    return Number.NaN
  }
  return n
}

function requireSafeString(
  raw: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
): string {
  const v = raw[key]
  if (typeof v !== 'string' || v.trim().length === 0) {
    errors.push({ field: key, code: 'MISSING', message: `${key} 必须是非空字符串` })
    return ''
  }
  return v.trim()
}

/**
 * 账号选择必须显式指定：拒绝空值、路径、@、空白、9 位以上连续数字（疑似真实 uin）、
 * 过长值。不允许「默默挑目录第一个文件」。
 */
function validateAccountAlias(value: unknown, errors: ValidationError[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ field: 'accountAlias', code: 'ACCOUNT_NOT_SPECIFIED', message: '账号必须显式指定（禁止默默取目录第一个文件）' })
    return ''
  }
  const s = value.trim()
  if (s.length > 64 || /[\\/@\s]/.test(s) || /\d{9,}/.test(s)) {
    errors.push({ field: 'accountAlias', code: 'ACCOUNT_ALIAS_INVALID', message: '账号别名含路径/@/空白/长数字，疑似真实值' })
    return ''
  }
  return s
}

export function totalRequests(params: ProbeParams): number {
  return params.groups * 2 * (1 + params.warmTurns)
}

export function validateParams(input: unknown): ValidationResult {
  const errors: ValidationError[] = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'params', code: 'NOT_OBJECT', message: '参数必须是对象' }] }
  }
  const raw = input as Record<string, unknown>

  const groups = requireInt(raw, 'groups', BUDGET.minGroups, BUDGET.maxGroups, errors)
  const warmTurns = requireInt(raw, 'warmTurns', BUDGET.minWarmTurns, BUDGET.maxWarmTurns, errors)
  const repeats = requireInt(raw, 'repeats', BUDGET.minRepeats, BUDGET.maxRepeats, errors)
  const maxTokens = requireInt(raw, 'maxTokens', BUDGET.minMaxTokens, BUDGET.maxMaxTokens, errors)
  const seed = requireInt(raw, 'seed', BUDGET.minSeed, BUDGET.maxSeed, errors)

  const accountAlias = validateAccountAlias(raw['accountAlias'], errors)
  const model = requireSafeString(raw, 'model', errors)
  const endpointAlias = requireSafeString(raw, 'endpointAlias', errors)
  const templateVersion = requireSafeString(raw, 'templateVersion', errors)
  const wireProfile = requireSafeString(raw, 'wireProfile', errors)

  const usageIdentity = raw['usageIdentity']
  if (typeof usageIdentity !== 'boolean') {
    errors.push({ field: 'usageIdentity', code: 'NOT_BOOLEAN', message: 'usageIdentity 必须是 boolean' })
  }
  const experimentKind = raw['experimentKind']
  if (experimentKind !== 'OFFLINE_SYNTHETIC' && experimentKind !== 'REAL') {
    errors.push({ field: 'experimentKind', code: 'INVALID', message: 'experimentKind 必须是 OFFLINE_SYNTHETIC 或 REAL' })
  }

  if (Number.isFinite(groups) && Number.isFinite(warmTurns)) {
    const n = groups * 2 * (1 + warmTurns)
    if (n > BUDGET.maxRequests) {
      errors.push({ field: 'budget', code: 'OVER_BUDGET', message: `总请求数 ${n} 超过预算 ${BUDGET.maxRequests}` })
    }
    // 至少 1 次预热（cold）+ 1 次 warm：warmTurns>=1 已由 requireInt 保证，cold 恒为 1。
    if (warmTurns < 1) {
      errors.push({ field: 'warmTurns', code: 'NO_WARM_TURN', message: '至少需要 1 次 warm 请求' })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const params: ProbeParams = {
    groups,
    warmTurns,
    repeats,
    maxTokens,
    accountAlias,
    model,
    endpointAlias,
    seed,
    templateVersion,
    usageIdentity: usageIdentity as boolean,
    wireProfile,
    experimentKind: experimentKind as ExperimentKind,
  }
  return { ok: true, value: params }
}

// ---------------------------------------------------------------------------
// 随机源与实验计划（B2 / 场景⑪）
// ---------------------------------------------------------------------------

/** 确定性 PRNG（mulberry32）。同一 seed 必得同一序列。 */
export function mulberry32(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 合成 runId：只由 seed + 模板版本派生，绝不由真实账号/正文派生。 */
export function syntheticRunId(params: ProbeParams): string {
  return `run-${params.seed.toString(16)}-${params.templateVersion}`
}

/** 由 seed 生成完整实验计划：前缀分配 + 每组每轮发送顺序，可重建。 */
export function buildPlan(params: ProbeParams): ExperimentPlan {
  const rng = mulberry32(params.seed)
  const entries: PlanEntry[] = []
  const prefixAssignment: Array<{ group: number; offPrefix: string; onPrefix: string }> = []
  let order = 0
  for (let g = 0; g < params.groups; g += 1) {
    const flip = rng() < 0.5
    const offPrefix = flip ? `g${g}-pA` : `g${g}-pB`
    const onPrefix = flip ? `g${g}-pB` : `g${g}-pA`
    prefixAssignment.push({ group: g, offPrefix, onPrefix })
    const other = (arm: Arm): Arm => (arm === 'OFF' ? 'ON' : 'OFF')
    // 冷启动（预热）：两臂各 1 次，顺序随机。
    const coldFirst: Arm = rng() < 0.5 ? 'OFF' : 'ON'
    for (const arm of [coldFirst, other(coldFirst)] as Arm[]) {
      entries.push({ group: g, arm, stage: 'cold', turn: 0, order: order++, prefixAlias: arm === 'OFF' ? offPrefix : onPrefix })
    }
    // warm 轮：每轮两臂各 1 次，顺序逐轮随机。
    for (let t = 1; t <= params.warmTurns; t += 1) {
      const first: Arm = rng() < 0.5 ? 'OFF' : 'ON'
      for (const arm of [first, other(first)] as Arm[]) {
        entries.push({ group: g, arm, stage: 'warm', turn: t, order: order++, prefixAlias: arm === 'OFF' ? offPrefix : onPrefix })
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    templateVersion: params.templateVersion,
    seed: params.seed,
    totalRequests: entries.length,
    groups: params.groups,
    warmTurns: params.warmTurns,
    entries,
    prefixAssignment,
  }
}

// ---------------------------------------------------------------------------
// SSE 解析（B3）
// ---------------------------------------------------------------------------

/** LF / CRLF / CR、多个 data 行、keepalive(:) 注释、[DONE]、无关帧。 */
export function decodeSseFrames(text: string): SseFrame[] {
  const lines = text.split(/\r\n|\n|\r/)
  const frames: SseFrame[] = []
  let cur: { eventType: string | null; dataLines: string[]; commentLines: string[] } | null = null

  const push = (): void => {
    if (cur === null) return
    const data = cur.dataLines.join('\n')
    const trimmed = data.trim()
    const isDone = trimmed === '[DONE]'
    const isKeepalive = cur.dataLines.length === 0 && cur.commentLines.length > 0
    let parsed: unknown | null = null
    let parseOk = true
    if (cur.dataLines.length > 0 && !isDone && trimmed !== '') {
      try {
        parsed = JSON.parse(data) as unknown
      } catch {
        parseOk = false
      }
    }
    frames.push({
      index: frames.length,
      eventType: cur.eventType,
      dataLines: cur.dataLines,
      commentLines: cur.commentLines,
      data,
      isDone,
      isKeepalive,
      parsed,
      parseOk,
    })
    cur = null
  }

  for (const line of lines) {
    if (line.trim() === '') {
      push()
      continue
    }
    if (cur === null) cur = { eventType: null, dataLines: [], commentLines: [] }
    if (line.startsWith(':')) {
      cur.commentLines.push(line.slice(1))
      continue
    }
    if (line.startsWith('data:')) {
      cur.dataLines.push(line.slice(5).replace(/^ /, ''))
      continue
    }
    if (line.startsWith('event:')) {
      cur.eventType = line.slice(6).trim()
      continue
    }
    // id: / retry: / 无关字段行：保留帧但不作为 data。
  }
  push()
  return frames
}

function numericField(obj: UsageObject, key: string): number | null {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function isUsageCandidate(obj: UsageObject): boolean {
  for (const [k, v] of Object.entries(obj)) {
    if (/token|cache/i.test(k) && typeof v === 'number') return true
  }
  const details = obj['prompt_tokens_details']
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
    for (const [k, v] of Object.entries(details as UsageObject)) {
      if (/token|cache/i.test(k) && typeof v === 'number') return true
    }
  }
  return false
}

/** 结构有效的「完整 usage」：须有有限非负 completion_tokens + 至少一个 prompt 侧计数。 */
function isCompleteUsage(obj: UsageObject): boolean {
  const completion = numericField(obj, 'completion_tokens')
  if (completion === null || completion < 0) return false
  const promptSide = ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cached_tokens', 'prompt_tokens']
    .some((k) => numericField(obj, k) !== null)
  const details = obj['prompt_tokens_details']
  const detailsSide = typeof details === 'object' && details !== null && !Array.isArray(details)
    && numericField(details as UsageObject, 'cached_tokens') !== null
  if (!promptSide && !detailsSide) return false
  for (const [k, v] of Object.entries(obj)) {
    if (/token|cache/i.test(k) && typeof v === 'number') {
      if (!Number.isFinite(v) || v < 0) return false
    }
  }
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
    for (const [k, v] of Object.entries(details as UsageObject)) {
      if (/token|cache/i.test(k) && typeof v === 'number') {
        if (!Number.isFinite(v) || v < 0) return false
      }
    }
  }
  return true
}

/**
 * 取【最后一个结构有效的完整 usage】——绝不把「首个 completion_tokens 对象」当终态。
 * 多帧累计计数不求和：只返回终态那一个对象。
 */
export function analyzeStream(text: string): StreamAnalysis {
  const frames = decodeSseFrames(text)
  const result: StreamAnalysis = {
    frames,
    streamStatus: 'EMPTY',
    terminal: null,
    hasDone: false,
    truncated: false,
    sseErrorCodes: [],
    candidateCount: 0,
  }
  if (frames.length === 0) return result

  result.hasDone = frames.some((f) => f.isDone)
  for (const f of frames) {
    if (f.eventType === 'error') result.sseErrorCodes.push('EVENT_ERROR')
    if (f.parsed !== null && typeof f.parsed === 'object' && !Array.isArray(f.parsed)) {
      const p = f.parsed as UsageObject
      if (p['error'] !== undefined && p['error'] !== null) result.sseErrorCodes.push('PAYLOAD_ERROR')
    }
  }

  const last = frames[frames.length - 1]!
  const looksJson = (s: string): boolean => {
    const t = s.trimStart()
    return t.startsWith('{') || t.startsWith('[')
  }
  if (!last.parseOk && last.dataLines.length > 0 && looksJson(last.data)) result.truncated = true
  if (!result.hasDone && last.dataLines.length > 0 && !/\r?\n\s*\r?\n\s*$/.test(text)) {
    result.truncated = true
  }

  const candidates: UsageObject[] = []
  for (const f of frames) {
    if (f.parsed === null || typeof f.parsed !== 'object' || Array.isArray(f.parsed)) continue
    const p = f.parsed as UsageObject
    if (isUsageCandidate(p)) candidates.push(p)
    const usageField = p['usage']
    if (typeof usageField === 'object' && usageField !== null && !Array.isArray(usageField)
      && isUsageCandidate(usageField as UsageObject)) {
      candidates.push(usageField as UsageObject)
    }
  }
  result.candidateCount = candidates.length
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const c = candidates[i]!
    if (isCompleteUsage(c)) {
      result.terminal = c
      break
    }
  }

  if (result.sseErrorCodes.length > 0) result.streamStatus = 'SSE_ERROR'
  else if (result.truncated) result.streamStatus = 'TRUNCATED'
  else if (result.terminal === null) result.streamStatus = 'NO_TERMINAL_USAGE'
  else if (!result.hasDone) result.streamStatus = 'NO_DONE'
  else result.streamStatus = 'COMPLETE'
  return result
}

/** 构造合成 SSE（供离线自测与测试用；不含任何真实正文）。 */
export interface MakeUsageSseOptions {
  includeDone?: boolean
  crlf?: boolean
  keepalive?: boolean
  extraUsageFrames?: UsageObject[]
  payloadError?: boolean
  omitTerminal?: boolean
  truncateAtDataLine?: boolean
}

export function makeUsageSse(usage: UsageObject | null, options: MakeUsageSseOptions = {}): string {
  const {
    includeDone = true,
    crlf = false,
    keepalive = false,
    extraUsageFrames = [],
    payloadError = false,
    omitTerminal = false,
    truncateAtDataLine = false,
  } = options
  const eol = crlf ? '\r\n' : '\n'
  // 截断场景：故意让最后一个 data 行是半个 JSON，且不再补 [DONE]。
  // 这样 decodeSseFrames 得到一个 parseOk=false 的终帧，analyzeStream 判 TRUNCATED。
  const effectiveDone = truncateAtDataLine ? false : includeDone
  const parts: string[] = []
  if (keepalive) parts.push(`: keepalive${eol}${eol}`)
  parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}${eol}${eol}`)
  for (const extra of extraUsageFrames) {
    parts.push(`data: ${JSON.stringify({ usage: extra })}${eol}${eol}`)
  }
  if (payloadError) parts.push(`data: ${JSON.stringify({ error: { code: 'upstream', message: 'err' } })}${eol}${eol}`)
  if (!omitTerminal && usage !== null) {
    const raw = `data: ${JSON.stringify({ usage })}`
    if (truncateAtDataLine) {
      parts.push(raw.slice(0, Math.max(1, Math.floor(raw.length / 2))))
    } else {
      parts.push(`${raw}${eol}${eol}`)
    }
  }
  if (effectiveDone) parts.push(`data: [DONE]${eol}${eol}`)
  return parts.join('')
}

// ---------------------------------------------------------------------------
// usage 归一化（B3）
// ---------------------------------------------------------------------------

export function emptyNormalizedUsage(): NormalizedUsage {
  return {
    usageSource: 'NONE',
    hit: null, miss: null, prompt: null, completion: null, cached: null,
    hitTokens: null, missTokens: null, denominator: null, rate: null,
    conflicts: [], invalidCodes: [], valid: false,
  }
}

/**
 * 优先 hit/(hit+miss)（分母>0）；fallback cached/prompt 必须验证 cached<=prompt。
 * 计数须 finite 且非负；冲突计数明确报告，冲突/无效时 rate=null，不静默选有利口径。
 * 缺字段保持 null，绝不补 0。
 */
export function normalizeUsage(obj: UsageObject | null): NormalizedUsage {
  const r = emptyNormalizedUsage()
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    r.invalidCodes.push('NO_USAGE_OBJECT')
    return r
  }

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

  const scan = (o: UsageObject, prefix: string): void => {
    for (const [k, v] of Object.entries(o)) {
      if (!/token|cache/i.test(k)) continue
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) r.invalidCodes.push(`${prefix}NON_FINITE:${k}`)
        else if (v < 0) r.invalidCodes.push(`${prefix}NEGATIVE:${k}`)
      }
    }
  }
  scan(obj, '')
  const details = obj['prompt_tokens_details']
  const detailsObj = typeof details === 'object' && details !== null && !Array.isArray(details)
    ? (details as UsageObject) : null
  if (detailsObj !== null) scan(detailsObj, 'DETAILS_')

  const hit = num(obj['prompt_cache_hit_tokens'])
  const miss = num(obj['prompt_cache_miss_tokens'])
  const cachedTop = num(obj['cached_tokens'])
  const cachedDetails = detailsObj !== null ? num(detailsObj['cached_tokens']) : null
  const prompt = num(obj['prompt_tokens'])
  const completion = num(obj['completion_tokens'])
  const cached = cachedTop ?? cachedDetails

  r.prompt = prompt
  r.completion = completion
  r.cached = cached

  // 冲突：同一命中量出现多个不同取值。
  const hitSources: number[] = []
  if (hit !== null) hitSources.push(hit)
  if (cachedDetails !== null) hitSources.push(cachedDetails)
  if (cachedTop !== null) hitSources.push(cachedTop)
  if (hitSources.length > 1 && new Set(hitSources).size > 1) r.conflicts.push('HIT_SOURCE_CONFLICT')

  const hmDenom = hit !== null && miss !== null ? hit + miss : null
  const hmRate = hmDenom !== null && hmDenom > 0 ? (hit as number) / hmDenom : null
  if (hmDenom !== null && hmDenom <= 0) r.invalidCodes.push('ZERO_DENOMINATOR_HIT_MISS')

  let cpRate: number | null = null
  if (cached !== null && prompt !== null) {
    if (prompt <= 0) r.invalidCodes.push('ZERO_DENOMINATOR_CACHED_PROMPT')
    else if (cached > prompt) r.invalidCodes.push('CACHED_GT_PROMPT')
    else cpRate = cached / prompt
  }

  if (hit !== null && miss !== null && prompt !== null
    && Math.abs(prompt - (hit + miss)) > 1) {
    r.conflicts.push('PARTITION_CONFLICT')
  }
  if (hmRate !== null && cpRate !== null && Math.abs(hmRate - cpRate) > 1e-9) {
    r.conflicts.push('RATE_CONFLICT')
  }

  if (hmRate !== null) {
    r.usageSource = 'HIT_MISS'
    r.hitTokens = hit
    r.missTokens = miss
    r.denominator = hmDenom
    r.rate = hmRate
  } else if (cpRate !== null && cached !== null && prompt !== null) {
    r.usageSource = 'CACHED_PROMPT'
    r.hitTokens = cached
    r.missTokens = prompt - cached
    r.denominator = prompt
    r.rate = cpRate
  } else {
    r.invalidCodes.push('NO_VALID_DENOMINATOR')
  }
  r.hit = r.hitTokens
  r.miss = r.missTokens

  // 冲突或无效时彻底不产出单一 rate，避免「静默选有利口径」。
  if (r.conflicts.length > 0 || r.invalidCodes.length > 0) r.rate = null
  r.valid = r.invalidCodes.length === 0 && r.conflicts.length === 0 && r.rate !== null
  return r
}

// ---------------------------------------------------------------------------
// 错误脱敏（B5）
// ---------------------------------------------------------------------------

/** 把任意异常映射到固定类别，绝不读 .message / String(error)。 */
export function toFailureCode(error: unknown): string {
  if (error === null || error === undefined) return FAILURE_CODES.UNKNOWN
  if (typeof error !== 'object') return FAILURE_CODES.UNKNOWN
  const name = (error as { name?: unknown }).name
  if (name === 'AbortError') return FAILURE_CODES.CANCELLED
  if (name === 'TimeoutError') return FAILURE_CODES.TIMEOUT
  const ctor = (error as { constructor?: { name?: unknown } }).constructor
  if (ctor?.name === 'TypeError') return FAILURE_CODES.NETWORK_ERROR
  return FAILURE_CODES.UNKNOWN
}

export function classifyRequestError(error: unknown): RequestStatus {
  if (error === null || error === undefined || typeof error !== 'object') return 'UNKNOWN'
  const name = (error as { name?: unknown }).name
  if (name === 'AbortError') return 'CANCELLED'
  if (name === 'TimeoutError') return 'TIMEOUT'
  const ctor = (error as { constructor?: { name?: unknown } }).constructor
  if (ctor?.name === 'TypeError') return 'NETWORK_ERROR'
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string' && /stream|text|read/i.test(message)) return 'STREAM_READ_ERROR'
  return 'UNKNOWN'
}

/** 只允许白名单里的 failureCode 落到产物里；否则强制替换为 INTERNAL。 */
export function sanitizeFailureCode(code: string): string {
  return FAILURE_CODE_SET.has(code) ? code : FAILURE_CODES.INTERNAL
}

// ---------------------------------------------------------------------------
// wiring（B4 / 场景⑧）
// ---------------------------------------------------------------------------

/** 非空、无控制字符的合法 ID。只判形状，绝不输出值。 */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value)
}

/** 合成 wiring 快照：全部为运行内别名，无真实 ID、无真实设备/会话标识。 */
export function buildSyntheticWiringSnapshot(entry: PlanEntry): WiringSnapshot {
  const conversationId = entry.arm === 'ON'
    ? `on-convo-g${entry.group}`
    : `off-convo-${entry.order}`
  const requestId = `req-${entry.order}`
  const messageId = `msg-${entry.order}`
  return {
    group: entry.group,
    arm: entry.arm,
    order: entry.order,
    conversationId,
    requestId,
    messageId,
    rootId: requestId, // Root 与 Request 镜像
    xRequestId: messageId, // usageIdentity 下 X-Request-ID 镜像
  }
}

export function wiringAliases(entry: PlanEntry): WiringAliases {
  return {
    aliasConversationId: `alias-convo-${entry.group}-${entry.arm}-${entry.stage}-${entry.turn}`,
    aliasRequestId: `alias-req-${entry.order}`,
    aliasMessageId: `alias-msg-${entry.order}`,
    aliasRootId: `alias-root-${entry.order}`,
    aliasXRequestId: `alias-xreq-${entry.order}`,
  }
}

export function isValidWiringSnapshot(s: WiringSnapshot, params: ProbeParams): boolean {
  if (!isValidId(s.conversationId) || !isValidId(s.requestId) || !isValidId(s.messageId)) return false
  if (!isValidId(s.rootId)) return false
  if (params.usageIdentity && !isValidId(s.xRequestId)) return false
  return true
}

export function evaluateWiring(snapshots: WiringSnapshot[], params: ProbeParams): WiringResult {
  const codes: string[] = []
  const expectedCount = totalRequests(params)
  const actualCount = snapshots.length
  if (actualCount !== expectedCount) codes.push('WIRING_SNAPSHOT_COUNT_MISMATCH')

  const allIdsValid = snapshots.every((s) => isValidWiringSnapshot(s, params))
  if (!allIdsValid) codes.push('WIRING_INVALID_OR_EMPTY_ID')

  const offConvos = snapshots.filter((s) => s.arm === 'OFF').map((s) => s.conversationId)
  const onConvos = snapshots.filter((s) => s.arm === 'ON').map((s) => s.conversationId)
  const distinctOffConversations = new Set(offConvos).size
  const distinctOnConversations = new Set(onConvos).size
  const offConversationFresh = offConvos.every(isValidId) && distinctOffConversations === offConvos.length
  if (!offConversationFresh) codes.push('OFF_CONVERSATION_NOT_FRESH')

  // ON 稳定性按「组」判定：每个独立冷前缀组内部 1 个 ID。
  let onConversationStable = true
  for (let g = 0; g < params.groups; g += 1) {
    const inGroup = snapshots.filter((s) => s.arm === 'ON' && s.group === g)
    const ids = inGroup.map((s) => s.conversationId)
    if (ids.length === 0 || !ids.every(isValidId) || new Set(ids).size !== 1) {
      onConversationStable = false
      break
    }
  }
  if (!onConversationStable) codes.push('ON_CONVERSATION_NOT_STABLE')

  const messageIds = snapshots.map((s) => s.messageId)
  const requestIds = snapshots.map((s) => s.requestId)
  const messageIdsFresh = messageIds.every(isValidId) && new Set(messageIds).size === messageIds.length
  const requestIdsFresh = requestIds.every(isValidId) && new Set(requestIds).size === requestIds.length
  if (!messageIdsFresh) codes.push('MESSAGE_ID_REUSED_OR_EMPTY')
  if (!requestIdsFresh) codes.push('REQUEST_ID_REUSED_OR_EMPTY')

  const rootMirrorsRequest = snapshots.every((s) => isValidId(s.rootId) && s.rootId === s.requestId)
  if (!rootMirrorsRequest) codes.push('ROOT_REQUEST_MIRROR_BROKEN')

  let xRequestMirrorsMessage = true
  if (params.usageIdentity) {
    xRequestMirrorsMessage = snapshots.every((s) => isValidId(s.xRequestId) && s.xRequestId === s.messageId)
  }
  if (!xRequestMirrorsMessage) codes.push('X_REQUEST_ID_MIRROR_BROKEN')

  return {
    status: codes.length === 0 ? 'PASS' : 'FAIL',
    codes,
    checks: {
      expectedCount,
      actualCount,
      allIdsValid,
      offConversationFresh,
      onConversationStable,
      messageIdsFresh,
      requestIdsFresh,
      rootMirrorsRequest,
      xRequestMirrorsMessage,
      distinctOffConversations,
      distinctOnConversations,
    },
  }
}

// ---------------------------------------------------------------------------
// 记录构建 / 校验（§7 / B3 / B5）
// ---------------------------------------------------------------------------

export interface BuildRecordInput {
  params: ProbeParams
  entry: PlanEntry
  httpStatus: number | null
  requestStatus: RequestStatus
  streamStatus: StreamStatus
  norm: NormalizedUsage
  failureCode: string
  aliases: WiringAliases
  wiringSnapshotValid: boolean
  sentAt: number
  completedAt: number
}

export function buildRecord(input: BuildRecordInput): ProbeRecord {
  const { params, entry, norm } = input
  let usageStatus: UsageStatus
  if (input.requestStatus !== 'OK' || input.streamStatus !== 'COMPLETE') {
    usageStatus = 'MISSING'
  } else if (norm.conflicts.length > 0) {
    usageStatus = 'CONFLICT'
  } else if (norm.invalidCodes.length > 0 || !norm.valid) {
    usageStatus = 'INVALID'
  } else if (norm.usageSource === 'NONE' || norm.rate === null) {
    usageStatus = 'MISSING'
  } else {
    usageStatus = 'OK'
  }

  const complete =
    input.requestStatus === 'OK'
    && input.streamStatus === 'COMPLETE'
    && usageStatus === 'OK'
    && norm.rate !== null
    && norm.denominator !== null
    && norm.hit !== null
    && norm.miss !== null
    && norm.conflicts.length === 0
    && norm.invalidCodes.length === 0

  return {
    kind: 'record',
    schemaVersion: SCHEMA_VERSION,
    runId: syntheticRunId(params),
    templateVersion: params.templateVersion,
    seed: params.seed,
    group: entry.group,
    arm: entry.arm,
    stage: entry.stage,
    turn: entry.turn,
    order: entry.order,
    prefixAlias: entry.prefixAlias,
    sentAt: input.sentAt,
    completedAt: input.completedAt,
    durationMs: input.completedAt - input.sentAt,
    accountAlias: params.accountAlias,
    model: params.model,
    endpointAlias: params.endpointAlias,
    wireProfile: params.wireProfile,
    usageIdentity: params.usageIdentity,
    experimentKind: params.experimentKind,
    httpStatus: input.httpStatus,
    requestStatus: input.requestStatus,
    streamStatus: input.streamStatus,
    usageStatus,
    failureCode: sanitizeFailureCode(input.failureCode),
    hit: norm.hit,
    miss: norm.miss,
    prompt: norm.prompt,
    completion: norm.completion,
    cached: norm.cached,
    usageSource: norm.usageSource,
    denominator: norm.denominator,
    rate: norm.rate,
    conflicts: norm.conflicts,
    invalidCodes: norm.invalidCodes,
    wiring: {
      aliasConversationId: input.aliases.aliasConversationId,
      aliasRequestId: input.aliases.aliasRequestId,
      aliasMessageId: input.aliases.aliasMessageId,
      aliasRootId: input.aliases.aliasRootId,
      aliasXRequestId: input.aliases.aliasXRequestId,
      snapshotValid: input.wiringSnapshotValid,
    },
    complete,
  }
}

export function validateRecord(record: ProbeRecord): RecordValidation {
  const codes: string[] = []
  if (record.schemaVersion !== SCHEMA_VERSION) codes.push('SCHEMA_MISMATCH')
  if (record.requestStatus !== 'OK') codes.push('REQUEST_NOT_OK')
  if (record.streamStatus !== 'COMPLETE') codes.push('STREAM_NOT_COMPLETE')
  if (record.usageStatus !== 'OK') codes.push('USAGE_NOT_OK')
  if (record.rate === null || record.denominator === null || record.hit === null || record.miss === null) {
    codes.push('MISSING_COUNTS')
  }
  if (record.conflicts.length > 0) codes.push('COUNT_CONFLICT')
  if (record.invalidCodes.length > 0) codes.push('USAGE_INVALID')
  const complete = codes.length === 0
  return { valid: codes.length === 0, complete, codes }
}

// ---------------------------------------------------------------------------
// 统计（§6 E4）
// ---------------------------------------------------------------------------

export function computeGroupStats(records: ProbeRecord[], params: ProbeParams): GroupStat[] {
  const out: GroupStat[] = []
  for (let g = 0; g < params.groups; g += 1) {
    const inGroup = records.filter((r) => r.group === g)
    const coldOff = inGroup.find((r) => r.arm === 'OFF' && r.stage === 'cold')
    const coldOn = inGroup.find((r) => r.arm === 'ON' && r.stage === 'cold')
    const coldOk = coldOff !== undefined && coldOn !== undefined && coldOff.complete && coldOn.complete
    const offWarm = inGroup.filter((r) => r.arm === 'OFF' && r.stage === 'warm' && r.complete)
    const onWarm = inGroup.filter((r) => r.arm === 'ON' && r.stage === 'warm' && r.complete)

    let rOff: number | null = null
    let rOn: number | null = null
    const sumRate = (rs: ProbeRecord[]): number | null => {
      let hit = 0
      let denom = 0
      for (const r of rs) {
        if (r.hit === null || r.miss === null) return null
        hit += r.hit
        denom += r.hit + r.miss
      }
      return denom > 0 ? hit / denom : null
    }
    if (offWarm.length === params.warmTurns) rOff = sumRate(offWarm)
    if (onWarm.length === params.warmTurns) rOn = sumRate(onWarm)

    let reason: string | null = null
    if (!coldOk) reason = 'COLD_INCOMPLETE'
    else if (rOff === null || rOn === null) reason = 'WARM_INCOMPLETE'
    const complete = reason === null
    out.push({
      group: g,
      rOff,
      rOn,
      d: complete && rOff !== null && rOn !== null ? rOn - rOff : null,
      complete,
      reason,
    })
  }
  return out
}

export interface BootstrapResult {
  mean: number | null
  ciLow: number | null
  ciHigh: number | null
  iterations: number | null
  seed: number | null
}

/** 以「组」为单位配对 bootstrap，记录 seed；绝不把相关 warm 轮当独立样本。 */
export function pairedBootstrap(
  ds: number[],
  options: { iterations?: number; seed?: number; ciLevel?: number } = {},
): BootstrapResult {
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS
  const seed = options.seed ?? 0
  const ciLevel = options.ciLevel ?? DEFAULT_CI_LEVEL
  if (ds.length === 0) return { mean: null, ciLow: null, ciHigh: null, iterations: null, seed: null }
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const means: number[] = []
  for (let b = 0; b < iterations; b += 1) {
    let sum = 0
    for (let i = 0; i < ds.length; i += 1) {
      sum += ds[Math.floor(rng() * ds.length)]!
    }
    means.push(sum / ds.length)
  }
  means.sort((a, b) => a - b)
  const lowerIndex = Math.max(0, Math.floor(((1 - ciLevel) / 2) * iterations))
  const upperIndex = Math.min(iterations - 1, Math.floor(((1 + ciLevel) / 2) * iterations))
  return {
    mean,
    ciLow: means[lowerIndex] ?? null,
    ciHigh: means[upperIndex] ?? null,
    iterations,
    seed,
  }
}

export function computeStats(records: ProbeRecord[], params: ProbeParams): Stats {
  const groupStats = computeGroupStats(records, params)
  const completeDs = groupStats.filter((g) => g.complete && g.d !== null).map((g) => g.d as number)
  const boot = pairedBootstrap(completeDs, {
    iterations: DEFAULT_BOOTSTRAP_ITERATIONS,
    seed: params.seed,
    ciLevel: DEFAULT_CI_LEVEL,
  })

  // 辅助指标：首个 warm 轮差值（不得替代主指标）。
  let firstWarmOff: number | null = null
  let firstWarmOn: number | null = null
  const fOff = records.find((r) => r.group === 0 && r.arm === 'OFF' && r.stage === 'warm' && r.turn === 1 && r.complete)
  const fOn = records.find((r) => r.group === 0 && r.arm === 'ON' && r.stage === 'warm' && r.turn === 1 && r.complete)
  if (fOff !== undefined && fOff.rate !== null) firstWarmOff = fOff.rate
  if (fOn !== undefined && fOn.rate !== null) firstWarmOn = fOn.rate
  const firstWarmDiff = firstWarmOff !== null && firstWarmOn !== null ? firstWarmOn - firstWarmOff : null

  const weighted = (arm: Arm): number | null => {
    const rs = records.filter((r) => r.arm === arm && r.stage === 'warm' && r.complete)
    let hit = 0
    let denom = 0
    for (const r of rs) {
      if (r.hit === null || r.miss === null) return null
      hit += r.hit
      denom += r.hit + r.miss
    }
    return denom > 0 ? hit / denom : null
  }

  return {
    groupStats,
    completeGroups: completeDs.length,
    plannedGroups: params.groups,
    meanD: boot.mean,
    ciLow: boot.ciLow,
    ciHigh: boot.ciHigh,
    bootstrapIterations: boot.iterations,
    bootstrapSeed: boot.seed,
    firstWarmDiff,
    weightedOnHitRate: weighted('ON'),
    weightedOffHitRate: weighted('OFF'),
  }
}

// ---------------------------------------------------------------------------
// 完整性 / 结论 / 退出码（B4）
// ---------------------------------------------------------------------------

export function computeDataStatus(records: ProbeRecord[], params: ProbeParams, plan: ExperimentPlan): DataStatus {
  if (records.length !== plan.totalRequests) return 'INCOMPLETE'
  for (const r of records) {
    if (r.kind !== 'record' || r.schemaVersion !== SCHEMA_VERSION) return 'INVALID'
  }
  if (records.some((r) => r.invalidCodes.length > 0)) return 'INVALID'
  if (records.some((r) => !r.complete)) return 'INCOMPLETE'
  void params
  return 'COMPLETE'
}

export function classifyEffect(stats: Stats): EffectStatus {
  const mean = stats.meanD
  const low = stats.ciLow
  if (mean === null || low === null) return 'NO_CLEAR_BENEFIT'
  if (mean >= DEFAULT_MIN_MEAN_D && low > 0) return 'BENEFIT_SUPPORTED'
  if (mean > 0 && (low > 0 || mean >= DEFAULT_MIN_MEAN_D)) return 'MIXED'
  return 'NO_CLEAR_BENEFIT'
}

export function containsForbiddenClaim(text: string): string | null {
  for (const claim of FORBIDDEN_CLAIMS) {
    if (text.includes(claim)) return claim
  }
  return null
}

export function buildConclusionText(
  effectStatus: EffectStatus,
  dataStatus: DataStatus,
  wiringStatus: WiringStatus,
  stats: Stats,
  params: ProbeParams,
): string {
  const real = params.experimentKind === 'REAL' ? 'RUN' : 'NOT_RUN'
  if (params.experimentKind === 'OFFLINE_SYNTHETIC') {
    return `结论：离线合成自测（不代表真实收益；E 阶段 ${real}）。`
      + `wiring=${wiringStatus}，data=${dataStatus}，effect=${effectStatus}。`
      + `${MECHANISM_DISCLAIMER}`
  }
  if (effectStatus === 'NOT_EVALUATED') {
    return `结论：数据状态=${dataStatus}、wiring=${wiringStatus}；effectStatus=NOT_EVALUATED，`
      + `未输出任何收益结论。真实上游实验（E 阶段）${real}。${MECHANISM_DISCLAIMER}`
  }
  const mean = stats.meanD
  const lo = stats.ciLow
  const hi = stats.ciHigh
  const meanPct = mean === null ? '?' : (mean * 100).toFixed(1)
  const loPct = lo === null ? '?' : (lo * 100).toFixed(1)
  const hiPct = hi === null ? '?' : (hi * 100).toFixed(1)
  const support = effectStatus === 'BENEFIT_SUPPORTED' ? '支持' : '未明确支持'
  return `在指定构建、账号别名、模型、时间窗口和冻结实验计划下，${stats.completeGroups} 个独立冷前缀组的`
    + `warm 命中率配对平均差为 ${meanPct} 个百分点，95% 区间为 [${loPct},${hiPct}]。`
    + `结果${support}稳定 X-Conversation-ID 在这些条件下改善命中。`
    + `真实上游实验（E 阶段）${real}。${MECHANISM_DISCLAIMER}`
}

export function computeReport(
  records: ProbeRecord[],
  wiring: WiringResult,
  params: ProbeParams,
  plan: ExperimentPlan,
): Report {
  const dataStatus = computeDataStatus(records, params, plan)
  const stats = computeStats(records, params)
  const incompleteRecords = records.filter((r) => !r.complete).length
  const conflictRecords = records.filter((r) => r.conflicts.length > 0).length
  const invalidRecords = records.filter((r) => r.invalidCodes.length > 0).length

  const reasons: string[] = []
  if (wiring.status !== 'PASS') reasons.push('WIRING_FAILED')
  if (dataStatus === 'INCOMPLETE') reasons.push('DATA_INCOMPLETE')
  if (dataStatus === 'INVALID') reasons.push('DATA_INVALID')

  let effectStatus: EffectStatus
  let exitCode: ExitCode
  if (reasons.length > 0) {
    effectStatus = 'NOT_EVALUATED'
    exitCode = EXIT.INVALID_DATA
  } else {
    effectStatus = classifyEffect(stats)
    exitCode = EXIT.COMPLETE
  }

  const conclusionText = buildConclusionText(effectStatus, dataStatus, wiring.status, stats, params)
  const forbidden = containsForbiddenClaim(conclusionText)

  return {
    kind: 'report',
    schemaVersion: SCHEMA_VERSION,
    runId: syntheticRunId(params),
    templateVersion: params.templateVersion,
    experimentKind: params.experimentKind,
    realExperiment: params.experimentKind === 'REAL' ? 'RUN' : 'NOT_RUN',
    wiringStatus: wiring.status,
    dataStatus,
    effectStatus,
    exitCode,
    reasons,
    incompleteRecords,
    conflictRecords,
    invalidRecords,
    totalRecords: records.length,
    stats,
    conclusionText,
    mechanismProven: false,
    forbiddenClaimsFound: forbidden === null ? [] : [forbidden],
  }
}

export function decideExitCode(report: Report): ExitCode {
  return report.exitCode
}

// ---------------------------------------------------------------------------
// 序列化（B5：白名单，绝不回显原始正文 / headers / 异常）
// ---------------------------------------------------------------------------

/** 稳定序列化：键排序，供现场输出与复算逐字节比对。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** 记录序列化：断言不含任何被禁的原始字段。 */
export function serializeRecord(record: ProbeRecord): string {
  const banned = ['message', 'body', 'headers', 'sseText', 'responseText', 'rawError', 'credential', 'token']
  for (const k of Object.keys(record)) {
    if (banned.includes(k)) throw new Error(`REFUSE_SERIALIZE_BANNED_FIELD:${k}`)
  }
  return stableStringify(record)
}
