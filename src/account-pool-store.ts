/**
 * The account pool's RUNTIME store: measured facts, on disk, outside settings.
 *
 * 参考：本仓库 `src/auth.ts` 的插件自有文件约定（`$DSH_HOME` 下的
 *   `.workbuddy-auth.<region>.json`，`withFileLock` + `writeFileAtomic`，
 *   `mode: 0o600`）。本模块沿用同一套写入方式与同一份隐私标准。
 * 改动：存的是**观测结果**而非凭据 —— 因此文件里不含任何 token，
 *   并且它与用户设置**分开落盘**，原因见下。
 *
 * 为什么这些事实不放 settings（`regions[region].pool`）：
 *
 *   卡片对用户偏好用的是「草稿 → 保存 → 丢弃草稿」模式：保存成功会丢弃草稿。
 *   如果探测结果也住在那个槽里，用户手工点一次「保存」就会用**几分钟前的草稿**
 *   覆盖掉定时器刚写进去的结果 —— 那等于把测量结果回退，测试白做。
 *   观测数据由插件高频写入、且不是用户偏好，所以它必须落在自己的文件里。
 *
 * 本模块的读写**从不抛异常给调用方**：池是增强功能，一个损坏的观测文件绝不能让
 * 卡片或 host 启动失败 —— 最坏情况是「回到未测试」，而不是整个插件不可用。
 *
 * @module dsh-connect-workbuddy/account-pool-store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyPoolProbe, WorkBuddyPoolProbeSource } from './account-pool.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** On-disk format version; readers reject anything else. */
const STORE_FORMAT_VERSION = 1

/** Filename prefix for one region's measured pool facts. */
const POOL_STORE_PREFIX = '.workbuddy-pool'

/** The document actually written to disk. */
interface PoolDocument {
  version: typeof STORE_FORMAT_VERSION
  /** Account id → its most recent measurement of the region's target model. */
  probes: Record<string, WorkBuddyPoolProbe>
}

/** Whether a parsed value looks like a stored probe. */
function isProbe(value: unknown): value is WorkBuddyPoolProbe {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['outcome'] === 'string'
    && typeof candidate['atMs'] === 'number'
    && (candidate['retryAtMs'] === undefined || typeof candidate['retryAtMs'] === 'number')
    && (candidate['message'] === undefined || typeof candidate['message'] === 'string')
    // A source this build does not recognise is DROPPED, not rejected: refusing
    // the whole record would silently discard a real measurement written by a
    // newer build, whereas dropping only the label leaves the measurement
    // intact and reads as its documented "unknown".
    && (candidate['source'] === undefined || typeof candidate['source'] === 'string')
}

/**
 * One region's path for measured pool facts.
 *
 * Region-keyed for the same reason the credential copies are: the two regions
 * are parallel stacks and must never overwrite each other's measurements.
 */
export function workbuddyPoolStorePath(region: WorkBuddyRegion): string {
  return join(resolveDshHome(), `${POOL_STORE_PREFIX}.${region}.json`)
}

/**
 * Read one region's measured facts.
 *
 * Contains NO credentials. The one free-text field is `message`, and it is
 * REDACTED BY THE WRITER before it ever reaches this file (`probe.ts`'s
 * `redactUpstreamText`), so a token-shaped string cannot survive into storage.
 * Because of that the file is not written with the credential store's stricter
 * secrecy requirements, though it still uses the same atomic-write helpers.
 *
 * Returns an empty map for a missing, unreadable, malformed, or
 * version-mismatched file: all four mean "nothing measured yet", which is a
 * valid state the pool renders as "untested".
 */
export async function readPoolProbes(
  region: WorkBuddyRegion,
): Promise<Record<string, WorkBuddyPoolProbe>> {
  let raw: string
  try {
    raw = await readFile(workbuddyPoolStorePath(region), 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const document = parsed as Partial<PoolDocument>
  if (document.version !== STORE_FORMAT_VERSION) return {}
  if (typeof document.probes !== 'object' || document.probes === null) return {}
  const probes: Record<string, WorkBuddyPoolProbe> = {}
  for (const [accountId, probe] of Object.entries(document.probes)) {
    if (accountId === '' || !isProbe(probe)) continue
    probes[accountId] = {
      outcome: probe.outcome,
      atMs: probe.atMs,
      ...knownProbeSource(probe.source) === undefined ? {} : { source: knownProbeSource(probe.source)! },
      ...probe.retryAtMs === undefined ? {} : { retryAtMs: probe.retryAtMs },
      ...probe.message === undefined ? {} : { message: probe.message },
    }
  }
  return probes
}

/**
 * A stored source string reduced to a source this build understands.
 *
 * `isProbe` accepts any string so a newer build's label cannot destroy the
 * measurement it describes; this narrows it at the point of use. An unknown
 * value becomes `undefined`, which the card renders as "unknown" — the honest
 * answer, rather than mislabelling it as one of the two kinds we do know.
 */
function knownProbeSource(value: unknown): WorkBuddyPoolProbeSource | undefined {
  return value === 'test-batch' || value === 'live-request' ? value : undefined
}

/**
 * Merge measurements into one region's store and write it atomically.
 *
 * A MERGE rather than a replace, because batches measure one account at a time
 * and a partial failure must not erase what earlier runs learned. An account
 * absent from `updates` keeps its previous measurement.
 *
 * Never throws: a failed write loses only the newest measurements, and the
 * caller's results are still returned to the user. Surfacing a disk error here
 * would fail an operation that actually succeeded.
 */
export async function writePoolProbes(
  region: WorkBuddyRegion,
  updates: Readonly<Record<string, WorkBuddyPoolProbe>>,
): Promise<void> {
  if (Object.keys(updates).length === 0) return
  const path = workbuddyPoolStorePath(region)
  try {
    await withFileLock(path, async () => {
      const existing = await readPoolProbes(region)
      const document: PoolDocument = {
        version: STORE_FORMAT_VERSION,
        probes: { ...existing, ...updates },
      }
      await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  } catch {
    // Deliberately swallowed; see the function note. The pool degrades to
    // "measured a moment ago, but not remembered", never to a failed action.
  }
}
