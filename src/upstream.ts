/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 端点与 wire behavior 由其实现，上游协议本身参照
 *     Sliverkiss/workbuddy2api（MIT）。照搬的部分：按 domain 选择
 *     CN/global base、强制 stream:true、tool_choice 压平为字符串、
 *     CLI 形态请求头、chat 请求绝不携带 refresh token 的安全红线、
 *     中英文额度不足标记与错误分类、token 刷新的 X-Refresh-Token 头。
 * 改动：原版的 `fetchModels` 只保留 id/name/maxInputTokens/maxOutputTokens，
 *   丢弃了上游其余 20 个字段。实测上游每个模型还给出 `credits` 积分倍率、
 *   `supportsImages` 多模态、`reasoning.supportedEfforts` 推理档位、
 *   `descriptionZh/En` 描述等，这些正是模型管理卡片所需的信息，
 *   本实现将其完整解析（解析不出则留空，不虚构）。
 *   `reasoning` 另有两种拼写：复数 `supportedEfforts` 形态与单数 `effort`
 *   形态（只声明默认档；两网关实测这些模型接受全阶梯，不发参数即不
 *   思考），解析层将单数形态折叠为复数（见 parseReasoning，issue #7）。
 *   另：积分接口改为按套餐名聚合，实测单个账号下同名「运营裂变包」
 *   可达 19 个，逐条渲染会淹没卡片。
 *   模型目录路径改为 `/v2/enterprises/personal/models`（原版为
 *   `/console/enterprises/personal/models`）：两版官方桌面 App 均调用
 *   `/v2` 形态，CN 网关两条路径逐字节同答，而国际版网关（workbuddy.ai）
 *   只答 `/v2`、`/console` 形态返回 HTTP 500——统一 `/v2` 即同时覆盖
 *   国内版与国际版（WorkBuddy AI）账号，区域由 `domain` 自动路由。
 *
 * @module dsh-connect-workbuddy/upstream
 */

import type { WorkBuddyCredential } from './auth.ts'

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** Reasoning capability as the upstream catalog declares it. */
export interface WorkBuddyReasoning {
  supportedEfforts?: readonly string[]
  defaultEffort?: string
  canDisableThinking?: boolean
}

/** One CLI-usable model, carrying everything the plugin card displays. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** Credit multiplier parsed from the upstream `credits` string. */
  creditMultiplier?: number
  /**
   * Image-input support decided by the user's explicit selection (imageModelIds),
   * not inferred from the upstream `supportsImages`/`disabledMultimodal` flags,
   * which proved insufficiently reliable. See `catalog.ts` / `index.ts`.
   */
  multimodal?: boolean
  reasoning?: WorkBuddyReasoning
  descriptionZh?: string
  descriptionEn?: string
  supportsToolCall?: boolean
}

/** One billing package and its remaining credit, already aggregated. */
/** One billing package as the upstream returns it, dates already parsed. */
export interface WorkBuddyCreditPackage {
  packageName: string
  remain: number
  size: number
  /** CapacityType 4: refreshed every cycle and never expires. */
  monthly: boolean
  /** Next cycle start (the monthly refresh point); only on monthly packages. */
  refreshAtMs?: number
  /** One-off expiry; the package disappears from the account at this time. */
  expiresAtMs?: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  packages: readonly WorkBuddyCreditPackage[]
  /** Credits expiring within 3 days across every package. */
  expiringSoon: number
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number
}

/** Daily check-in activity state. */
export interface WorkBuddyCheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  claimButtonText?: string
}

/** Daily check-in claim result. */
export interface WorkBuddyCheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}

/** Token refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * Model-catalog path used by the CN region (and the global fallback). The CN
 * gateway answers it with the same bytes as its legacy
 * `/console/enterprises/personal/models` alias. See {@link GLOBAL_CONFIG_PATH}
 * for why the international region reads a different document.
 */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'

/**
 * Remote product-config path on the global gateway. This is the document the
 * desktop channel receives; it is the only source that lists the account's
 * full international chat roster (see {@link DESKTOP_UA}).
 */
const GLOBAL_CONFIG_PATH = '/v3/config'

const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/**
 * User agent of the WorkBuddy desktop app.
 *
 * The config service serves a DIFFERENT product configuration per client
 * channel, selected by this product token — the version suffix is ignored
 * (`WorkBuddy/5.5.2`, `WorkBuddy/1.0.0` and a bare `WorkBuddy` answer
 * identically). On the INTERNATIONAL gateway the split decides which models
 * exist at all:
 *
 *   - CLI channel (`CLI/… CodeBuddy/…`) → 35 models that OMIT
 *     `deepseek-v4.1-flash` and `gpt-6-astra`, even though both are perfectly
 *     chat-usable (verified: `deepseek-v4.1-flash` streams HTTP 200 and is
 *     billed `x0.00`);
 *   - desktop channel → the account's real 20-model chat roster including both.
 *
 * The plugin emulates the CLI channel for CHAT but reads the desktop channel's
 * configuration to learn the account's actual model list. The CN gateway needs
 * no such switch: its desktop config carries no `cli` agent roster at all, so
 * CN keeps reading the shared `/v2/enterprises/personal/models` path.
 */
