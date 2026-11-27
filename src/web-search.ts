/**
 * WorkBuddy-backed search provider for DSH's `ctx.web` seam.
 *
 * DSH 的 `web_search` 工具由宿主 `@deepseek-ai/dsh-tool-web` 注册；它只负责
 * schema、提示词与结果格式化，真正的检索交给 `ctx.web.search()` 选中的 provider。
 * 本模块实现其中的 WorkBuddy provider：用本插件的账号凭据调用 WorkBuddy 桌面
 * App 自己在用的 agenttool 端点，让 DSH 里的联网搜索走 WorkBuddy 的登录态。
 *
 * 两条检索路径，都从同一个 `{base}/agenttool/v1` 命名空间出发：
 *   1. 快路径 `POST {base}/agenttool/v1/search` —— 结构化结果
 *      `{results: [{title, url, snippet, date}]}`，约 1 秒完成。这是默认路径。
 *   2. 综述路径 `POST {base}/agenttool/v1/agentic_search` —— SSE 流，
 *      `done` 帧的 `synthesis.content` 是一段带引用的综述，约 10–60 秒。
 *      可选开启（综述更完整，但慢且吃积分）。
 *
 * 设计约束（项目级）：
 * - 不依赖任何其它插件，不检查、不枚举、不转交任何别的注册；凭据经调用方注入
 *   的 `resolveCredential` 回调取得（本插件已有的 `WorkBuddyCredentialStore`）。
 * - 不读写别人的凭据文件：token 刷新由回调里注入的 `refreshToken` 在内存完成。
 * - 只做只读查询：模块本身不写盘；把宿主 `searchProvider` 指向本 provider 由
 *   index.ts 的开关联动负责（provider 以新 id 注册，不顶替内置 id）。
 *
 * 端点与 SSE 格式来自对 WorkBuddy 桌面 App 的公开逆向记录；本实现按其协议
 * 独立编写，不复制任何第三方插件的代码。
 *
 * @module dsh-connect-workbuddy/web-search
 */

import type { WorkBuddyCredential } from './auth.ts'
import { globalBase, regionOf } from './upstream.ts'

/** 本 provider 注册的 id。与任何第三方插件的 id 都不相同，避免撞车。 */
export const WORKBUDDY_SEARCH_PROVIDER_ID = 'dsh-connect-workbuddy-search'

/** 展示在宿主设置页下拉框里的名字。 */
export const WORKBUDDY_SEARCH_PROVIDER_TITLE = 'WorkBuddy（本插件登录态）'

/** 快路径：结构化 snippet 检索。 */
const SEARCH_PATH = '/agenttool/v1/search'
/** 综述路径：SSE agentic 检索。 */
const AGENTIC_SEARCH_PATH = '/agenttool/v1/agentic_search'
/** 默认网关（CN）。`globalBase` 处理国际区各品牌域名。 */
const CN_BASE = 'https://copilot.tencent.com'

/** 综述模式的 SSE 读取上限：一次综述实测 10–60 秒，留足余量。 */
const AGENTIC_TIMEOUT_MS = 180_000
/** 综述回传上限（字符），防止一篇综述塞满上下文。 */
const DEFAULT_MAX_CONTENT_CHARS = 30_000
/** 最多返回的来源数。 */
const DEFAULT_MAX_SOURCES = 10

/** 与宿主 `@deepseek-ai/dsh-web` 的 `WebSearchProvider` 同形；手写以避开 peer 依赖。 */
export interface WebSearchProviderLike {
  readonly id: string
  readonly title: string
  readonly description?: string
  available(): boolean
  search(request: WebSearchRequestLike, signal?: AbortSignal): Promise<WebSearchResultLike>
}

export interface WebSearchRequestLike {
  readonly query: string
  readonly maxResults?: number
  readonly llmProvider?: string
}

