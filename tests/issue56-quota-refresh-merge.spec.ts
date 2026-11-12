/**
 * Regression suite for the two defects the issue #56 reporter found while
 * verifying 4.4.3 — both about the LIVE-REQUEST writer and the `out-of-credit`
 * refresh point.
 *
 * The reporter's matrix on a real `14018` account (`monthly: true`,
 * `refreshAt = 2026-11-01`) is what makes these decidable:
 *
 *   | path                        | cooldownOf result                    | pool table shows    |
 *   | ---                         | ---                                  | ---                 |
 *   | probe (passes quotaRefresh) | {retryAtMs: 2026-11-01, 'quota-refresh'} | 2026-11-01      |
 *   | live chat (did not)         | {} → POOL_UNKNOWN_COOLDOWN_MS        | ~30 minutes later   |
 *
 * Two separate faults, and they compound:
 *
 * 1. **`recordAccountFailure` did not pass `quotaRefreshAtMs`**, so the live path
 *    could not produce the one honest answer even though the probe path already
 *    proved the data is reachable.
 *
 * 2. **`writePoolProbes` spread the update over the stored record**, so the live
 *    write DELETED the refresh point the probe had stored correctly. Fixing (1)
 *    alone would still let a `live-request` record with no `retryAtMs` wipe a
 *    good one.
 *
 * (1) lives in `src/index.ts` and is covered end-to-end by `pool-e2e`; the pure
 * rule that (2) needs is {@link mergePoolProbe}, pinned here directly, plus the
 * on-disk behaviour through `writePoolProbes`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergePoolProbe, readPoolProbes, writePoolProbes } from '../src/account-pool-store.ts'
import { exclusionOf, POOL_UNKNOWN_COOLDOWN_MS } from '../src/account-pool.ts'
import { cooldownOf } from '../src/probe.ts'

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-merge-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(home, { force: true, recursive: true })
})

/** The reporter's real refresh point: 2026-11-01, stated by the billing side. */
const QUOTA_REFRESH_AT = Date.UTC(2026, 10, 1)
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)

describe('the live writer must not delete a refresh point the probe resolved', () => {
  it('inherits retryAtMs when the update states none', () => {
    // The exact loss the reporter reproduced: a `live-request` record carries no
    // `retryAtMs`, and a spread would drop the probe's value.
    const merged = mergePoolProbe(
      { outcome: 'out-of-credit', atMs: NOW, source: 'test-batch', retryAtMs: QUOTA_REFRESH_AT },
      { outcome: 'out-of-credit', atMs: NOW + 1_000, source: 'live-request', message: 'Credits exhausted.' },
    )
    expect(merged.retryAtMs).toBe(QUOTA_REFRESH_AT)
    // Everything else belongs to the NEWER measurement.
    expect(merged.outcome).toBe('out-of-credit')
    expect(merged.atMs).toBe(NOW + 1_000)
    expect(merged.source).toBe('live-request')
    expect(merged.message).toBe('Credits exhausted.')
  })

  it('lets an update that DOES state a time override the stored one', () => {
    // Inheriting is about a MISSING field, not about freezing the record: a
    // fresh reading must be able to supersede an older one, shorter or longer.
    const sooner = QUOTA_REFRESH_AT - 86_400_000
    const merged = mergePoolProbe(
      { outcome: 'out-of-credit', atMs: NOW, retryAtMs: QUOTA_REFRESH_AT },
      { outcome: 'rate-limited', atMs: NOW + 1_000, retryAtMs: sooner },
    )
    expect(merged.retryAtMs).toBe(sooner)
    expect(merged.outcome).toBe('rate-limited')
  })

  it('does not inherit a time that has already passed', () => {
    // Carrying a stale past instant forward would date the record to a moment
    // that is already gone, and the row would read "back after <the past>".
    const merged = mergePoolProbe(
      { outcome: 'out-of-credit', atMs: NOW - 10_000, retryAtMs: NOW - 5_000 },
      { outcome: 'out-of-credit', atMs: NOW, source: 'live-request' },
    )
    expect(merged.retryAtMs).toBeUndefined()
  })

  it('takes the update as-is when nothing was stored', () => {
    const update = { outcome: 'rate-limited' as const, atMs: NOW }
    expect(mergePoolProbe(undefined, update)).toBe(update)
  })

  it('a whole-object spread would have failed these — pinned so the rule cannot regress to one', () => {
    // Stated as the contrast, so the reason this function exists is in the
    // suite. The loss happens at the ACCOUNT level, one level ABOVE the field:
    // `{ ...existing, ...updates }` lets `updates.acct` — a fresh object built
    // by `recordAccountFailure` — replace `existing.acct` WHOLESALE, so the
    // stored `retryAtMs` never gets a chance to survive. (It is not that a
    // spread drops a key the update omitted; it is that the spread never looked
    // inside the account's record at all.)
    const stored = { acct: { outcome: 'out-of-credit' as const, atMs: NOW, source: 'test-batch' as const, retryAtMs: QUOTA_REFRESH_AT } }
    const update = { acct: { outcome: 'out-of-credit' as const, atMs: NOW + 1, source: 'live-request' as const } }
    // Widened deliberately: the whole point is a field that the TYPE says is
    // absent but the runtime record still needed to keep.
    const spread = ({ ...stored, ...update }) as { acct: { retryAtMs?: number } }
    expect(spread.acct.retryAtMs).toBeUndefined()
    // The per-account merge keeps it.
    expect(mergePoolProbe(stored.acct, update.acct).retryAtMs).toBe(QUOTA_REFRESH_AT)
  })
})

