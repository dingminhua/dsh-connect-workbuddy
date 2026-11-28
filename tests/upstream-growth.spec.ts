import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Growth-center REST methods (issue #286). These are the shared foundation for
 * both regions — the region follows `credential.domain`, never an argument, so
 * one method body serves CN and international accounts alike.
 */

function credential(domain = 'www.codebuddy.cn'): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: 0,
    domain,
    uid: 'u',
    source: 'desktop',
    filePath: '/tmp/workbuddy-desktop.info',
  }
}

function envelope(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, msg: 'OK', data }),
  } as unknown as Response
}

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchGrowthToday', () => {
  it('reduces the heatmap today cell, both regions hitting their own billing host', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return envelope({ today: { date: '2026-11-20', score: 6, is_active: true, status_text: '今日已活跃' } })
    })
    const cell = await new WorkBuddyUpstreamClient().fetchGrowthToday(credential('www.workbuddy.ai'))
    expect(cell).toEqual({ date: '2026-11-20', isActive: true, score: 6, statusText: '今日已活跃' })
    expect(urls[0]).toContain('www.workbuddy.ai')
    expect(urls[0]).toContain('/v2/activity/growth/heatmap')
  })

  it('falls back to the bare path when the /v2 spelling is 404', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      if (url.includes('/v2/')) return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response
      return envelope({ today: { date: '2026-11-20', score: 0, is_active: false } })
    })
    const cell = await new WorkBuddyUpstreamClient().fetchGrowthToday(credential())
    expect(cell?.isActive).toBe(false)
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('/activity/growth/heatmap')
  })

  it('reports no answer when neither shape succeeded', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, text: async () => 'no' } as unknown as Response))
    expect(await new WorkBuddyUpstreamClient().fetchGrowthToday(credential())).toBeUndefined()
  })
})

describe('fetchGrowthStreak', () => {
  it('derives ONLY the available tiers as redeemable', async () => {
    vi.stubGlobal('fetch', async () => envelope({
      streak: { days: 8, month_total_days: 8, month_consumed_days: 7, next_tier: '14d', next_tier_remaining: 6 },
      makeup_cards: { balance: 2, max: 4 },
      redemption_status: {
        tier_7d_status: 'available',
        tier_14d_status: 'locked',
        tier_28d_status: 'locked',
      },
    }))
    const streak = await new WorkBuddyUpstreamClient().fetchGrowthStreak(credential())
    expect(streak?.days).toBe(8)
    expect(streak?.nextTier).toBe('14d')
    expect(streak?.availableTiers).toEqual(['7d'])
    expect(streak?.makeupCardBalance).toBe(2)
  })

  it('treats an all-locked snapshot as nothing redeemable', async () => {
    vi.stubGlobal('fetch', async () => envelope({
      streak: { days: 3 },
      redemption_status: { tier_7d_status: 'locked', tier_14d_status: 'locked', tier_28d_status: 'locked' },
    }))
    const streak = await new WorkBuddyUpstreamClient().fetchGrowthStreak(credential())
    expect(streak?.availableTiers).toEqual([])
  })
})

describe('redeemGrowthTier', () => {
  it('POSTs the tier WITH a fresh client_token and reduces the real credit_granted fields (#335)', async () => {
    let method = ''
    const bodies: Record<string, unknown>[] = []
    let url = ''
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
      url = u
      method = init.method ?? ''
      bodies.push(JSON.parse(String(init.body ?? '')) as Record<string, unknown>)
      return envelope({ credit_granted: 50, energy_granted: 3, cards_granted: 1 })
    })
    const client = new WorkBuddyUpstreamClient()
    const result = await client.redeemGrowthTier(credential(), '14d')
    // A second call must get a DIFFERENT token: a replayed idempotency key makes
    // the gateway treat it as the first claim rather than a new one.
    await client.redeemGrowthTier(credential(), '28d')
    expect(method).toBe('POST')
    expect(url).toContain('/activity/growth/redeem')
    expect(bodies).toHaveLength(2)
    for (const [index, body] of bodies.entries()) {
      expect(body['tier']).toBe(index === 0 ? '14d' : '28d')
      expect(typeof body['client_token']).toBe('string')
      expect(String(body['client_token']).length).toBeGreaterThan(0)
    }
    expect(bodies[0]?.['client_token']).not.toBe(bodies[1]?.['client_token'])
    expect(result).toEqual({ tier: '14d', credit: 50, energy: 3 })
  })

  it('still reads the legacy credit/energy field names', async () => {
    vi.stubGlobal('fetch', async () => envelope({ credit: 20, energy: 2 }))
    const result = await new WorkBuddyUpstreamClient().redeemGrowthTier(credential(), '7d')
    expect(result).toEqual({ tier: '7d', credit: 20, energy: 2 })
  })

  it('surfaces already_claimed without inventing a reward', async () => {
    vi.stubGlobal('fetch', async () => envelope({ already_claimed: true }))
    const result = await new WorkBuddyUpstreamClient().redeemGrowthTier(credential(), '7d')
    expect(result.alreadyClaimed).toBe(true)
    expect(result.credit).toBe(0)
  })
})