export interface WebSearchSourceLike {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

export interface WebSearchResultLike {
  readonly content?: string
  readonly sources: readonly WebSearchSourceLike[]
  readonly truncated: boolean
}

/** 调用方注入的依赖：凭据解析 + 可选 token 刷新 + 区域网关覆盖。 */
export interface WorkBuddySearchDeps {
  /**
   * 按模型路由取当前选中的账号凭据。`llmProvider` 是 `workbuddy` / `workbuddy-global`
   * 之一；未指定时取任一已启用区。无可用账号时抛错。
   */
  resolveCredential(llmProvider?: string): Promise<WorkBuddyCredential>
  /**
   * 上游拒绝（401/会话失效）时强制刷新凭据再试一次。返回新凭据后由调用方
   * 决定是否重试搜索；不写盘。
   */
  refreshToken?(credential: WorkBuddyCredential): Promise<WorkBuddyCredential>
  /** CN 网关覆盖（issue #220）；空串表示用默认网关。 */
  cnBase?(): string
  /** 是否走慢速综述路径；默认 false（快路径）。 */
  agentic?(): boolean
  /** 综述回传上限；0 表示不截断。 */
  maxContentChars?(): number
  /** fetch 注入，便于测试。 */
  fetcher?: typeof fetch
  /** 日志钩子（可选）。 */
  logger?: { warn(message: string): void }
}

/** 结构化的搜索失败，带稳定的机器可读 code。 */
export class WorkBuddyWebSearchError extends Error {
  readonly code: string
  readonly status?: number

  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'WorkBuddyWebSearchError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/** 凭据按自己的 domain 选网关；CN 允许设置里覆盖的网关。 */
function baseFor(credential: WorkBuddyCredential, cnBase?: string): string {
  if (regionOf(credential.domain) === 'global') return globalBase(credential.domain)
  return cnBase === undefined || cnBase === '' ? CN_BASE : cnBase
}

/** 本模块对外的请求头：Bearer + 一个最小的 JSON 客户端形状。 */
function requestHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
  }
}

/** 把凭据与网关覆盖绑定成一个可复用的调用上下文。 */
interface CallContext {
  readonly credential: WorkBuddyCredential
  readonly base: string
  readonly fetcher: typeof fetch
}