const DESKTOP_UA = 'WorkBuddy/5.5.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/**
 * Region for a login domain; an empty domain means CN (matching upstream tooling).
 *
 * The international product is reachable under TWO brand domains: the WorkBuddy
 * AI desktop app signs in at `workbuddy.ai`, while the CodeBuddy CLI signs the
 * same international account in at `codebuddy.ai` (verified against a real
 * credential file, issue #4). Both are served by the same gateway stack — a
 * read-only probe shows `/v3/config` answering HTTP 200 with the same JSON
 * envelope on both hosts — so both classify as `global`. Missing the
 * `codebuddy.ai` spelling sent those tokens to the CN gateway, which rejected
 * them at the openresty layer with an HTML 401.
 */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/**
 * Gateway for a global credential.
 *
 * International accounts are NOT interchangeable across brand domains: a token
 * issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway (and vice
 * versa), so the base must follow the credential's OWN domain rather than a
 * single hardcoded host. Anything unrecognised falls back to `workbuddy.ai`,
 * the desktop app's gateway.
 */
export function globalBase(domain: string): string {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
  }
  return headers
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming) and flatten
 * `tool_choice` (the upstream's field is a string; object forms return 400).
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  // DSH sends its system prompt using OpenAI's newer `developer` role.
  // WorkBuddy's CLI channel accepts the equivalent `system` role but rejects
  // `developer` with business code 11128 (unapproved channel).
  if (Array.isArray(obj['messages'])) {
    for (const value of obj['messages']) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const message = value as Record<string, unknown>
      if (message['role'] === 'developer') message['role'] = 'system'
    }
  }
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

/**
 * Gateway (openresty/APISIX) rejection of a token it no longer accepts.
 *
 * The business APIs answer JSON; an edge rejection answers an HTML error page
 * instead. A 401 that is not JSON therefore means the credential was refused
 * before routing — almost always a revoked/expired token rather than a bug in
 * the request. Detected from the body so a proxy's own error page (which would
 * also be HTML) is still described accurately.
 */
function isGatewayAuthRejection(status: number, text: string): boolean {
  if (status !== 401 && status !== 403) return false
  const lower = text.toLowerCase()
  return lower.includes('openresty') || lower.includes('apisix') || lower.includes('authorization required')
}

/** Marker carried by {@link WorkBuddyCredentialRejectedError}; survives bundling. */
export const CREDENTIAL_REJECTED_CODE = 'WORKBUDDY_CREDENTIAL_REJECTED'

/**
 * The upstream refused the CREDENTIAL itself rather than failing the request.
 *
 * This is a distinct, actionable class: the token is not usable and no retry
 * with the same token will help. Callers use it to tell the user what to do
 * about it (switch accounts, or sign in again) instead of showing a raw HTTP
 * error, and the card must never confuse it with a transient upstream fault.
 *
 * Identified by {@link CREDENTIAL_REJECTED_CODE} rather than `instanceof`, so
 * the check keeps working when the caller and the thrower end up in different
 * module instances (bundled host half vs. a test's source import).
 */
export class WorkBuddyCredentialRejectedError extends Error {
  readonly code = CREDENTIAL_REJECTED_CODE
  /** HTTP status the upstream answered with (401 or 403). */
  readonly status: number

  constructor(status: number) {
    super(
      `workbuddy: the signed-in credential was rejected by the upstream gateway (http ${status}).`
      + ' The stored token is no longer accepted — most likely a stale credential file from an earlier'
      + ' sign-in was selected. Re-sign in to the WorkBuddy desktop app, then pick that account in the'
      + ' plugin card. Run `dsh-connect-workbuddy doctor` to list every discovered credential.',
    )
    this.name = 'WorkBuddyCredentialRejectedError'
    this.status = status
  }
}

