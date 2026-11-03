/**
 * Issues #114 and #115: the saved model directory and the live upstream
 * roster.
 *
 * THE ONE DEFECT, TWO FACES. `lastCatalog` — the user's saved selection of
 * models — used to SUPPRESS the live roster entirely: a non-empty saved
 * directory was the only roster the runtime ever served, and the only thing
 * that wrote it was the card's explicit save. So:
 *
 *   - #115: a model the upstream added (`deepseek-v4.1-flash` on the CN
 *     roster) could never reach the user, no matter how many times the card
 *     refreshed — the refresh produced a DRAFT, and saving wrote the SAVED
 *     directory back;
 *   - #114: the saved directory had been seeded with the STATIC FALLBACK
 *     TABLE, which declares no `reasoning` block at all — so every model in
 *     it published with `reasoning: false` and the host offered exactly
 *     `Default` and `Off`.
 *
 * The fix has two halves, and this file pins both:
 *
 *   - the READ side serves the live roster, with the saved directory's own
 *     models kept (`resolveRoster`, `mergeRoster`);
 *   - the WRITE side heals the saved directory
 *     (`repairedCatalog`, `isUnconfiguredFallbackSnapshot`).
 *
 * @module dsh-connect-workbuddy/tests/catalog-sync
 */

import { describe, expect, it } from 'vitest'
import {
  catalogFingerprint,
  isUnconfiguredFallbackSnapshot,
  mergeRoster,
  overlayLiveCapabilities,
  repairedCatalog,
  resolveRoster,
} from '../src/catalog-sync.ts'
import { FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_MODELS_GLOBAL } from '../src/catalog.ts'
import { workBuddyThinkingLevelMap } from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/** One live upstream entry, as `parseUpstreamModel` builds it. */
function live(
  id: string,
  extra: Partial<WorkBuddyModelInfo> = {},
): WorkBuddyModelInfo {
  return {
    id,
    name: id,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    ...extra,
  }
}

/** The reasoning block issue #114 is about: a model that DOES declare tiers. */
const REASONING = {
  supportedEfforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
  canDisableThinking: false,
}