/** 上游返回的信封形状：code 非 0 视为业务失败。 */
interface Envelope {
  readonly code?: unknown
  readonly msg?: unknown
  readonly data?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 401 或带会话失效标记的上游响应：值得刷新一次凭据再试。 */
function sessionDead(status: number, body: string): boolean {
  return status === 401
    || body.includes('Offline user session not found')
    || body.includes('12153')
}

/**
 * 统一的上游诊断文本：只取有限长度，且在放进模型可见的错误前做脱敏。
 *
 * 仓库是公开的、发布到 npm，错误文本会被模型看到并可能被贴进 issue。上游
 * body 可能含 uid / 手机号 / 邮箱 / 本机路径，这些一律替换成占位符；这层
 * 与 `scripts/check-pii.mjs` 的发布门禁是两道独立防线。
 */
function brief(body: string, limit = 300): string {
  let text = body.replace(/\s+/gu, ' ').trim()
  text = text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, '<email>')
    .replace(/(?:[A-Za-z]:)?[\\/]Users[\\/][^\s'"]+/giu, '<path>')
    .replace(/\d{6,}/gu, '<id>')
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * 执行一次检索，必要时刷新凭据重试一次。
 *
 * 重试只在「明确会话失效」时发生：401 或上游给出的会话失效文案。其它失败
 * （限流、格式错误、断网）原样上抛，避免用同一个坏请求反复扣费。
 */
async function withFreshCredential<T>(
  deps: WorkBuddySearchDeps,
  llmProvider: string | undefined,
  signal: AbortSignal | undefined,
  run: (ctx: CallContext) => Promise<T>,
): Promise<T> {
  let credential = await deps.resolveCredential(llmProvider)
  const cnBase = deps.cnBase?.()
  const fetcher = deps.fetcher ?? fetch
  try {
    return await run({ credential, base: baseFor(credential, cnBase), fetcher })
  } catch (error) {
    if (!(error instanceof WorkBuddyWebSearchError) || error.code !== 'WB_SEARCH_SESSION_DEAD') throw error
    if (deps.refreshToken === undefined) throw error
    const refreshed = await deps.refreshToken(credential)
    if (refreshed.accessToken === credential.accessToken) throw error
    credential = refreshed
    deps.logger?.warn('dsh-connect-workbuddy: web search credential refreshed after a session-dead response; retrying once')
    return await run({ credential, base: baseFor(credential, cnBase), fetcher })
  }
}

/**
 * 读取并校验 JSON 信封。`code` 非 0 一律按业务失败处理，不把错误体当结果。
 */
function readEnvelope(text: string, status: number): Envelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new WorkBuddyWebSearchError(
      `WorkBuddy search returned non-JSON response: ${brief(text)}`,
      'WB_SEARCH_UPSTREAM_ERROR',
      status,
    )
  }
  if (!isRecord(parsed)) {
    throw new WorkBuddyWebSearchError(
      'WorkBuddy search returned a non-object response',
      'WB_SEARCH_UPSTREAM_ERROR',
      status,
    )
  }
  if (parsed['code'] !== undefined && parsed['code'] !== 0) {
    const msg = typeof parsed['msg'] === 'string' ? parsed['msg'] : ''
    const dead = sessionDead(status, msg)
    throw new WorkBuddyWebSearchError(
      `WorkBuddy search failed (code ${String(parsed['code'])}): ${brief(msg)}`,
      dead ? 'WB_SEARCH_SESSION_DEAD' : 'WB_SEARCH_UPSTREAM_ERROR',
      status,
    )
  }
  return parsed
}

/** 裸 URL 的定界：空白、常见括号与引号、中韩日表意文字都不许进入 URL。 */
const BARE_URL = /https?:\/\/[^\s<>()[\]{}"'`\u2018\u2019\u201C\u201D\u2026\u2013\u2014\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]+/gu
/** Markdown 链接，标题限长以避免病态输入上的回溯。 */
const MD_LINK = /\[([^\]\n]{0,200})\]\(\s*(https?:\/\/[^()\s]+(?:\)[^()\s]+)?)/gu
/** 综述里的内部标记，不应当出现在模型看到的正文里。 */
const SELECTED_REFS_OPEN = /<selected-refs\b[^>]*>/giu
const SELECTED_REFS_BODY = /^[\s\S]*?<\/selected-refs\s*>/iu
const SELECTED_REFS_ANY = /<\/?selected-refs\b[^>]*>/giu

/** 剥掉 URL 末尾粘着的标点与 markdown 记号，并纠正多余的右括号。 */
function trimUrl(value: string): string {
  const trailing = /[.,;:'"`*~|_\]）、。，；：！？【】《》「」『』“”‘’…—·>]+$/u
  let out = value.trim().replace(trailing, '')
  while (out.endsWith(')') && (out.match(/\)/gu) ?? []).length > (out.match(/\(/gu) ?? []).length) {
    out = out.slice(0, -1).replace(trailing, '')
  }
  return out
}

/** 去掉桌面 UI 的内部标记，返回可安全交给模型的综述正文。 */
export function cleanSynthesis(content: string): string {
  const parts = content.split(SELECTED_REFS_OPEN)
  let out = parts[0] ?? ''
  for (let i = 1; i < parts.length; i += 1) {
    const segment = parts[i] ?? ''
    out += segment.replace(SELECTED_REFS_BODY, '')
  }
  return out.replace(SELECTED_REFS_ANY, '').trim()
}

/**
 * 从综述里提取引用来源：markdown 链接优先，裸 URL 兜底，按 URL 去重。
 *
 * 返回的 `capped` 表示来源被上限截掉过，供 provider 设置 `truncated`。
 */
export function extractSources(
  content: string,
  max: number = DEFAULT_MAX_SOURCES,
): { sources: WebSearchSourceLike[], capped: boolean } {
  const seen = new Set<string>()
  const candidates: WebSearchSourceLike[] = []
  const consider = (raw: string, title?: string): void => {
    const url = trimUrl(raw)
    if (!/^https?:\/\//iu.test(url) || seen.has(url)) return
    seen.add(url)
    candidates.push(title === undefined ? { url } : { url, title })
  }

  const links = [...content.matchAll(MD_LINK)]
  const spans: Array<readonly [number, number]> = links.map(match => [match.index, match.index + match[0].length])
  for (const match of links) consider(match[2] ?? '', match[1])
  for (const match of content.matchAll(BARE_URL)) {
    if (spans.some(([from, to]) => match.index >= from && match.index < to)) continue
    consider(match[0])
  }

  const capped = candidates.length > max
  return { sources: capped ? candidates.slice(0, max) : candidates, capped }
}

/** SSE 帧分隔（空行）：规范允许 LF、CR、CRLF 及其混合，取最早出现者。 */
function findFrameSeparator(buffer: string): { index: number, length: number } | undefined {
  let best: { index: number, length: number } | undefined
  const consider = (index: number, length: number): void => {
    if (index < 0) return
    if (best === undefined || index < best.index) best = { index, length }
  }
  consider(buffer.indexOf('\n\n'), 2)
  consider(buffer.indexOf('\r\n\r\n'), 4)
  consider(buffer.indexOf('\r\r'), 2)
  consider(buffer.indexOf('\n\r\n'), 3)
  consider(buffer.indexOf('\r\n\n'), 3)
  return best
}

/** 解析单个 SSE 帧的 event 与 data（data 多行按规范拼接）。 */
function parseSseFrame(frame: string): { event: string, data: string } {
  let event = ''
  let data = ''
  for (const raw of frame.split(/\r\n|\r|\n/u)) {
    if (raw.startsWith('event:')) event = raw.slice(6).trim()
    else if (raw.startsWith('data:')) data += raw.slice(5).replace(/^ /u, '')
  }
  return { event, data }
}

/** 综述路径：读 SSE 流，取 done 帧的 `synthesis.content`。 */
async function callAgentic(
  ctx: CallContext,
  query: string,
  signal: AbortSignal | undefined,
  maxContentChars: number,
): Promise<WebSearchResultLike> {
  if (signal?.aborted) throw new WorkBuddyWebSearchError('WorkBuddy search aborted', 'WEB_ABORTED')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('agentic search timeout')), AGENTIC_TIMEOUT_MS)
  const onAbort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  let response: Response | undefined
  try {
    response = await ctx.fetcher(`${ctx.base}${AGENTIC_SEARCH_PATH}`, {
      method: 'POST',
      headers: { ...requestHeaders(ctx.credential), Accept: 'text/event-stream' },
      body: JSON.stringify({ query, search_mode: 2, stream: true, biz_via: ctx.credential.enterpriseId === undefined ? 'public' : 'internal' }),
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new WorkBuddyWebSearchError('WorkBuddy search aborted', 'WEB_ABORTED')
    throw new WorkBuddyWebSearchError(`WorkBuddy agentic search transport failed: ${String(error)}`, 'WB_SEARCH_TRANSPORT_ERROR')
  } finally {
    clearTimeout(timer)
    if (response === undefined) signal?.removeEventListener('abort', onAbort)
  }

  if (!response.ok) {
    signal?.removeEventListener('abort', onAbort)
    const body = await response.text().catch(() => '')
    if (sessionDead(response.status, body)) {
      throw new WorkBuddyWebSearchError('WorkBuddy search session dead', 'WB_SEARCH_SESSION_DEAD', response.status)
    }
    throw new WorkBuddyWebSearchError(
      `WorkBuddy agentic search failed: HTTP ${response.status} ${brief(body)}`,
      'WB_SEARCH_UPSTREAM_ERROR',
      response.status,
    )
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    signal?.removeEventListener('abort', onAbort)
    throw new WorkBuddyWebSearchError('WorkBuddy agentic search has no body stream', 'WB_SEARCH_UPSTREAM_ERROR')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let synthesis = ''
  /** Consume every complete frame currently in `buffer`. */
  const drainFrames = (): void => {
    for (;;) {
      const separator = findFrameSeparator(buffer)
      if (separator === undefined) break
      const frame = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator.length)
      const { event, data } = parseSseFrame(frame)
      if (event === 'error') {
        // 上游用 error 帧报失败；别把它当静默无结果，那样会误报 EMPTY_RESULT。
        throw new WorkBuddyWebSearchError(
          `WorkBuddy agentic search reported an error frame: ${data.slice(0, 200)}`,
          'WB_SEARCH_UPSTREAM_ERROR',
        )
      }
      if (event !== 'done' || data === '') continue
      let content: unknown
      try {
        content = JSON.parse(data)?.synthesis?.content
      } catch {
        continue
      }
      if (typeof content === 'string') synthesis = content
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      drainFrames()
    }
    // 上游常在最后的 done 帧后直接关流，不补空行。此时 buffer 里还有最后一帧，
    // 不冲出来就会丢掉 synthesis，误报 EMPTY_RESULT。
    buffer += decoder.decode()
    if (buffer.trim() !== '') {
      if (findFrameSeparator(buffer) === undefined) {
        // 无尾随空行：把剩余内容整体当一帧解析。
        const { event, data } = parseSseFrame(buffer)
        if (event === 'error') {
          throw new WorkBuddyWebSearchError(
            `WorkBuddy agentic search reported an error frame: ${data.slice(0, 200)}`,
            'WB_SEARCH_UPSTREAM_ERROR',
          )
        }
        if (event === 'done' && data !== '') {
          try {
            const content = JSON.parse(data)?.synthesis?.content
            if (typeof content === 'string') synthesis = content
          } catch { /* 非 JSON 的尾帧忽略 */ }
        }
      } else {
        drainFrames()
      }
    }
  } catch (error) {
    if (error instanceof WorkBuddyWebSearchError) throw error
    if (signal?.aborted) throw new WorkBuddyWebSearchError('WorkBuddy search aborted', 'WEB_ABORTED')
    throw new WorkBuddyWebSearchError(`WorkBuddy agentic stream failed: ${String(error)}`, 'WB_SEARCH_TRANSPORT_ERROR')
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => {})
  }

  if (signal?.aborted) throw new WorkBuddyWebSearchError('WorkBuddy search aborted', 'WEB_ABORTED')
  if (synthesis === '') {
    throw new WorkBuddyWebSearchError('WorkBuddy agentic search ended without synthesis content', 'WB_SEARCH_EMPTY_RESULT')
  }
  const cleaned = cleanSynthesis(synthesis)
  const bounded = maxContentChars > 0 && cleaned.length > maxContentChars
    ? cleaned.slice(0, maxContentChars)
    : cleaned
  const { sources, capped } = extractSources(cleaned)
  return { content: bounded, sources, truncated: capped }
}

/**
 * 快路径：结构化 snippet 检索。返回 `{results: [...]}` 或 `{data: {results: [...]}}`。
 */
async function callSnippet(
  ctx: CallContext,
  query: string,
  maxResults: number | undefined,
  signal: AbortSignal | undefined,
): Promise<WebSearchResultLike> {
  if (signal?.aborted) throw new WorkBuddyWebSearchError('WorkBuddy search aborted', 'WEB_ABORTED')
  let response: Response
  try {
    response = await ctx.fetcher(`${ctx.base}${SEARCH_PATH}`, {
      method: 'POST',
      headers: requestHeaders(ctx.credential),
      body: JSON.stringify({ query, ...maxResults === undefined ? {} : { max_results: maxResults } }),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    if (signal?.aborted) throw new WorkBuddyWebSearchError('WorkBuddy search aborted', 'WEB_ABORTED')
    throw new WorkBuddyWebSearchError(`WorkBuddy search transport failed: ${String(error)}`, 'WB_SEARCH_TRANSPORT_ERROR')
  }
  const body = await response.text().catch(() => '')
  if (!response.ok) {
    if (sessionDead(response.status, body)) {
      throw new WorkBuddyWebSearchError('WorkBuddy search session dead', 'WB_SEARCH_SESSION_DEAD', response.status)
    }
    throw new WorkBuddyWebSearchError(
      `WorkBuddy search failed: HTTP ${response.status} ${brief(body)}`,
      'WB_SEARCH_UPSTREAM_ERROR',
      response.status,
    )
  }
  const envelope = readEnvelope(body, response.status)
  const raw = isRecord(envelope.data) ? envelope.data['results'] : (envelope as Record<string, unknown>)['results']
  if (!Array.isArray(raw)) {
    throw new WorkBuddyWebSearchError('WorkBuddy search returned no results array', 'WB_SEARCH_UPSTREAM_ERROR')
  }

  const seen = new Set<string>()
  const sources: WebSearchSourceLike[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const url = typeof item['url'] === 'string' ? trimUrl(item['url']) : ''
    if (!/^https?:\/\//iu.test(url) || seen.has(url)) continue
    seen.add(url)
    const source: WebSearchSourceLike = {
      url,
      ...typeof item['title'] === 'string' && item['title'].trim() !== '' ? { title: item['title'].trim() } : {},
      ...typeof item['snippet'] === 'string' && item['snippet'].trim() !== '' ? { snippet: item['snippet'].trim() } : {},
      ...typeof item['date'] === 'string' && item['date'].trim() !== '' ? { publishedAt: item['date'].trim() } : {},
    }
    sources.push(source)
    if (maxResults !== undefined && sources.length >= maxResults) break
  }
  return { sources, truncated: sources.length < raw.length }
}

/** 创建 provider 实例。注册与生命周期由调用方（index.ts）负责。 */
export function createWorkBuddySearchProvider(deps: WorkBuddySearchDeps): WebSearchProviderLike {
  return {
    id: WORKBUDDY_SEARCH_PROVIDER_ID,
    title: WORKBUDDY_SEARCH_PROVIDER_TITLE,
    description: 'Search through the WorkBuddy account signed in to this plugin (CN or international). Fast structured snippets by default; enable synthesis in the plugin config for a slower, cited answer.',
    available(): boolean {
      // 注册无条件可用：与宿主 dsh-tool-web 的「稳定注册」一致。未登录时由
      // search() 给出结构化错误，让用户在设置页看到原因，而不是让工具消失。
      return true
    },
    async search(request, signal): Promise<WebSearchResultLike> {
      const query = request.query.trim()
      if (query === '') throw new WorkBuddyWebSearchError('query must not be empty', 'WB_SEARCH_BAD_QUERY')
      const agentic = deps.agentic?.() === true
      const maxChars = deps.maxContentChars?.() ?? DEFAULT_MAX_CONTENT_CHARS
      return await withFreshCredential(deps, request.llmProvider, signal, async ctx =>
        agentic
          ? await callAgentic(ctx, query, signal, maxChars)
          : await callSnippet(ctx, query, request.maxResults, signal),
      )
    },
  }
}