/** Whether an error reports that the upstream refused the credential itself. */
export function isCredentialRejectedError(value: unknown): value is WorkBuddyCredentialRejectedError {
  return typeof value === 'object'
    && value !== null
    && (value as { code?: unknown }).code === CREDENTIAL_REJECTED_CODE
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (isGatewayAuthRejection(response.status, text)) {
      throw new WorkBuddyCredentialRejectedError(response.status)
    }
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  const envelope: Envelope = {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
  return envelope
}

/**
 * Fail an envelope whose business code is non-zero, classified like HTTP errors.
 *
 * A JSON body on a 401/403 is still a credential refusal: the edge answered in
 * the business shape, but the token is just as unusable, so it maps to the same
 * actionable error instead of a generic "client" failure.
 */
function envelopeError(status: number, envelope: Envelope): Error {
  if (status === 401 || status === 403) return new WorkBuddyCredentialRejectedError(status)
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Parse the upstream's `credits` string into a multiplier.
 *
 * Observed forms: `"x0.79 credits"`, `"x0.05"`, `"x0.00 credits"`,
 * and absent. Unparsable values yield undefined rather than a guess — the
 * card simply omits the rate instead of displaying a fabricated one.
 */
export function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * The effort vocabulary the upstream's plural-form payloads declare across both
 * gateways (live union of every `supportedEfforts` list seen; `minimal` has
 * never appeared). Both gateways also accept every level in it on
 * singular-form models — medium/xhigh fold into high, low/max answer with
 * their own budgets — so the singular `effort` value is a DEFAULT, never the
 * model's only level.
 */
const SINGULAR_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The singular spelling of reasoning metadata: `effort` (plus the ignored
 * `summary`) and none of the plural-form fields. Observed on CN
 * `deepseek-v4.1-flash`/`kimi-k3-1`/`glm-5.2`… and global
 * `deepseek-v4.1-flash`/`kimi-k3`/`gemini-3.5-flash`… (issue #7).
 */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
  return typeof raw['effort'] === 'string'
    && !Array.isArray(raw['supportedEfforts'])
    && typeof raw['defaultEffort'] !== 'string'
    && typeof raw['canDisableThinking'] !== 'boolean'
}

/**
 * Fold a singular-form `effort` into the plural shape the rest of the plugin
 * already understands. Live probes on both gateways (issue #7) show these
 * models answer with distinct `reasoning_content` across the whole ladder —
 * and think NOT AT ALL when no `reasoning_effort` is sent — so the fold
 * widens `supportedEfforts` and carries the declared value into
 * `defaultEffort`. An unrecognized `effort` value passes through as the lone
 * level, leaving its fate to the adapter's known-level filter.
 */
function singularEffortLadder(raw: Record<string, unknown>): string[] | undefined {
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  if (effort === undefined) return undefined
  return (SINGULAR_EFFORT_LADDER as readonly string[]).includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort]
}

/**
 * Parse the upstream's `reasoning` object; unknown shapes degrade to `{}`.
 * Both spellings normalize here: the plural form passes through as declared,
 * and the singular `effort` form folds via {@link singularEffortLadder}.
 */
export function parseReasoning(value: unknown): WorkBuddyReasoning | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  const supportedEfforts = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string')
    : singularEffortLadder(raw)
  const defaultEffort = typeof raw['defaultEffort'] === 'string' ? raw['defaultEffort'] : effort
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean'
    ? raw['canDisableThinking']
    : isSingularEffortForm(raw) ? true : undefined
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
    return undefined
  }
  return {
    ...supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...canDisableThinking === undefined ? {} : { canDisableThinking },
  }
}

/** Parse one catalog entry; entries without usable token limits are dropped. */
export function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const descriptionZh = typeof raw['descriptionZh'] === 'string' && raw['descriptionZh'] !== '' ? raw['descriptionZh'] : undefined
  const descriptionEn = typeof raw['descriptionEn'] === 'string' && raw['descriptionEn'] !== '' ? raw['descriptionEn'] : undefined
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const reasoning = parseReasoning(raw['reasoning'])
  const supportsToolCall = typeof raw['supportsToolCall'] === 'boolean' ? raw['supportsToolCall'] : undefined
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    ...reasoning === undefined ? {} : { reasoning },
    ...descriptionZh === undefined ? {} : { descriptionZh },
    ...descriptionEn === undefined ? {} : { descriptionEn },
    ...supportsToolCall === undefined ? {} : { supportsToolCall },
  }
}

/**
 * Select the chat-capable models from a catalog-shaped document: parse every
 * entry, then keep the `cli` agent's roster in its declared order.
 *
 * Both the CN personal-models document and the global `/v3/config` document
 * carry `models` plus an `agents` roster with the same entry shape, so one
 * selector serves them. Without a usable `cli` roster the whole parsed catalog
 * is exposed rather than nothing: the roster is an upstream detail that may
 * change, and an empty answer would silently disarm the provider.
 */
