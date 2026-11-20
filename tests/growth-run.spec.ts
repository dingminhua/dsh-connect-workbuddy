import { describe, expect, it } from 'vitest'
import {
  activateGrowthAll,
  redeemGrowthAll,
  type RedeemBatchDeps,
} from '../src/growth-run.ts'

const targets = [
  { accountId: 'a', accountName: 'Alpha' },
  { accountId: 'b', accountName: 'Beta' },
]

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
