/**
 * Mapping an upstream promotion colour onto the host's four semantic badge tones.
 *
 * WHICH ROUTES REACH `LlmModelInfo.badge` (measured on 0.2.2-rc.1, corrected
 * after the first version of this note got it wrong):
 *
 * - `ctx.llm.registerModelDiscovery` — NO. Its contract answers
 *   `LlmDiscoveredModel` (`id / name / contextWindow / maxTokens /
 *   inputModalities`), which has no `badge` field and nothing reads one off it.
 *   A badge added there is silently dropped. That is what was tried first, and
 *   the assertion at the bottom of this file still pins it.
 * - the ADAPTER's own `listModels()` — YES. `LlmRuntime.listModels` normalizes
 *   whatever the adapter returned and keeps `badge`, and `buildModelCatalog`
 *   copies it onto the wire. `PiAiAdapter.listModels` does not emit one, so a
 *   subclass has to override it; `src/adapter.ts` does exactly that. This is the
 *   route `docs/MODEL-LABEL-SPEC.md` documents for every connector.
 *
 * The tone mapping is needed by that second route, which is why it moved to
 * `src/promo.ts`: the host half cannot import from `src/client/`.
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

describe('the channel that still does NOT work: model discovery', () => {
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
   * was tried first. The ADAPTER route (`listModels`, see the header) does work
   * and is what this plugin uses; this test only pins that the discovery route
   * is still a dead end, so nobody re-attempts it by accident.
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
