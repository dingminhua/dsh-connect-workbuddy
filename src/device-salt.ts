/**
 * 本机设备盐：一次生成、永久复用、**绝不悄悄换新**。
 *
 * ## 为什么需要一个盐，而不是直接把 uid 哈希掉
 *
 * `sha256(uid)` 是全局确定的：任何装了同款工具的人，对同一个账号都会算出同一个
 * 设备 id，于是全体用户在上游眼里就是一个可识别族群，而"换一台机器"根本不会
 * 改变这个值——它既不隔离也不真实。加一个本机随机盐之后：
 *
 *   - 同一个账号在本机恒同值（重启、升级、插件重装都不变）；
 *   - 换一台机器 → 换一个盐 → 换一个 id（与真实设备的行为一致）；
 *   - 两台机器上同一个账号 → 两个不同 id（这才是"设备"该有的语义）。
 *
 * ## 唯一真正的风险：盐被换掉
 *
 * 换了盐等于换了设备，而 device hopping 正是风控最想抓的信号。因此：
 *
 *   - **只有文件不存在时才写**。文件存在但读不懂（坏 JSON、未知 version、
 *     长度不对）一律判为 `unreadable` 并**停止使用**，绝不"读不懂就重新生成"。
 *   - 写失败不重试、不降级为内存随机值：一个不落盘的盐每次进程启动都不同，
 *     比没有盐更糟。返回 `unwritable`，让调用方选择"不发设备头"。
 *
 * ## 存在哪里
 *
 * `$DSH_HOME/.workbuddy-device.json`，与 `roster-seen` 同一层。**不放在插件安装
 * 目录**：npm 重装/升级会换掉那个目录，盐跟着没了，设备也就跟着变了。
 *
 * @module dsh-connect-workbuddy/device-salt
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeviceSalt } from './device-id.ts'
import { resolveDshHome, withFileLock, writeFileAtomic } from './host-peers.ts'

/** 本 build 能读的盐文件版本。读到别的版本一律判不可读（见模块注释）。 */
export const DEVICE_SALT_VERSION = 1

/** 文件名，带前导点，与 `.workbuddy-roster-seen.*.json` 同一约定。 */
export const DEVICE_SALT_FILE_NAME = '.workbuddy-device.json'

/**
 * 盐的四种状态。
 *
 * `absent` 与 `unreadable` 必须分开：前者是"还没生成"（可以写），后者是
 * "有一个我们读不懂的文件"（**不可以**写）。合并成一个 `missing` 会让第二种
 * 情况静默地重新生成盐，也就是静默地换设备。
 */
export type DeviceSaltState = 'ok' | 'absent' | 'unreadable' | 'unwritable'

/**
 * What one read (or one ensure) of the salt file established.
 *
 * A discriminated union rather than one interface with optional fields: the only
 * shape that carries a `salt` is `ok`, so a caller cannot read a half-valid
 * readout without narrowing it first. With `exactOptionalPropertyTypes` the
 * flatter shape also forced `as string` casts at every use site.
 */
export type DeviceSaltReadout =
  | { path: string, state: 'ok', salt: string }
  | { path: string, state: 'absent' }
  | { path: string, state: 'unreadable' | 'unwritable', reason: string }

/** `$DSH_HOME/.workbuddy-device.json`, or `dir` when one is pinned (tests). */
export function deviceSaltPath(dir?: string): string {
  const base = typeof dir === 'string' && dir !== '' ? dir : resolveDshHome()
  return join(base, DEVICE_SALT_FILE_NAME)
}

/** One parsed payload, or the reason it cannot be used. */
type ParsedSalts = { salt: string } | { reason: string }

/**
 * Read one parsed salt document.
 *
 * `undefined` means the file is not there at all — the ONLY state that permits
 * writing a new one. Everything else that is wrong with the file lands in
 * `reason`, because "we cannot read our own salt" must stay distinguishable from
 * "there is no salt yet".
 */
function parseDeviceSaltPayload(raw: unknown): ParsedSalts {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { reason: 'not a JSON object' }
  const document = raw as Record<string, unknown>
  const version = document['version']
  if (version !== DEVICE_SALT_VERSION) {
    return { reason: `version ${typeof version === 'number' ? version : '(absent)'} is not readable by this build` }
  }
  const salt = document['salt']
  if (typeof salt !== 'string' || !isDeviceSalt(salt)) {
    return { reason: 'salt field is not 64 lowercase hex characters' }
  }
  return { salt }
}

/**
 * Read the salt WITHOUT writing anything.
 *
 * A missing file is `absent`; an unreadable one is `unreadable` (never
 * `absent`) — see the module note on why that distinction is load-bearing.
 */
export async function readDeviceSalt(options: { dir?: string } = {}): Promise<DeviceSaltReadout> {
  const path = deviceSaltPath(options.dir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return { path, state: 'absent' }
    return { path, state: 'unreadable', reason: code === undefined ? String(error) : code }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return { path, state: 'unreadable', reason: 'file is not valid JSON' }
  }
  const parsed = parseDeviceSaltPayload(raw)
  if ('reason' in parsed) return { path, state: 'unreadable', reason: parsed.reason }
  return { path, state: 'ok', salt: parsed.salt }
}

/**
 * Read the salt, creating it on the first call that needs one.
 *
 * The read happens twice — once unlocked (the common case costs one `readFile`),
 * once inside the lock before writing — because two processes starting together
 * would otherwise both find the file missing and both write a different salt;
 * the loser's salt would then never be used again and its ids would silently
 * change. Writing asks for `mode: 0o600` under a `0o700` directory: the value is
 * not a credential, but it IS what makes this machine's derived ids unguessable.
 * On Windows those bits are a no-op and the DACL decides — this file lives in
 * `$DSH_HOME`, whose permissions `doctor` already hardens for the vault
 * (`credentialAcl` in `src/bin.ts`).
 */
export async function ensureDeviceSalt(options: { dir?: string } = {}): Promise<DeviceSaltReadout> {
  const first = await readDeviceSalt(options)
  if (first.state !== 'absent') return first
  const path = first.path
  try {
    return await withFileLock<DeviceSaltReadout>(path, async () => {
      const again = await readDeviceSalt(options)
      if (again.state !== 'absent') return again
      const salt = randomBytes(32).toString('hex')
      await writeFileAtomic(path, `${JSON.stringify({
        version: DEVICE_SALT_VERSION,
        salt,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
      return { path, state: 'ok', salt }
    })
  } catch (error: unknown) {
    // A salt that is not on disk is not a salt: falling back to an in-memory
    // random value would mint a NEW device on every process start.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return { path, state: 'unwritable', reason: code === undefined ? String(error) : code }
  }
}
