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
// Host-first with a local fallback; see `src/host-peers.ts` and issue #47.
import { resolveDshHome, withFileLock, writeFileAtomic } from './host-peers.ts'
import { parseUpstreamResetAt } from './probe.ts'
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
    // The display name a measurement observed (issue #60). Accepted only as a
    // string: it is the one field here that reaches the card as a LABEL, so a
    // non-string (a number id, an object) must not survive into the UI as
    // `[object Object]`.
    && (candidate['accountName'] === undefined || typeof candidate['accountName'] === 'string')
    // WHICH MODEL the measurement was taken on (issue #61). Validated as a
    // string for the same reason as `accountName`: it reaches the card as a
    // label, so a non-string must not survive into the UI. Its READ-BACK was
    // missing, which turned every subsequent write into an erasure — see the
    // note at the field in `readPoolProbes`.
    && (candidate['modelId'] === undefined || typeof candidate['modelId'] === 'string')
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
 * The recovery time a stored record implies — declared, or recoverable from its
 * own body.
 *
 * The field itself wins when present: it is what the writer computed with the
 * full input set (`Retry-After` header, quota-refresh point, body), and
 * re-deriving it could only lose information.
 *
 * The fallback exists because a record can state a time in its `message` and
 * still have no `retryAtMs`. That is not a hypothetical — it is what the English
 * `6004` body produced, since the parser that ran at write time matched only the
 * Chinese 「… 重置」 sentence:
 *
 *   `{"code":6004,"msg":"usage exceeds frequency limit, but don't worry, your
 *     usage will reset at 2026-10-16 11:34:04 UTC+8, …"}`
 *
 * leaving a record that names the exact minute it will serve again while
 * `retryDue` falls back to {@link POOL_UNKNOWN_COOLDOWN_MS}. The row then told the
 * user 「上游未给出何时恢复」 about a body that had just said when, and the pool
 * put the account back ~18 hours early to rediscover the same limit.
 *
 * Read-time healing is the only place this can be repaired for EXISTING records:
 * every consumer receives probes through {@link readPoolProbes} —
 * `accountExclusions` (the composer panel), `poolMembersOf` /
 * `localPoolMembers` (the card AND failover routing), `memberNames` — so healing
 * here fixes all of them at once. Re-deriving at each consumer instead would be
 * three copies of one rule, and the next consumer added would silently miss it.
 *
 * Not a permanent second derivation: `writePoolProbes` reads through this
 * function before it writes, so the very next write persists the healed value.
 *
 * Scoped to the two outcomes whose vocabulary HAS a stated time, matching
 * {@link WorkBuddyPoolProbe.retryAtMs}. Widening it would let an incidental
 * sentence in an `ok` body attach a countdown to a healthy account —
 * `AccountPool.tsx` prints any present `retryAtMs` beside the outcome, so that
 * would render a waiting time on an account that is not waiting for anything.
 */
