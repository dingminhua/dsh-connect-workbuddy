/**
 * The chip's copy: what the upstream said, plus the two derived pieces the card
 * adds so the reader can tell WHY the badge is there.
 *
 * Two rules are pinned here, both about not overstating the campaign:
 *
 * 1. `validUntil` is EXCLUSIVE. The upstream writes it as the midnight that
 *    opens the day after the campaign and describes the campaign as ending the
 *    previous day ("7月6日–10月31日", `validUntil` 2026-11-01T00:00+08:00).
 *    Printing the raw instant would put "Nov 1" in the same tooltip and read as
 *    if the campaign ran a day longer than it does.
 * 2. A date the upstream wrote in ITS zone is read in that zone. Formatting it
 *    in the reader's own zone shows "Jul 5" to anyone west of UTC, which
 *    contradicts the upstream's own copy sitting beside it in the tooltip.
 *
 * Pure functions, no DOM: they are unit-tested directly rather than through the
 * card.
 */
import { describe, expect, it } from 'vitest'
import { promoBadgeColor, promoBadgeLabel, promoBadgeTooltip } from '../src/client/promo-badge.ts'
import type { WorkBuddyPromo } from '../src/promo.ts'

/** The real CN promotion captured 2026-10-21: hours plus an absolute lifetime. */
const nightDiscount: WorkBuddyPromo = {
  id: 'glm-52-night-discount-202607',
  source: 'promotion',
  modelIds: ['glm-5.2'],
  priority: 100,
  badge: { label: '夜间折扣', color: '#009273' },
  hover: { textZh: '每晚 23:00—次日 7:50 积分限时立减，错峰用更省' },
  schedule: {
    timezone: 'Asia/Shanghai',
    validFrom: Date.parse('2026-07-06T00:00:00+08:00'),
    // Right-open: the campaign is over AT this instant; its last day is 10-31.
    validUntil: Date.parse('2026-11-01T00:00:00+08:00'),
    daily: [{ start: '23:00', end: '7:50' }],
  },
}

/** The real CN tier entry: no schedule at all. */
const tierBadge: WorkBuddyPromo = {
  id: 'tier-standard-2026q3',
  source: 'tier',
  modelIds: ['glm-5.3'],
  priority: 20,
  badge: { label: '订阅优先', color: '#009273' },
  hover: { textZh: '资源紧张，旗舰版及高级版会员享优先调度。' },
}

describe('promoBadgeTooltip', () => {
  it('prints the last day the campaign runs, not the exclusive end instant', () => {
    const tooltip = promoBadgeTooltip(nightDiscount, 'zh-CN')
    // The upstream's own copy says 10月31日; the derived range must agree.
    expect(tooltip).toContain('2026年10月31日')
    expect(tooltip).not.toContain('2026年11月1日')
  })

  it('reads the date in the upstream\'s zone, not the reader\'s', () => {
    // The instant is 2026-07-06T00:00+08:00. In a zone west of UTC that is
    // still Jul 5; the upstream calls it Jul 6, and the tooltip must too.
    for (const language of ['en-US', 'zh-CN', 'de-DE']) {
      const tooltip = promoBadgeTooltip(nightDiscount, language)
      const from = nightDiscount.schedule!.validFrom!
      const upstreamDay = new Intl.DateTimeFormat(language, {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: 'short', day: 'numeric',
      }).format(new Date(from))
      expect(tooltip).toContain(upstreamDay)
    }
  })

  it('still reports the hours in the upstream\'s zone', () => {
    expect(promoBadgeTooltip(nightDiscount, 'zh-CN')).toContain('23:00–7:50 (Asia/Shanghai)')
  })

  it('leaves the range and the hours out for a badge that publishes neither', () => {
    // A tier badge describes an access right, not a campaign window. The card
    // adds no dates and no hours of its own — the copy stays the upstream's.
    expect(promoBadgeTooltip(tierBadge, 'zh-CN')).toBe('资源紧张，旗舰版及高级版会员享优先调度。')
  })

  it('never prints the exclusive end instant, in a schedule that names no zone', () => {
    // No declared zone: fall back to the reader's zone rather than inventing
    // an Asia/Shanghai one. The claim under test is narrow and zone-free —
    // the EXCLUSIVE boundary is never printed, only the instant before it.
    //
    // The fixture's boundary is written in UTC on purpose. With a `+08:00`
    // boundary the two candidate behaviours render the same day in UTC
    // ("Oct 31" either way), so the test could not tell "subtracts 1ms" from
    // "invents Asia/Shanghai" and would stay green through both — a guard
    // that cannot bite. A `Z` boundary splits them: the reader's zone (UTC,
    // pinned in vitest.config.ts) says Oct 31 while an invented `+08:00`
    // says Nov 1.
    const noZone: WorkBuddyPromo = {
      ...nightDiscount,
      id: 'no-zone',
      schedule: { validUntil: Date.parse('2026-11-01T00:00:00Z') },
    }
    const tooltip = promoBadgeTooltip(noZone, 'en-US')
    expect(tooltip).not.toContain('Nov 1, 2026')
    // The other half: dropping the range entirely is the alternative to
    // printing a wrong day, and it must not silently become "no range at all".
    expect(tooltip).toContain('Oct 31, 2026')
  })
})

describe('promoBadgeLabel and promoBadgeColor', () => {
  it('prefers the English label only when the UI is English and the upstream published one', () => {
    const both: WorkBuddyPromo = { ...tierBadge, badge: { label: '订阅优先', labelEn: 'Pro Only' } }
    expect(promoBadgeLabel(both, 'en-US')).toBe('Pro Only')
    expect(promoBadgeLabel(both, 'zh-CN')).toBe('订阅优先')
    // CN feed publishes no labelEn; the Chinese label is the upstream's answer
    // and the plugin must not translate it.
    expect(promoBadgeLabel(tierBadge, 'en-US')).toBe('订阅优先')
  })

  it('accepts only a hex colour, so nothing arbitrary reaches an inline style', () => {
    expect(promoBadgeColor(nightDiscount)).toBe('#009273')
    for (const color of ['rgb(1,2,3)', 'red', '#12345', '#009273ff', 'expression(alert(1))']) {
      expect(promoBadgeColor({ ...nightDiscount, badge: { label: 'x', color } })).toBeUndefined()
    }
  })
})