export function selectCliModels(rawModels: unknown, agents: unknown): WorkBuddyUpstreamModel[] {
  const byId = new Map<string, WorkBuddyUpstreamModel>()
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    const parsed = parseUpstreamModel(model)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  let cliIds: readonly string[] | undefined
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (typeof agent === 'object' && agent !== null) {
      const wrapped = agent as Record<string, unknown>
      if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
        cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
        break
      }
    }
  }
  const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
  const models = ids
    .map(id => byId.get(id))
    .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
  if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
  return models
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * Read the model directory for the credential's region.
   *
   * The two regions expose their chat roster through different documents:
   * CN answers `/v2/enterprises/personal/models`, while the global gateway's
   * personal-models path returns HTTP 500 and the CLI channel's `/v3/config`
   * omits chat-usable models — so global reads `/v3/config` as the desktop
   * channel (see {@link DESKTOP_UA}). Both documents share the entry shape, so
   * one parser serves them. No user-side toggle is involved: the region comes
   * from the credential's `domain`.
   */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS)
    if (regionOf(credential.domain) === 'global') {
      const response = await fetch(`${globalBase(credential.domain)}${GLOBAL_CONFIG_PATH}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
          ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
          'X-Product': 'SaaS',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'close',
          'User-Agent': DESKTOP_UA,
        },
        signal: timeout,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      return selectCliModels(data['models'], data['agents'])
    }
    const response = await fetch(`${chatBase(credential)}${MODELS_CATALOG_PATH}`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Origin': originReferer(credential),
        'Referer': `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA,
      },
      signal: timeout,
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    return selectCliModels(data['models'], data['agents'])
  }

  /** Query today's check-in status without changing account state. */
  async fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus> {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      active: data['active'] === true,
      todayCheckedIn: data['today_checked_in'] === true,
      streakDays: numberField('streak_days'),
      dailyCredit: numberField('daily_credit'),
      todayCredit: numberField('today_credit'),
      isStreakDay: data['is_streak_day'] === true,
      nextStreakDay: numberField('next_streak_day'),
      streakBonusDays: numberField('streak_bonus_days'),
      streakBonusCredit: numberField('streak_bonus_credit'),
      ...typeof data['claim_button_text'] === 'string' && data['claim_button_text'] !== ''
        ? { claimButtonText: data['claim_button_text'] }
        : {},
    }
  }

  /** Claim today's check-in reward. The browser route guards this mutation. */
  async claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim> {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      credit: numberField('credit'),
      streakDays: numberField('streak_days'),
      isStreakDay: data['is_streak_day'] === true,
    }
  }

  /**
   * POST the billing endpoint for the remaining credit, keeping every package
   * separate: the card groups monthly-cycle packages itself and lists the
   * nearest-expiring one-off packages, so aggregation here would lose the
   * dates it needs.
   */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
      ? responseWrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []

    let total = 0
    let nearestExpiryMs: number | undefined
    let expiringSoon = 0
    const SOON_MS = 3 * 24 * 60 * 60 * 1000
    const parseDate = (raw: unknown): number | undefined => {
      if (typeof raw === 'number' && raw > 1000000000000) return raw
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw)
        if (!Number.isNaN(parsed)) return parsed
      }
      return undefined
    }
    const packages: WorkBuddyCreditPackage[] = []
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      // CapacityType 4 = monthly capacity resource (refreshed every cycle, never
      // expires: empty ExpiredTime, DeductionEndTime years out). CapacityType 1 =
      // deduction-based gift (CapacityRemain drains to 0, ExpiredTime set).
      // CycleEndTime exists on both, so it alone cannot tell them apart.
      const monthly = numberField('CapacityType') === 4
      const size = monthly ? numberField('CycleCapacitySize') : numberField('CapacitySize')
      const remain = monthly ? numberField('CycleCapacityRemain') : numberField('CapacityRemain')
      const cappedRemain = remain < 0 ? 0 : remain
      // For the monthly resource the cycle end is the refresh point; display the
      // next cycle's start (end + 1s) since "refreshes on 08/31 23:59:59" reads
      // like the package dies then. For a gift, ExpiredTime is when it vanishes.
      const cycleEndMs = parseDate(account['CycleEndTime'])
      const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs
      const refreshAtMs = monthly
        ? cycleEndMs === undefined ? undefined : cycleEndMs + 1_000
        : undefined
      // Drop one-off gifts that are exhausted or already expired: they carry
      // no usable credits and would clutter the nearest-expiry list. Monthly
      // resources (CapacityType 4) are always kept.
      if (!monthly && (cappedRemain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) {
        continue
      }
      total += cappedRemain
      const expiryMs = expiresAtMs
      if (expiryMs !== undefined) {
        if (nearestExpiryMs === undefined || expiryMs < nearestExpiryMs) nearestExpiryMs = expiryMs
        if (expiryMs - Date.now() <= SOON_MS) expiringSoon += cappedRemain
      }
      packages.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain: cappedRemain,
        size,
        monthly,
        ...refreshAtMs === undefined ? {} : { refreshAtMs },
        ...expiresAtMs === undefined ? {} : { expiresAtMs },
      })
    }
    return {
      total,
      packages,
      expiringSoon,
      ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
    }
  }
}