function retryAtMsOf(probe: WorkBuddyPoolProbe): number | undefined {
  // A success NEVER carries a cooldown, whatever the stored record says.
  //
  // Records written before this rule existed can hold `outcome: 'ok'` together
  // with a `retryAtMs` eight days out: the value is the account's monthly quota
  // reset, read off a `Retry-After` header on a 200 response. That is the record
  // behind “测试的是免费模型，为什么要 8 天后才能用？” — the card rendered
  // “✓ 可用 · 11/01 00:00 之后可再用 · 约 8 天后” on a model that answered.
  //
  // Healing HERE is what retires those records: every consumer reads probes
  // through {@link readPoolProbes}, and the next `writePoolProbes` persists the
  // healed shape, so a file written by an older build repairs itself.
  if (probe.outcome === 'ok') return undefined
  if (probe.retryAtMs !== undefined) return probe.retryAtMs
  if (probe.outcome !== 'rate-limited' && probe.outcome !== 'out-of-credit') return undefined
  if (probe.message === undefined) return undefined
  return parseUpstreamResetAt(probe.message)
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
    const retryAtMs = retryAtMsOf(probe)
    probes[accountId] = {
      outcome: probe.outcome,
      atMs: probe.atMs,
      ...knownProbeSource(probe.source) === undefined ? {} : { source: knownProbeSource(probe.source)! },
      ...retryAtMs === undefined ? {} : { retryAtMs },
      ...probe.message === undefined ? {} : { message: probe.message },
      ...probe.accountName === undefined ? {} : { accountName: probe.accountName },
      // `modelId` MUST be read back, and its absence here was a data-CORRUPTION
      // bug rather than a missing display field: `writePoolProbes` reads the
      // document, merges, and writes the whole thing, so a field dropped on READ
      // is erased on the NEXT WRITE — and on every write after that. The card
      // then rendered "未记录模型" for measurements that HAD recorded one, and
      // the pool's own reading of an `ok` as an account-level fact lost the
      // scope caveat this field exists to carry (issue #61).
      ...probe.modelId === undefined ? {} : { modelId: probe.modelId },
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
 * Merge ONE new measurement over the record already stored for that account.
 *
 * A plain `{ ...existing, ...update }` is wrong here, and the damage is silent.
 * The two writers describe the same account at different moments and carry
 * different fields:
 *
 *   - `test-batch` measures the TARGET MODEL deliberately, and it is the writer
 *     that can attach the monthly refresh point (`retryAtMs` with
 *     `retrySource: 'quota-refresh'`) — recorded as upstream evidence about the
 *     PACKAGE's cycle, not as the moment the account becomes usable again.
 *   - `live-request` reports what a real chat request just hit. It often carries
 *     no `retryAtMs` at all (a transport blip names no time), and a spread would
 *     therefore DELETE that recorded point.
 *
 * Measured consequence of the spread, on a real `14018` account: the probe
 * recorded "quota refreshes 2026-11-01", the next live failure rewrote the
 * record without that field, and the card then said the upstream gave no time at
 * all — while the correct value was in the file one write earlier.
 *
 * NOTE that recovery no longer follows from this field: credit exhaustion is
 * cleared by a later positive balance read, not by the timestamp passing (see
 * `reconcilePoolCredits` and `exclusionOf`). The point is inherited because it is
 * upstream evidence worth keeping, and losing it would silently downgrade a
 * recorded fact to "the upstream said nothing".
 *
 * So `retryAtMs` is INHERITED when the update does not state one, and every
 * other field is the update's (the newer measurement owns `outcome`, `atMs`,
 * `source` and `message`). Inheriting is only about the one field whose absence
 * is not a statement: an update that DOES carry a time still overrides, which is
 * what lets a fresh, shorter cooldown supersede a stale longer one.
 *
 * Pure and exported so the rule is unit-testable without a filesystem — this is
 * exactly the kind of "two writers, one slot" rule that this project has been
 * bitten by before.
 */
export function mergePoolProbe(
  existing: WorkBuddyPoolProbe | undefined,
  update: WorkBuddyPoolProbe,
): WorkBuddyPoolProbe {
  if (existing === undefined) return update
  // The display name is INHERITED when the update does not carry one, for the
  // same reason `retryAtMs` is: its absence is not a statement. A writer that
  // could not see the account (a live failure on a credential the store can no
  // longer name) must not erase the name an earlier measurement DID see — that
  // name is the only thing that can identify a member whose sign-in has gone,
  // which is exactly the record #60 needs kept.
  const merged = update.accountName === undefined && existing.accountName !== undefined
    ? { ...update, accountName: existing.accountName }
    : update
  // A SUCCESS owns no cooldown, so an older record's `retryAtMs` must not be
  // inherited onto it — and any time the update itself carries is dropped too.
  // Without this, one `ok` measurement rewritten after a stale record would keep
  // resurrecting the eight-day “之后可再用” that the read-time heal above just
  // removed. The strip is unconditional because the invariant is absolute: a
  // success is not waiting for anything.
  if (update.outcome === 'ok') {
    const { retryAtMs: _dropped, ...rest } = merged
    return rest
  }
  if (update.retryAtMs !== undefined) return merged
  // A stored time that has already PASSED is not worth inheriting: carrying it
  // forward would date the record to a moment in the past and make the row read
  // as "back after <a time that is already gone>".
  if (existing.retryAtMs === undefined || existing.retryAtMs <= update.atMs) return merged
  return { ...merged, retryAtMs: existing.retryAtMs }
}

/**
 * Merge measurements into one region's store and write it atomically.
 *
 * A MERGE rather than a replace, because batches measure one account at a time
 * and a partial failure must not erase what earlier runs learned. An account
 * absent from `updates` keeps its previous measurement, and an account present
 * in both is combined by {@link mergePoolProbe} rather than overwritten.
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
      const merged: Record<string, WorkBuddyPoolProbe> = { ...existing }
      for (const [accountId, update] of Object.entries(updates)) {
        merged[accountId] = mergePoolProbe(existing[accountId], update)
      }
      const document: PoolDocument = {
        version: STORE_FORMAT_VERSION,
        probes: merged,
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

/**
 * 只有失败记录写入之后发起的余额查询，才能解除积分耗尽状态。
 * 持锁重读可避免较早的查询结果覆盖并发请求刚记录的新失败；其他异常保持原样。
 * 删除失败记录只表示余额恢复，不会伪造一次成功的模型测试。
 * 恢复后界面会显示“未测试”：这里删除的是最近失败记录，存储结构没有保留此前
 * 成功测试的历史，余额到账也不能证明某个模型可用；再次测试才会产生新的结论。
 */
export async function reconcilePoolCredits(
  region: WorkBuddyRegion,
  readings: readonly { accountId: string, startedAtMs: number, total: number }[],
): Promise<Readonly<Record<string, WorkBuddyPoolProbe>>> {
  const path = workbuddyPoolStorePath(region)
  try {
    return await withFileLock(path, async () => {
      const probes = await readPoolProbes(region)
      let changed = false
      for (const reading of readings) {
        const probe = probes[reading.accountId]
        if (probe?.outcome !== 'out-of-credit' || probe.atMs >= reading.startedAtMs) continue
        if (!Number.isFinite(reading.total) || reading.total <= 0) continue
        delete probes[reading.accountId]
        changed = true
      }
      if (changed) {
        const document: PoolDocument = { version: STORE_FORMAT_VERSION, probes }
        await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      return probes
    })
  } catch {
    // 写入失败时保留磁盘中的状态，不将未保存的恢复结果用于选号。
    return readPoolProbes(region)
  }
}
