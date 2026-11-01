/**
 * 外部 `X-Device-Token` 的文件源（审计报告 §6 的 P2）。
 *
 * ## 为什么只有文件，没有"内联配置值"
 *
 * token 的有效期是分钟级（A 实测 10 分钟，旧值最多 24 小时可复用）。写在配置里
 * 的值是死的：十分钟后它过期，只能靠人去改配置——那是一条每十分钟需要人工介入的
 * 路径，实际上只在一次性排障里成立。文件可以由任何东西刷新（A 自己的
 * `.turing_token_cache.json`、一个 cron、一个脚本），插件按 TTL 重读即可。
 *
 * ## 它与 B 的 `device_token.go` 差在哪（三处，都是刻意的）
 *
 *   1. **上限 4 KB，不是 1 KB**。A 现取的 token 实测 **1210 字符**（`v3:` 前缀、
 *      单段不透明 blob），B 的 1024 字节上限会把它判成"过长"→ 返回空 →
 *      **静默不注入**。token 明明有，网关那边却当作没有。
 *   2. **JSON 信封与裸值都吃**。A 写的是 `{"token":"v3:…","ts":…}`，B 只认
 *      裸值——直接把 B 指到 A 的缓存上，注入的会是整段 JSON。
 *   3. **失败会记一条 warn**。B 是完全静默的，"配了但没生效"因此无法从任何地方
 *      看出来。这里只在**状态发生变化**时告警一次，避免每条请求刷一行。
 *
 * ## 安全
 *
 * token 是设备身份，不是访问凭据，但它同样不该进日志：本模块的任何输出
 * （包括错误、warn、doctor）都只带**路径、状态、时长**，绝不含 token 字节。
 *
 * @module dsh-connect-workbuddy/device-token
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 文件大小上限，单位字节。
 *
 * 4 KB 不是随手放的：A 的真实 token 是 1210 字符，B 的 1 KB 上限会误杀它；同时
 * 4 KB 仍然远小于"贴错文件"的量级（把整个 auth.json 指过来会立刻被判过长）。
 */
export const DEVICE_TOKEN_MAX_BYTES = 4096

/** 默认重读周期。与 A 的磁盘缓存一致（10 分钟 token / 5 分钟重读）。 */
export const DEVICE_TOKEN_DEFAULT_TTL_MS = 5 * 60 * 1000

/**
 * 设备 token 文件路径的环境变量。
 *
 * **它不是第二个真源**，而是同一个值的第二种写法：插件配置 `deviceToken.file`
 * 为空时才回落到它，而 `doctor` 只能看到环境变量（它读不到插件配置）。同一个
 * 值、两个读者，因此不会出现"插件在用 A、CLI 报告 B"。
 */
export const WORKBUDDY_DEVICE_TOKEN_FILE_ENV = 'WORKBUDDY_DEVICE_TOKEN_FILE'

/**
 * 四种状态。
 *
 * `absent`（没配/文件不在）与 `unreadable`（配了但读不出来）必须分开：前者是
 * 正常状态，后者是"用户以为自己在用 token，其实没有"。
 */
export type DeviceTokenState = 'ok' | 'absent' | 'unreadable' | 'too-large'

/** What one read of the token file established. */
export interface DeviceTokenReadout {
  path: string
  state: DeviceTokenState
  /** Present only when `state === 'ok'`. NEVER log this. */
  token?: string
  /** File mtime age, only when `state === 'ok'` — the only freshness signal we have. */
  ageMs?: number
  /** Why it is not usable, in structural terms only — never file content. */
  reason?: string
}

/**
 * Expand a configured path.
 *
 * `~` is supported because that is how the one interesting path (`A` 的
 * `.turing_token_cache.json`) is naturally written; everything else resolves
 * against the process cwd, which is why the docs ask for an absolute path.
 */
