/**
 * Mapping an upstream promotion colour onto the host's four semantic badge tones.
 *
 * WHAT THIS IS *NOT* FOR (measured, and worth recording so nobody tries again):
 * `LlmModelInfo.badge` exists and the picker does draw it — but a THIRD-PARTY
 * plugin cannot supply it. The host builds that field inside
 * `resolveListedCatalog` from `input.listing`, which comes from
 * `requestModelListing` in `@deepseek-ai/dsh-llm-deepseek` — the OFFICIAL
 * DeepSeek provider's own listing path (`registerDeepSeekProvider`). The
 * discovery channel a third-party plugin registers
 * (`ctx.llm.registerModelDiscovery`) answers `LlmDiscoveredModel`, whose fields
 * are `id / name / contextWindow / maxTokens / inputModalities` — no `badge`,
 * and nothing reads one off it.
 *
 * So a `badge` added to a discovery result is silently dropped. That is what was
 * tried first; the field is not reachable from here.
 *
 * The tone mapping itself stays because it is correct in isolation and is the
 * piece any future surface would need — it is a pure function with no host
 * dependency.
 */
import { describe, expect, it } from 'vitest'
import { promoBadgeTone } from '../src/client/promo-badge.ts'
import type { WorkBuddyPromo } from '../src/promo.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

describe('the channels a third-party plugin does NOT have', () => {
  /**
   * Recorded as an assertion rather than prose, so a future attempt fails fast
   * instead of shipping a field nobody reads.
   *
   * MEASURED ON 0.2.2-rc.1. `LlmModelInfo.badge` exists and the picker renders
   * it — the four-tone Tag is real. But the host builds it inside
   * `resolveListedCatalog` from `input.listing`, and that listing comes from
   * `requestModelListing` in `@deepseek-ai/dsh-llm-deepseek`, i.e. the OFFICIAL
   * provider's listing path. A third-party plugin registers discovery through
   * `ctx.llm.registerModelDiscovery`, whose contract answers
   * `LlmDiscoveredModel` — no `badge` field, and nothing reads one off it.
   *
   * So adding a badge to a discovery result is silently dropped. That is what
   * was tried first; this test is why it will not be tried again by accident.
   */
  it('cannot smuggle a badge through model discovery', () => {
    // Read the declaration out of the installed host rather than trusting a
    // copy pasted into this file.
    const asar = join(
      '/Applications/DeepSeek Harness.app/Contents/Resources',
      'app.asar',
    )
    if (!existsSync(asar)) {
      // A machine without the desktop app still has to pass the suite.
      return
    }
    const raw = readFileSync(asar, 'latin1')
    const at = raw.indexOf('export interface LlmDiscoveredModel')
    expect(at, 'LlmDiscoveredModel is gone — re-read the discovery contract').toBeGreaterThan(-1)
    const declaration = raw.slice(at, at + 240)
    // The moment the host ADDS a badge here, this turns red on purpose: that is
    // when the discovery route becomes viable and the note above stops holding.
    expect(declaration, 'the discovery contract now carries a badge').not.toContain('badge')
    expect(declaration, 'this is not the declaration we recorded').toContain('inputModalities')
  })
})
