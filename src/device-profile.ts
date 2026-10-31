/**
 * 每账号的"虚拟设备"参数（设置里的「虚拟值」档）。
 *
 * ## 它解决什么
 *
 * P1 的设备对（`X-Machine-ID` / `X-Session-ID`）是从 `sha256(命名空间 + 本机盐 +
 * 用途 + uid)` 算出来的：稳定、按号隔离，但**不可调**。用户往往需要手上一台
 * "指定"的设备——排查某个账号为什么被判异常时，第一件事就是把它的设备标识换成
 * 一个已知值；或者反过来，怀疑两个账号被关联时，把其中一个改成明显不同的值。
 * 这个文件就是那些"指定值"的落点。
 *
 * ## 与盐的关系
 *
 * 盐是**派生输入**，这里是**覆盖结果**。两者不冲突：某个账号没有覆盖时照常派生，
 * 有覆盖时逐字段用覆盖值（只改 machine、session 仍派生是完全合法的操作）。
 * 盐不因为这里的存在而改变——覆盖只影响发出去的头。
 *
 * ## 「真实值（P3）」在这里只是被记住
 *
 * `mode` 会落盘、会被读出来、会决定界面上齿轮是否可用，但**不改变任何出站字节**：
 * 真 token 的取法与档位互斥规则都在 P3。写在这里而不是留一个前端 state，是因为
 * 一个只在浏览器内存里的切档，刷新一次就回到默认值——那不叫预留入口，那叫没做。
 *
 * @module dsh-connect-workbuddy/device-profile
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeviceId } from './device-id.ts'
import { resolveDshHome, withFileLock, writeFileAtomic } from './host-peers.ts'

/** 设备头档位。「真实值」目前只是占位，不改变出站字节（P3）。 */
export type WorkBuddyDeviceMode = 'virtual' | 'real'

/** 本 build 能读的文件版本；读到别的版本按"没有设置"处理。 */
export const DEVICE_PROFILE_VERSION = 1

/** 文件名，带前导点，与 `.workbuddy-device.json` 同一约定。 */
export const DEVICE_PROFILE_FILE_NAME = '.workbuddy-device-profiles.json'

/** 一个账号的覆盖值；空字段表示"这一项仍然派生"。 */
export interface WorkBuddyDeviceProfile {
  machineId?: string
  sessionId?: string
}

/** What the card and the resolver both read. */
export interface WorkBuddyDeviceSettings {
  mode: WorkBuddyDeviceMode
  /** accountId（sha256 前 24 位）→ 覆盖值。**不含 uid**：这份文档会发给浏览器。 */
  accounts: Readonly<Record<string, WorkBuddyDeviceProfile>>
}

/** 文件不存在、不可读、版本不认识时的答案：虚拟档、无覆盖。 */
function emptyDocument(): StoredDocument {
  return { version: DEVICE_PROFILE_VERSION, mode: 'virtual', accounts: {} }
}

/** 落盘形状。`uid` 只在磁盘上存在，用于把浏览器发来的 accountId 映射回请求。 */
interface StoredAccount {
  uid?: string
  machineId?: string
  sessionId?: string
  updatedAt?: string
}

interface StoredDocument {
  version: number
  mode: WorkBuddyDeviceMode
  accounts: Record<string, StoredAccount>
}

/**
 * 读盘缓存：同一进程内的请求路径不该每条都去读 200 字节。
 *
 * **按路径索引**，不是一个全局槽：这个模块同时服务"真实 DSH home"与测试里
 * 那些临时目录，一个全局槽会让第二台机器（或第二个测试）读到第一份内容。
 */
const CACHE_MS = 5_000
const cache = new Map<string, { at: number, document: StoredDocument }>()

/** Drop the cache — every write calls this, so a save is visible immediately. */
function invalidate(): void {
  cache.clear()
}

/** `$DSH_HOME/.workbuddy-device-profiles.json`, or `dir` when one is pinned (tests). */
export function deviceProfilePath(dir?: string): string {
  const base = typeof dir === 'string' && dir !== '' ? dir : resolveDshHome()
  return join(base, DEVICE_PROFILE_FILE_NAME)
}

/** Whether an unknown value is a mode this build understands. */
export function isDeviceMode(value: unknown): value is WorkBuddyDeviceMode {
  return value === 'virtual' || value === 'real'
}