export function resolveDeviceTokenPath(file: string): string {
  const trimmed = file.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

/**
 * Parse the file body: either a bare token or A's `{token, ts}` envelope.
 *
 * The envelope is not a nicety — pointing this reader at A's cache file is the
 * whole reason a user of both tools gets a working token with no extra script.
 */
function parseDeviceTokenDocument(text: string): { token: string } | { reason: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { reason: 'file is empty' }
  if (trimmed.startsWith('{')) {
    let document: unknown
    try {
      document = JSON.parse(trimmed) as unknown
    } catch {
      return { reason: 'file starts with { but is not valid JSON' }
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      return { reason: 'JSON document is not an object' }
    }
    const token = (document as Record<string, unknown>)['token']
    if (typeof token !== 'string' || token.trim() === '') return { reason: 'JSON envelope has no non-empty token field' }
    return { token: token.trim() }
  }
  // 裸值必须是单行：一个带了换行的"token"多半是贴错了文件。
  if (/\s/u.test(trimmed)) return { reason: 'raw token must be a single line without whitespace' }
  return { token: trimmed }
}

/** Read the token file once. No caching — see {@link createDeviceTokenReader}. */
export async function readDeviceTokenFile(file: string, nowMs: number = Date.now()): Promise<DeviceTokenReadout> {
  const path = resolveDeviceTokenPath(file)
  let size: number
  let modifiedMs: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return { path, state: 'unreadable', reason: 'path is not a regular file' }
    size = info.size
    modifiedMs = info.mtimeMs
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return { path, state: 'absent' }
    return { path, state: 'unreadable', reason: code === undefined ? String(error) : code }
  }
  if (size > DEVICE_TOKEN_MAX_BYTES) {
    return { path, state: 'too-large', reason: `${size} bytes exceeds the ${DEVICE_TOKEN_MAX_BYTES}-byte limit` }
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return { path, state: 'unreadable', reason: code === undefined ? String(error) : code }
  }
  const parsed = parseDeviceTokenDocument(text)
  if ('reason' in parsed) return { path, state: 'unreadable', reason: parsed.reason }
  return { path, state: 'ok', token: parsed.token, ageMs: Math.max(0, nowMs - modifiedMs) }
}

/** A TTL-cached view of one token file. */
export interface DeviceTokenReader {
  /**
   * The token to attach right now, or undefined.
   *
   * Re-reads at most once per `ttlMs`: the token expires in minutes while the
   * plugin process lives for hours, so reading it once at construction (as the
   * device salt is read) would pin an expired value for the whole session.
   */
  current(nowMs?: number): Promise<string | undefined>
  /** The last read, for diagnostics. Never contains anything but the token itself. */
  last(): DeviceTokenReadout | undefined
}

/**
 * Build the reader.
 *
 * `warn` fires **only when the state changes** — a missing file would otherwise
 * write one line per request, which is the noise that trains people to ignore
 * logs. Recovery resets the memory, so a later break is reported again.
 */
export function createDeviceTokenReader(options: {
  file: string
  ttlMs?: number
  warn?: (message: string) => void
}): DeviceTokenReader {
  const ttlMs = options.ttlMs !== undefined && Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEVICE_TOKEN_DEFAULT_TTL_MS
  let cached: { at: number, readout: DeviceTokenReadout } | undefined
  let lastBadState: DeviceTokenState | undefined

  return {
    async current(nowMs: number = Date.now()): Promise<string | undefined> {
      if (cached !== undefined && nowMs - cached.at < ttlMs) return cached.readout.token
      const readout = await readDeviceTokenFile(options.file, nowMs)
      cached = { at: nowMs, readout }
      if (readout.state === 'ok') {
        lastBadState = undefined
        return readout.token
      }
      if (readout.state !== lastBadState) {
        lastBadState = readout.state
        options.warn?.(
          `device token file is ${readout.state}${readout.reason === undefined ? '' : ` (${readout.reason})`}; `
          + `X-Device-Token will not be sent. Path: ${readout.path}`,
        )
      }
      return undefined
    },
    last(): DeviceTokenReadout | undefined {
      return cached?.readout
    },
  }
}
