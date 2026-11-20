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
  it('POSTs the tier to the redeem endpoint and reduces the result', async () => {
    let method = ''
    let body = ''
    let url = ''
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
      url = u
      method = init.method ?? ''
      body = String(init.body ?? '')
      return envelope({ credit: 50, energy: 3 })
    })
    const result = await new WorkBuddyUpstreamClient().redeemGrowthTier(credential(), '14d')
    expect(method).toBe('POST')
    expect(JSON.parse(body)).toEqual({ tier: '14d' })
    expect(url).toContain('/activity/growth/redeem')
    expect(result).toEqual({ tier: '14d', credit: 50, energy: 3 })
  })

  it('surfaces already_claimed without inventing a reward', async () => {
    vi.stubGlobal('fetch', async () => envelope({ already_claimed: true }))
    const result = await new WorkBuddyUpstreamClient().redeemGrowthTier(credential(), '7d')
    expect(result.alreadyClaimed).toBe(true)
    expect(result.credit).toBe(0)
  })
})
