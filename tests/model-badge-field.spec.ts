/**
 * The host's own `model.badge` field (0.2.2+), as the way a promotion reaches
 * the picker.
 *
 * WHY THIS REPLACED A SLOT. Until 0.2.2 the only way to decorate a picker row
 * was `conversation.input.model.label` — a `single` cell whose PARENT seat
 * belongs to another plugin. Contributing there means winning a priority race
 * against every other contributor, and losing (or the parent seat not mounting)
 * drops the decoration with no error the user can see. This repository measured
 * exactly that on 0.2.2-rc.1: correct data, correct resolution, correct
 * component, empty picker.
 *
 * `LlmModelInfo.badge = { text, tone }` is a plain field on the model the
 * directory already reads: the host draws the chip itself, in its own place and
 * with its own theme tokens. Nothing to race for.
 */
import { describe, expect, it } from 'vitest'
import { promoBadgeTone } from '../src/client/promo-badge.ts'
import type { WorkBuddyPromo } from '../src/promo.ts'

function promo(overrides: Partial<{ color: string }> = {}): WorkBuddyPromo {
  return {
    id: 'p',
    source: 'promotion',
    modelIds: ['m'],
    badge: { label: '夜间折扣', labelEn: 'Night', color: overrides.color ?? '#009273' },
    priority: 50,
  } as unknown as WorkBuddyPromo
}

describe('promoBadgeTone', () => {
  it('maps the CN discount green onto the success tone', () => {
    // Every CN promotion this plugin has measured uses this green for "free /
    // discounted right now". Rendering it as a warning would invert its meaning.
    expect(promoBadgeTone(promo({ color: '#009273' }))).toBe('success')
    expect(promoBadgeTone(promo({ color: '#22a06b' }))).toBe('success')
  })

  it('maps a blue badge onto info', () => {
    // A tier / members-only marker, not a price event.
    expect(promoBadgeTone(promo({ color: '#1d63ed' }))).toBe('info')
  })

  it('maps warm colours onto warning', () => {
    expect(promoBadgeTone(promo({ color: '#e8b34b' }))).toBe('warning')
    expect(promoBadgeTone(promo({ color: '#d92d20' }))).toBe('warning')
  })

  it('falls back to neutral rather than inventing a meaning', () => {
    // Mid grey, and the no-colour case: the tone is a claim about severity, so
    // an unreadable colour must not become a loud one.
    expect(promoBadgeTone(promo({ color: '#808080' }))).toBe('neutral')
    const noColor = { ...promo(), badge: { label: 'x' } } as unknown as WorkBuddyPromo
    expect(promoBadgeTone(noColor)).toBe('neutral')
  })

  it('ignores a colour it cannot parse instead of throwing', () => {
    // `promoBadgeColor` already refuses non-hex, but this function must not be
    // the place a malformed upstream value crashes a model refresh.
    for (const bad of ['red', '#12', '#zzzzzz', 'rgb(1,2,3)']) {
      expect(() => promoBadgeTone(promo({ color: bad }))).not.toThrow()
      expect(promoBadgeTone(promo({ color: bad }))).toBe('neutral')
    }
  })
})

describe('hostModelBadgeOf', () => {
  const at = Date.parse('2026-11-07T16:00:00+08:00')

  it('stamps a badge for a promotion that holds right now', async () => {
    const { hostModelBadgeOf } = await import('../src/index.ts')
    const live = {
      ...promo({ color: '#009273' }),
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '0:00', end: '23:59' }] },
    } as unknown as WorkBuddyPromo
    expect(hostModelBadgeOf([live], at)).toEqual({
      badge: { text: { en: 'Night', zh: '夜间折扣' }, tone: 'success' },
    })
  })

  it('publishes nothing at all when no promotion holds', async () => {
    // `{}`, not `{ badge: undefined }`: the caller spreads this into the model
    // object, and an explicit undefined key is not the same as an absent one for
    // the host's `model.badge === undefined ? {} : ...` check on some paths.
    const { hostModelBadgeOf } = await import('../src/index.ts')
    expect(hostModelBadgeOf(undefined, at)).toEqual({})
    expect(hostModelBadgeOf([], at)).toEqual({})
  })

  it('does not claim a chip for a campaign outside its window', async () => {
    // The defect class this guards: a standing badge shown after the campaign
    // ended. `validUntil` is exclusive.
    const { hostModelBadgeOf } = await import('../src/index.ts')
    const expired = {
      ...promo(),
      schedule: { timezone: 'Asia/Shanghai', validUntil: at - 60_000 },
    } as unknown as WorkBuddyPromo
    expect(hostModelBadgeOf([expired], at)).toEqual({})
  })

  it('sends a single string when the upstream published one wording', async () => {
    const { hostModelBadgeOf } = await import('../src/index.ts')
    const single = {
      ...promo(),
      badge: { label: '限时免费' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '0:00', end: '23:59' }] },
    } as unknown as WorkBuddyPromo
    // `LocalizedText` accepts a plain string; sending `{ en: undefined }` would
    // make the host resolve to "undefined" on the English locale.
    expect(hostModelBadgeOf([single], at)).toEqual({ badge: { text: '限时免费', tone: 'neutral' } })
  })

  it('prefers the highest-priority running promotion', async () => {
    // One badge per model is the host field's limit, so the choice among
    // several running promotions must be deterministic and must be the one the
    // card would draw too.
    const { hostModelBadgeOf } = await import('../src/index.ts')
    const low = {
      ...promo({ color: '#009273' }),
      id: 'low', priority: 10,
      badge: { label: '低', labelEn: 'Low', color: '#009273' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '0:00', end: '23:59' }] },
    } as unknown as WorkBuddyPromo
    const high = {
      ...promo({ color: '#1d63ed' }),
      id: 'high', priority: 90,
      badge: { label: '高', labelEn: 'High', color: '#1d63ed' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '0:00', end: '23:59' }] },
    } as unknown as WorkBuddyPromo
    expect(hostModelBadgeOf([low, high], at)).toEqual({
      badge: { text: { en: 'High', zh: '高' }, tone: 'info' },
    })
  })
})
