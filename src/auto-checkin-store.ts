/**
 * On-disk memory for the automatic check-in.
 *
 * 参考：本仓库 `src/account-pool-store.ts`（`$DSH_HOME` 下
 *   `.workbuddy-pool.<region>.json`，`withFileLock` + `writeFileAtomic`，
 *   `mode: 0o600`）。本模块沿用同一套写入方式与同一份隐私标准。
 * 改动：存的是**今天签到到哪一步**，因此文件里不含任何 token，也不含账号名
 *   ——只有账号 id 与一句失败原因。
 *
 * ## 为什么单独落盘，而不是塞进 settings
 *
 * 卡片对用户偏好用的是「草稿 → 保存 → 丢弃草稿」模式。签到进度是插件自己高频
 * 写的运行状态，不是用户偏好；把它塞进 `regions[region].pool` 会让用户手点一次
 * 「保存」用几分钟前的草稿把它覆盖回去。这与 `account-pool-store.ts` 当初把
 * 探测结果搬出 settings 是同一个理由。
 *
 * ## 读写从不抛异常
 *
 * 自动签到是增强功能。一个损坏的进度文件绝不能让插件启动失败或让卡片渲染不出来
 * ——最坏情况是「今天当作没签过」，而那次重跑是幂等的（先读状态、已签判 already）。
 *
 * @module dsh-connect-workbuddy/auto-checkin-store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
// Host-first with a local fallback; see `src/host-peers.ts` and issue #47.
import { resolveDshHome, withFileLock, writeFileAtomic } from './host-peers.ts'
import type { AutoCheckinState } from './auto-checkin.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** On-disk format version; readers reject anything else. */
const STORE_FORMAT_VERSION = 1

/** Filename prefix for one region's auto-check-in memory. */
const AUTO_CHECKIN_PREFIX = '.workbuddy-auto-checkin'

/** The document actually written to disk. */
interface AutoCheckinDocument {
  version: typeof STORE_FORMAT_VERSION
  /** Region → its state for {@link AutoCheckinState.day}. */
  regions: Record<string, AutoCheckinState>
}

/** Whether a parsed value looks like a stored state. */
function isState(value: unknown): value is AutoCheckinState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['day'] === 'string'
    && Array.isArray(candidate['doneAccountIds'])
    && candidate['doneAccountIds'].every(id => typeof id === 'string')
    && typeof candidate['failures'] === 'number'
    && Number.isFinite(candidate['failures'])
    && (candidate['lastAttemptAtMs'] === undefined || typeof candidate['lastAttemptAtMs'] === 'number')
    && (candidate['lastError'] === undefined || typeof candidate['lastError'] === 'string')
}

/** One region's path for auto-check-in memory. */
export function autoCheckinStorePath(region: WorkBuddyRegion): string {
  return join(resolveDshHome(), `${AUTO_CHECKIN_PREFIX}.${region}.json`)
}

/**
 * Read every region's stored state.
 *
 * Returns `{}` for a missing, unreadable, corrupt, or wrong-version file — see
 * the module note. A region absent from the result simply has no memory, which
 * reads as "nothing done today".
 */
export async function readAutoCheckinState(
  region: WorkBuddyRegion,
): Promise<AutoCheckinState | undefined> {
  let raw: string
  try {
    raw = await readFile(autoCheckinStorePath(region), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const document = parsed as Partial<AutoCheckinDocument>
  if (document.version !== STORE_FORMAT_VERSION) return undefined
  const regions = document.regions
  if (typeof regions !== 'object' || regions === null) return undefined
  const state = (regions as Record<string, unknown>)[region]
  return isState(state) ? state : undefined
}

/**
 * Write one region's state, merging into whatever the file already holds.
 *
 * A MERGE rather than a replace for the same reason `writePoolProbes` merges:
 * the two regions run independently, and a write from one must not erase the
 * other's memory. Never throws — see the module note.
 */
export async function writeAutoCheckinState(
  region: WorkBuddyRegion,
  state: AutoCheckinState,
): Promise<void> {
  const path = autoCheckinStorePath(region)
  try {
    await withFileLock(path, async () => {
      const existing = await readDocument(path)
      const regions: Record<string, AutoCheckinState> = { ...existing, [region]: state }
      const document: AutoCheckinDocument = { version: STORE_FORMAT_VERSION, regions }
      await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  } catch {
    // Deliberately swallowed; see the module note. The runner degrades to
    // "resume from an older memory", never to a failed plugin start.
  }
}

/** Read the whole document, for the merge above. */
async function readDocument(path: string): Promise<Record<string, AutoCheckinState>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const document = parsed as Partial<AutoCheckinDocument>
  if (document.version !== STORE_FORMAT_VERSION) return {}
  const regions = document.regions
  if (typeof regions !== 'object' || regions === null) return {}
  // Only well-formed entries survive, so one corrupt region cannot make the
  // merge write garbage back for another.
  const clean: Record<string, AutoCheckinState> = {}
  for (const [key, value] of Object.entries(regions as Record<string, unknown>)) {
    if (isState(value)) clean[key] = value
  }
  return clean
}