describe('resolveRoster: the live roster is the truth, the saved directory is the selection', () => {
  it('serves a model the upstream added, which the saved directory never named', () => {
    // #115's exact shape: the saved directory holds the old roster, the
    // upstream has added `deepseek-v4.1-flash`.
    const saved = [
      { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
      { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, maxTokens: 50_000 },
    ]
    const liveRoster = [
      live('hy3'),
      live('deepseek-v4-flash'),
      live('deepseek-v4.1-flash', { reasoning: REASONING }),
    ]
    const roster = resolveRoster(saved, liveRoster, 'cn')
    expect(roster.map(model => model.id)).toContain('deepseek-v4.1-flash')
    // The OLD behaviour would have served the saved directory alone.
    expect(saved.map(model => model.id)).not.toContain('deepseek-v4.1-flash')
  })

  it('keeps a saved model the upstream withdrew, because the user may still be on it', () => {
    // Issue #32's rule: a refresh must never withdraw a model the user is
    // running. The saved directory is where that knowledge lives.
    const saved = [{ id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 1_000_000, maxTokens: 64_000 }]
    const liveRoster = [live('hy3')]
    const roster = resolveRoster(saved, liveRoster, 'cn')
    expect(roster.map(model => model.id)).toEqual(['hy3', 'minimax-m2.7'])
  })

  it('falls back to the saved directory when the upstream is unreachable', () => {
    const saved = [{ id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 }]
    expect(resolveRoster(saved, [], 'cn').map(model => model.id)).toEqual(['hy3'])
  })

  it('falls back to the static table only when nothing was ever saved', () => {
    const roster = resolveRoster([], [], 'cn')
    expect(roster.map(model => model.id)).toEqual(FALLBACK_WORKBUDDY_MODELS.map(model => model.id))
  })

  it('never serves a router, on any of the three paths', () => {
    const saved = [{ id: 'auto', name: 'Auto', contextWindow: 256_000, maxTokens: 32_000 }]
    expect(resolveRoster(saved, [], 'cn').map(model => model.id)).not.toContain('auto')
    expect(resolveRoster([], [live('auto')], 'cn').map(model => model.id)).not.toContain('auto')
  })
})

describe('the load level never reaches the card\'s directory', () => {
  it('drops it by default', () => {
    // The card's directory is what the pool's trimmed catalog is built from,
    // and that catalog never shipped a `busyLevel` field. Load is a fact
    // about THIS MINUTE and is deliberately never persisted (`src/busy.ts`),
    // and the card reads the badge from a separate map (`liveBusyLevels`) —
    // so a directory that carried one would give the card two sources for the
    // same badge that could disagree.
    const liveRoster = [live('hy3', { busyLevel: 'busy' })]
    const roster = resolveRoster([], liveRoster, 'cn')
    expect(roster[0]?.busyLevel).toBeUndefined()
    // The key must be GONE, not `undefined`: an explicit `undefined` property
    // survives `structuredClone` and the settings write path's strict JSON
    // codec rejects the whole save.
    expect('busyLevel' in (roster[0] as object)).toBe(false)
  })

  it('keeps it when the runtime asks for it', () => {
    // The RUNTIME roster is where the model picker's badge lives.
    const liveRoster = [live('hy3', { busyLevel: 'busy' })]
    const roster = resolveRoster([], liveRoster, 'cn', { keepLoadLevel: true })
    expect(roster[0]?.busyLevel).toBe('busy')
  })
})

describe('overlayLiveCapabilities: the live roster owns the capability fields', () => {
  it('gives a saved entry the live entry\'s reasoning block', () => {
    // #114's exact shape: the saved entry carries NO reasoning (it came from
    // the static fallback table), the live entry declares the tiers.
    const saved = { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000 }
    const liveEntry = live('deepseek-v4.1-flash', { reasoning: REASONING })
    const merged = overlayLiveCapabilities(saved, liveEntry)
    expect(merged.reasoning).toEqual(REASONING)
    // The bug's observable effect, asserted through the real predicate.
    expect(workBuddyThinkingLevelMap(saved)).toBeUndefined()
    expect(workBuddyThinkingLevelMap(merged)).not.toBeUndefined()
  })

  it('gives a saved entry the live entry\'s credit multiplier', () => {
    // A stale multiplier is a wrong PRICE shown to the user.
    const saved = { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, creditMultiplier: 0.05 }
    const merged = overlayLiveCapabilities(saved, live('hy3', { creditMultiplier: 0.79 }))
    expect(merged.creditMultiplier).toBe(0.79)
  })

  it('leaves a saved entry alone when the live roster does not know it', () => {
    // A model the upstream withdrew keeps whatever the saved entry said —
    // there is nothing better to say about it.
    const saved = { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 1_000_000, maxTokens: 64_000 }
    expect(overlayLiveCapabilities(saved, undefined)).toBe(saved)
  })

  it('does not carry a load level across — it is a fact about this minute', () => {
    const saved = { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 }
    const merged = overlayLiveCapabilities(saved, live('hy3', { busyLevel: 'busy' }))
    expect(merged.busyLevel).toBeUndefined()
  })
})

describe('mergeRoster: the live roster leads, the saved directory follows', () => {
  it('keeps the live roster\'s order and appends the kept models', () => {
    const saved = [{ id: 'b', name: 'B', contextWindow: 1, maxTokens: 1 }, { id: 'a', name: 'A', contextWindow: 1, maxTokens: 1 }]
    const liveRoster = [live('a'), live('b'), live('c')]
    expect(mergeRoster(saved, liveRoster).map(model => model.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not duplicate a model that is in both', () => {
    const saved = [{ id: 'a', name: 'A', contextWindow: 1, maxTokens: 1 }]
    const merged = mergeRoster(saved, [live('a'), live('a')])
    expect(merged.map(model => model.id)).toEqual(['a'])
  })
})

describe('repairedCatalog: the write-back half', () => {
  it('puts a newly added upstream model into the directory', () => {
    const saved = [{ id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 }]
    const repaired = repairedCatalog(saved, [live('hy3'), live('deepseek-v4.1-flash', { reasoning: REASONING })])
    expect(repaired.map(model => model.id)).toEqual(['hy3', 'deepseek-v4.1-flash'])
  })

  it('keeps the user\'s own model the upstream withdrew', () => {
    const saved = [{ id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 1_000_000, maxTokens: 64_000 }]
    const repaired = repairedCatalog(saved, [live('hy3')])
    expect(repaired.map(model => model.id)).toContain('minimax-m2.7')
  })

  it('carries the live capabilities into the repaired directory', () => {
    const saved = [{ id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 }]
    const repaired = repairedCatalog(saved, [live('hy3', { reasoning: REASONING })])
    expect(repaired[0]?.reasoning).toEqual(REASONING)
  })
})

describe('isUnconfiguredFallbackSnapshot: the seeded placeholder is not a selection', () => {
  it('recognises the CN static table', () => {
    expect(isUnconfiguredFallbackSnapshot(FALLBACK_WORKBUDDY_MODELS, 'cn')).toBe(true)
  })

  it('recognises the global static table', () => {
    expect(isUnconfiguredFallbackSnapshot(FALLBACK_WORKBUDDY_MODELS_GLOBAL, 'global')).toBe(true)
  })

  it('does NOT mistake the global table for the CN one', () => {
    // The two regions expose different rosters, and a CN slot must never be
    // healed from the international table.
    expect(isUnconfiguredFallbackSnapshot(FALLBACK_WORKBUDDY_MODELS_GLOBAL, 'cn')).toBe(false)
  })

  it('does not mistake a real saved directory for the placeholder', () => {
    // A directory that carries `reasoning` was not seeded from the fallback
    // table — it is the user's own and must not be thrown away.
    const saved = FALLBACK_WORKBUDDY_MODELS.map(model => ({ ...model, reasoning: REASONING }))
    expect(isUnconfiguredFallbackSnapshot(saved, 'cn')).toBe(false)
  })

  it('keeps a saved directory that carries PRICES but no reasoning (issue #214)', () => {
    // The card's save writes whatever a live refresh produced, and a refresh
    // can legitimately answer prices without any `reasoning` block. Before
    // issue #214 this predicate only tested `reasoning`, so such a directory
    // matched the placeholder by id list and was REPLACED by the live roster —
    // silently deleting the prices the user had just saved. It must read as a
    // real directory.
    const saved = FALLBACK_WORKBUDDY_MODELS_GLOBAL.map(model => ({ ...model, creditMultiplier: 0.5 }))
    expect(isUnconfiguredFallbackSnapshot(saved, 'global')).toBe(false)
  })

  it('does not mistake a differently-named roster for the placeholder', () => {
    const saved = FALLBACK_WORKBUDDY_MODELS.map(model => ({ ...model, id: `${model.id}-x` }))
    expect(isUnconfiguredFallbackSnapshot(saved, 'cn')).toBe(false)
  })
})

describe('catalogFingerprint: the repair writes only when something actually differs', () => {
  it('ignores a load level and a promo badge', () => {
    // Neither is persisted, so a directory differing only in them is already
    // in agreement and must not be rewritten.
    const base = live('hy3', { reasoning: REASONING })
    const decorated = live('hy3', { reasoning: REASONING, busyLevel: 'busy' })
    expect(catalogFingerprint([base])).toBe(catalogFingerprint([decorated]))
  })

  it('sees a capability difference', () => {
    const base = live('hy3', { reasoning: REASONING })
    const changed = live('hy3', { reasoning: { ...REASONING, defaultEffort: 'max' } })
    expect(catalogFingerprint([base])).not.toBe(catalogFingerprint([changed]))
  })

  it('sees an id difference', () => {
    expect(catalogFingerprint([live('a')])).not.toBe(catalogFingerprint([live('b')]))
  })
})

describe('promotions are LIVE-owned (issue #139 follow-up)', () => {
  const nightPromo = {
    id: 'glm-52-night-discount-202607',
    source: 'promotion' as const,
    modelIds: ['hy3'],
    badge: { label: '夜间折扣', display: 'activeOnly' as const },
    schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
    priority: 200,
  }

  it('keeps the LIVE promotions when the saved entry carries none', () => {
    // Observed defect: a user who had ever saved the directory had `promos`
    // written into `lastCatalog`; a model whose saved entry predates the
    // promotion (or whose entry simply had none) then DROPPED the live
    // promotions, so a model on a night discount drew no badge at all.
    const merged = mergeRoster([live('hy3')], [live('hy3', { promos: [nightPromo] })])
    expect(merged[0]?.promos?.map(promo => promo.id)).toEqual([nightPromo.id])
  })

  it('replaces a STALE saved promotion with the live one', () => {
    // The other direction, and the one that made a badge lie: the saved copy
    // described the hours the upstream published at SAVE time, so a campaign
    // whose window had since moved kept advertising the old hours. A badge is
    // a function of the clock, not of the save.
    const stale = { ...nightPromo, id: 'old-hours', schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '22:00', end: '6:00' }] } }
    const merged = mergeRoster(
      [live('hy3', { promos: [stale] })],
      [live('hy3', { promos: [nightPromo] })],
    )
    expect(merged[0]?.promos?.map(promo => promo.id)).toEqual([nightPromo.id])
  })

  it('CLEARS a saved promotion the upstream no longer publishes', () => {
    // A standing entry (no schedule, e.g. the tier badge) has no absolute
    // window to expire it on its own, so keeping the saved copy would leave
    // 「订阅优先」/「Pro Only」 on the row forever after the upstream withdrew it.
    // The key is DELETED, not set to undefined: an explicit undefined survives
    // structuredClone and the settings write's strict JSON codec rejects the
    // whole save.
    const merged = mergeRoster([live('hy3', { promos: [nightPromo] })], [live('hy3')])
    expect(merged[0]?.promos).toBeUndefined()
    expect('promos' in (merged[0] ?? {})).toBe(false)
  })

  it('invents no promos key when neither side has one', () => {
    const merged = mergeRoster([live('hy3')], [live('hy3')])
    expect('promos' in (merged[0] ?? {})).toBe(false)
  })

  it('does the same through overlayLiveCapabilities directly', () => {
    const withLive = overlayLiveCapabilities(live('hy3'), live('hy3', { promos: [nightPromo] }))
    expect(withLive.promos?.map(promo => promo.id)).toEqual([nightPromo.id])
    const cleared = overlayLiveCapabilities(live('hy3', { promos: [nightPromo] }), live('hy3'))
    expect('promos' in cleared).toBe(false)
  })
})
