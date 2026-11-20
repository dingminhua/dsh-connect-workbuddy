import { describe, expect, it } from 'vitest'
import { emptyAutoCheckinState, foldAttempt } from '../src/auto-checkin.ts'
import {
  activateGrowthAll,
  foldGrowthAttempt,
  growthPendingTargets,
  growthRowsForFold,
  growthTodaySummary,
  redeemGrowthAll,
  type RedeemBatchDeps,
} from '../src/growth-run.ts'

const targets = [
  { accountId: 'a', accountName: 'Alpha' },
  { accountId: 'b', accountName: 'Beta' },
]

describe('growthRowsForFold (issue #286, hash-as-error bug)', () => {
  it('carries the real failure message so foldAttempt never shows a raw account id', () => {
    // The reported bug: lastError was a 24-hex account id because the mapping
    // dropped `message` and foldAttempt fell back to `accountId`.
    const rows = growthRowsForFold([
      { accountId: 'ba217455a46db83f7d3891ee', accountName: 'A', status: 'failed', message: 'growth streak was not readable' },
      { accountId: 'ok1', accountName: 'B', status: 'done', message: 'redeemed 7d' },
      { accountId: 'skip1', accountName: 'C', status: 'skipped', message: 'no tier is available to redeem' },
    ])
    expect(rows[0]).toEqual({
      accountId: 'ba217455a46db83f7d3891ee', accountName: 'A', status: 'failed',
      message: 'growth streak was not readable',
    })
    expect(rows[1]?.status).toBe('claimed')
    expect(rows[2]?.status).toBe('already')
  })

  it('feeds a real message into foldAttempt, not the account id', () => {
    // End-to-end with the shared folding state machine: the lastError it
    // produces must be the human reason, never the id.
    const state = emptyAutoCheckinState('2026-11-21')
    const folded = foldAttempt(state, growthRowsForFold([
      { accountId: 'hex-hex-hex', accountName: 'A', status: 'failed', message: 'growth streak was not readable' },
    ]), 1_000, 1)
    expect(folded.lastError).toBe('growth streak was not readable')
    expect(folded.lastError).not.toContain('hex-hex-hex')
  })
})

describe('growth stable day state (issue #286, no retry/no error noise)', () => {
  const targets = [
    { accountId: 'a' }, { accountId: 'b' }, { accountId: 'c' },
  ]

  it('settles EVERY attempted account, including a failed one — never retried', () => {
    const state = emptyAutoCheckinState('2026-11-21')
    const folded = foldGrowthAttempt(state, ['a', 'b'], 3, 1000)
    // 'b' "failed" upstream but was attempted, so it is settled: no pending.
    expect(growthPendingTargets(targets, folded).map(t => t.accountId)).toEqual(['c'])
    const next = foldGrowthAttempt(folded, ['c'], 3, 2000)
    expect(growthPendingTargets(targets, next)).toEqual([])
  })

  it('carries NO failures / lastError / backoff — a plain done of total', () => {
    const state = emptyAutoCheckinState('2026-11-21')
    const folded = foldGrowthAttempt(state, ['a', 'b'], 3, 1000)
    expect(folded.failures).toBe(0)
    expect(folded.lastError).toBeUndefined()
    const summary = growthTodaySummary(folded, '2026-11-21')
    expect(summary).toEqual({ done: 2, total: 3 })
  })

  it('uses the real member count, never an inflated denominator', () => {
    // The old bug: a manual run added doneAccountIds to total -> 8/17.
    let state = emptyAutoCheckinState('2026-11-21')
    state = foldGrowthAttempt(state, ['a', 'b', 'c'], 3, 1000)
    state = foldGrowthAttempt(state, ['a', 'b', 'c'], 3, 2000)
    expect(growthTodaySummary(state, '2026-11-21')).toEqual({ done: 3, total: 3 })
  })

  it('reports nothing for a different day (local midnight rollover)', () => {
    const state = foldGrowthAttempt(emptyAutoCheckinState('2026-11-20'), ['a'], 3, 1000)
    expect(growthTodaySummary(state, '2026-11-21')).toBeUndefined()
  })
})

describe('redeemGrowthAll', () => {
  function deps(over: Partial<RedeemBatchDeps> = {}): RedeemBatchDeps {
    return {
      credentialFor: async id => ({ accessToken: `token-${id}` }),
      readStreak: async cred =>
        (cred as { accessToken: string }).accessToken === 'token-a'
          ? { availableTiers: ['7d'] }
          : { availableTiers: [] },
      redeem: async (_cred, tier) => ({ credit: tier === '7d' ? 20 : 50 }),
      wait: async () => {},
      ...over,
    }
  }

  it('redeems only available tiers and skips accounts with none', async () => {
    const redeemed: string[] = []
    const rows = await redeemGrowthAll(targets, deps({
      redeem: async (_cred, tier) => { redeemed.push(tier); return { credit: 20 } },
    }))
    expect(rows.map(row => row.status)).toEqual(['done', 'skipped'])
    expect(rows[0]?.credit).toBe(20)
    expect(redeemed).toEqual(['7d'])
  })

  it('never writes to a locked tier — a locked snapshot sends no redeem at all', async () => {
    let writes = 0
    const rows = await redeemGrowthAll([targets[0]!], deps({
      readStreak: async () => ({ availableTiers: [] }),
      redeem: async () => { writes += 1; return { credit: 0 } },
    }))
    expect(writes).toBe(0)
    expect(rows[0]?.status).toBe('skipped')
  })

  it('isolates one account failure and continues to the next', async () => {
    const rows = await redeemGrowthAll(targets, deps({
      readStreak: async cred =>
        (cred as { accessToken: string }).accessToken === 'token-a'
          ? Promise.reject(new Error('upstream down'))
          : { availableTiers: [] },
    }))
    expect(rows[0]?.status).toBe('failed')
    expect(rows[1]?.status).toBe('skipped')
  })

  it('reports a missing credential without touching other accounts', async () => {
    const rows = await redeemGrowthAll(targets, deps({
      credentialFor: async id => id === 'a' ? undefined : { accessToken: 'token-b' },
    }))
    expect(rows[0]?.status).toBe('failed')
    expect(rows[1]?.status).toBe('skipped')
  })
})

describe('activateGrowthAll', () => {
  it('is idempotent: an already-active account sends no activation', async () => {
    const called: string[] = []
    const rows = await activateGrowthAll(targets, async id => {
      called.push(id)
      return id === 'a'
        ? { status: 'already-active' }
        : { status: 'activated', score: 2 }
    }, async () => {})
    expect(rows.map(row => row.status)).toEqual(['skipped', 'done'])
    // Both are asked (to read the heatmap), but only the inactive one is sent.
    expect(called).toEqual(['a', 'b'])
  })

  it('captures a failed activation as its own row and continues', async () => {
    const rows = await activateGrowthAll(targets, async id =>
      id === 'a' ? { status: 'failed', reason: 'ACP refused' } : { status: 'activated' },
    async () => {})
    expect(rows[0]?.status).toBe('failed')
    expect(rows[0]?.message).toContain('ACP refused')
    expect(rows[1]?.status).toBe('done')
  })

  it('survives an activateOne throw without aborting the batch', async () => {
    const rows = await activateGrowthAll(targets, async id => {
      if (id === 'a') throw new Error('boom')
      return { status: 'activated' }
    }, async () => {})
    expect(rows[0]?.status).toBe('failed')
    expect(rows[1]?.status).toBe('done')
  })
})