/** Keep only the fields that are well-formed; a hand-edited file must not break a request. */
function sanitizeAccount(raw: unknown): StoredAccount | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const account: StoredAccount = {}
  if (typeof record['uid'] === 'string' && record['uid'] !== '') account.uid = record['uid']
  if (typeof record['machineId'] === 'string' && isDeviceId(record['machineId'])) account.machineId = record['machineId']
  if (typeof record['sessionId'] === 'string' && isDeviceId(record['sessionId'])) account.sessionId = record['sessionId']
  if (typeof record['updatedAt'] === 'string') account.updatedAt = record['updatedAt']
  return account.uid === undefined && account.machineId === undefined && account.sessionId === undefined ? undefined : account
}

/** Read the on-disk document, tolerating anything a hand edit can produce. */
async function readStored(dir?: string, nowMs: number = Date.now(), fresh = false): Promise<StoredDocument> {
  const path = deviceProfilePath(dir)
  const hit = cache.get(path)
  if (!fresh && hit !== undefined && nowMs - hit.at < CACHE_MS) return hit.document
  const remember = (document: StoredDocument): StoredDocument => {
    cache.set(path, { at: nowMs, document })
    return document
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return remember(emptyDocument())
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    // 坏文件按"没有设置"处理（不是"重新生成"）：覆盖值是用户手填的，丢了就是丢了，
    // 但设备身份不会因此改变——没有覆盖时一切照旧派生。
    return remember(emptyDocument())
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  if (record['version'] !== DEVICE_PROFILE_VERSION) return remember(emptyDocument())
  const accounts: Record<string, StoredAccount> = {}
  const rawAccounts = record['accounts']
  if (typeof rawAccounts === 'object' && rawAccounts !== null && !Array.isArray(rawAccounts)) {
    for (const [id, value] of Object.entries(rawAccounts as Record<string, unknown>)) {
      const account = sanitizeAccount(value)
      if (account !== undefined) accounts[id] = account
    }
  }
  const document: StoredDocument = {
    version: DEVICE_PROFILE_VERSION,
    mode: isDeviceMode(record['mode']) ? record['mode'] : 'virtual',
    accounts,
  }
  return remember(document)
}

/** The browser-facing shape: no uids, no timestamps it cannot use. */
function toSettings(document: StoredDocument): WorkBuddyDeviceSettings {
  const accounts: Record<string, WorkBuddyDeviceProfile> = {}
  for (const [id, account] of Object.entries(document.accounts)) {
    const profile: WorkBuddyDeviceProfile = {
      ...account.machineId === undefined ? {} : { machineId: account.machineId },
      ...account.sessionId === undefined ? {} : { sessionId: account.sessionId },
    }
    if (profile.machineId !== undefined || profile.sessionId !== undefined) accounts[id] = profile
  }
  return { mode: document.mode, accounts }
}

/** Read the settings the card renders. Never throws. */
export async function readDeviceSettings(options: { dir?: string } = {}): Promise<WorkBuddyDeviceSettings> {
  return toSettings(await readStored(options.dir))
}

/**
 * Persist one document atomically.
 *
 * **The caller holds the lock.** Every write path takes `withFileLock` itself
 * (read-merge-write must be one step against another process), so this function
 * must not take it again — a second acquisition on the same path is how a save
 * turns into a hang.
 */
async function writeStored(document: StoredDocument, dir?: string): Promise<void> {
  await writeFileAtomic(deviceProfilePath(dir), `${JSON.stringify(document, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  })
  invalidate()
}

/**
 * Switch the device-head tier.
 *
 * 「真实值」目前只被记住，不改任何出站字节——P3 才接真 token 与互斥规则。
 * 界面上必须把这件事说清楚（`row.deviceModeRealNote`），否则用户会以为切过去
 * 就换成了真实设备。
 */
export async function setDeviceMode(
  mode: WorkBuddyDeviceMode,
  options: { dir?: string } = {},
): Promise<WorkBuddyDeviceSettings> {
  return withFileLock(deviceProfilePath(options.dir), async () => {
    // `fresh`: 锁内必须读盘，不能用 5 秒缓存——另一个进程刚写过的值会被这条
    // 缓存盖掉，而 read-merge-write 一旦基于旧文档就会把对方的改动抹平。
    const document = await readStored(options.dir, Date.now(), true)
    const next: StoredDocument = { ...document, mode }
    await writeStored(next, options.dir)
    return toSettings(next)
  })
}

/**
 * Save (or clear) one account's overrides.
 *
 * `machineId` / `sessionId` 为 `''` 表示"清掉这一项、回到派生值"；为 `undefined`
 * 表示"不要动这一项"。两种省略必须能分开：弹窗里只改机器 id 时，不能把用户之前
 * 设的 session id 顺手抹掉。
 *
 * @throws when a supplied value is not a 36-character lowercase hex id — the
 *   route turns that into a 400 rather than writing a value the upstream will reject.
 */
export async function saveDeviceProfile(
  accountId: string,
  values: { uid?: string, machineId?: string, sessionId?: string },
  options: { dir?: string } = {},
): Promise<WorkBuddyDeviceSettings> {
  for (const value of [values.machineId, values.sessionId]) {
    if (value !== undefined && value !== '' && !isDeviceId(value)) {
      throw new Error('device id must be 36 lowercase hex characters')
    }
  }
  return withFileLock(deviceProfilePath(options.dir), async () => {
    const document = await readStored(options.dir, Date.now(), true)
    const previous = document.accounts[accountId] ?? {}
    const next: StoredAccount = { ...previous }
    if (values.uid !== undefined && values.uid !== '') next.uid = values.uid
    for (const key of ['machineId', 'sessionId'] as const) {
      const value = values[key]
      if (value === undefined) continue
      if (value === '') delete next[key]
      else next[key] = value
    }
    next.updatedAt = new Date().toISOString()
    const accounts = { ...document.accounts, [accountId]: next }
    // 一个覆盖值都没剩下就整条删掉，别在文件里留空壳。
    if (next.machineId === undefined && next.sessionId === undefined) delete accounts[accountId]
    const merged: StoredDocument = { ...document, accounts }
    await writeStored(merged, options.dir)
    return toSettings(merged)
  })
}

/**
 * Host 侧给卡片路由用的接口。
 *
 * `saveAccount` 只要 accountId：uid 由 Host 自己从凭据库解出来——**浏览器端永远
 * 不该把 uid 传上来**，那是账号在网关侧的身份，不是它需要知道的东西。
 */
export interface WorkBuddyDeviceSettingsPort {
  read(): Promise<WorkBuddyDeviceSettings>
  setMode(mode: WorkBuddyDeviceMode): Promise<WorkBuddyDeviceSettings>
  saveAccount(
    accountId: string,
    values: { machineId?: string, sessionId?: string },
  ): Promise<WorkBuddyDeviceSettings>
}

/**
 * The request-path view: uid → overrides.
 *
 * 按 uid 索引而不是 accountId，是因为构头时手上只有 credential（`uid` 就在里面，
 * 而 accountId 要算哈希；`upstream.ts` 也不能反向 import `auth.ts` 的取值函数，
 * 那会成环）。文件里同时存 uid，正是为了让这一步不需要再查一次凭据库。
 */
export interface WorkBuddyDeviceProfileLookup {
  forUid(uid: string): Promise<WorkBuddyDeviceProfile | undefined>
  /**
   * 当前档位。真实值档下 `forUid` 的结果会被忽略（所有账号共用这台机器的真实
   * 设备），但仍然要能读出来——构头时必须先知道自己在哪一档。
   */
  mode(): Promise<WorkBuddyDeviceMode>
}

/** Build the lookup; `ttlMs` exists so an externally edited file is still picked up. */
export function createDeviceProfileLookup(options: { dir?: string } = {}): WorkBuddyDeviceProfileLookup {
  const byUid = (document: StoredDocument): Map<string, WorkBuddyDeviceProfile> => {
    const map = new Map<string, WorkBuddyDeviceProfile>()
    for (const account of Object.values(document.accounts)) {
      if (account.uid === undefined) continue
      const profile: WorkBuddyDeviceProfile = {
        ...account.machineId === undefined ? {} : { machineId: account.machineId },
        ...account.sessionId === undefined ? {} : { sessionId: account.sessionId },
      }
      if (profile.machineId !== undefined || profile.sessionId !== undefined) map.set(account.uid, profile)
    }
    return map
  }
  return {
    async forUid(uid: string): Promise<WorkBuddyDeviceProfile | undefined> {
      if (uid === '') return undefined
      return byUid(await readStored(options.dir)).get(uid)
    },
    async mode(): Promise<WorkBuddyDeviceMode> {
      return (await readStored(options.dir)).mode
    },
  }
}