describe('the two paths now agree on when an exhausted account comes back', () => {
  it('a live failure that knows the refresh point reports it, not the fallback', () => {
    // This is the end-to-end shape after fixing `recordAccountFailure`: the same
    // inputs the probe passes produce the same answer from the live path.
    const live = cooldownOf({
      outcome: 'out-of-credit',
      retryAfter: null,
      nowMs: NOW,
      body: '{"error":{"data":{"code":14018,"msg":"Credits exhausted."}}}',
      quotaRefreshAtMs: QUOTA_REFRESH_AT,
    })
    expect(live).toEqual({ retryAtMs: QUOTA_REFRESH_AT, retrySource: 'quota-refresh' })
    // The two paths cannot disagree any more because they read the same source.
    const probe = cooldownOf({
      outcome: 'out-of-credit',
      retryAfter: null,
      nowMs: NOW,
      body: '{"error":{"data":{"code":14018,"msg":"Credits exhausted."}}}',
      quotaRefreshAtMs: QUOTA_REFRESH_AT,
    })
    expect(live).toEqual(probe)
  })

  it('keeps an unknown replenishment time excluded until credits are confirmed', () => {
    // A local timer cannot establish that check-in or a package refresh paid out.
    const unknown = cooldownOf({
      outcome: 'out-of-credit',
      retryAfter: null,
      nowMs: NOW,
      body: '{"error":{"data":{"code":14018,"msg":"Credits exhausted."}}}',
    })
    expect(unknown).toEqual({})
    const probe = { outcome: 'out-of-credit' as const, atMs: NOW }
    expect(exclusionOf(probe, NOW + POOL_UNKNOWN_COOLDOWN_MS - 1)).toBe('out-of-credit')
    expect(exclusionOf(probe, NOW + POOL_UNKNOWN_COOLDOWN_MS)).toBe('out-of-credit')
  })

  it('does not treat the quota refresh instant as proof of replenishment', () => {
    // A later balance query may release the account earlier; the instant alone cannot.
    const probe = { outcome: 'out-of-credit' as const, atMs: NOW, retryAtMs: QUOTA_REFRESH_AT }
    expect(exclusionOf(probe, NOW + POOL_UNKNOWN_COOLDOWN_MS)).toBe('out-of-credit')
    expect(exclusionOf(probe, QUOTA_REFRESH_AT - 1)).toBe('out-of-credit')
    expect(exclusionOf(probe, QUOTA_REFRESH_AT)).toBe('out-of-credit')
  })
})

describe('writePoolProbes keeps the stored refresh point across a live write', () => {
  it('survives a probe-then-live-failure sequence on disk', async () => {
    // The reporter's exact sequence, through the real writer.
    await writePoolProbes('global', {
      acct: { outcome: 'out-of-credit', atMs: NOW, source: 'test-batch', retryAtMs: QUOTA_REFRESH_AT },
    })
    await writePoolProbes('global', {
      acct: { outcome: 'out-of-credit', atMs: NOW + 1_000, source: 'live-request', message: 'Credits exhausted.' },
    })
    const stored = await readPoolProbes('global')
    expect(stored.acct?.retryAtMs).toBe(QUOTA_REFRESH_AT)
    expect(stored.acct?.source).toBe('live-request')
    // And the pool reads the honest time out of it.
    expect(exclusionOf(stored.acct, NOW + POOL_UNKNOWN_COOLDOWN_MS)).toBe('out-of-credit')
  })

  it('still lets a later measurement replace the outcome entirely', async () => {
    // The merge must not turn into "never change": an account that has recovered
    // is a candidate again.
    await writePoolProbes('global', { acct: { outcome: 'rate-limited', atMs: NOW, retryAtMs: NOW + 60_000 } })
    await writePoolProbes('global', { acct: { outcome: 'ok', atMs: NOW + 2_000, source: 'test-batch' } })
    const stored = await readPoolProbes('global')
    expect(stored.acct?.outcome).toBe('ok')
    expect(exclusionOf(stored.acct, NOW + 3_000)).toBeUndefined()
  })

  it('leaves other accounts untouched', async () => {
    await writePoolProbes('global', {
      a: { outcome: 'ok', atMs: NOW },
      b: { outcome: 'out-of-credit', atMs: NOW, retryAtMs: QUOTA_REFRESH_AT },
    })
    await writePoolProbes('global', { b: { outcome: 'out-of-credit', atMs: NOW + 1, source: 'live-request' } })
    const stored = await readPoolProbes('global')
    expect(stored.a?.outcome).toBe('ok')
    expect(stored.b?.retryAtMs).toBe(QUOTA_REFRESH_AT)
  })
})
