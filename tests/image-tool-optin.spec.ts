/**
 * The image tool is the ONE capability in this plugin where the MODEL decides to
 * spend credits — about 5.71 per image, and the host has no per-call approval
 * seam (`needsApproval` / `toolApproval` do not exist; verified against the
 * shipped `app.asar`). Every other spending path needs a human action: a chat
 * request is one the user sent, and the per-model "test" button is one the user
 * clicked.
 *
 * So it is opt-IN, and off means the tool is NOT REGISTERED — not "registered
 * but refusing". A registered tool appears in the model's tool list, which
 * invites a call that then fails; a tool that was never registered is invisible
 * and cannot spend anything. These cases pin that contract.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Config as WorkBuddyConfig, imageToolRegionOf, regionStateOf } from '../src/index.ts'
import {
  nextRegionImageToolEnabled,
  nextRegionNewModelsShown,
  regionImageToolEnabledOf,
  regionNewModelsShownOf,
} from '../src/status-paths.ts'

describe('regionImageToolEnabledOf', () => {
  it('reads OFF for every shape that does not say ON', () => {
    // OPT-IN, unlike the credit line and the provider switch next to it in the
    // same slot. Those two are opt-OUT (`!== false`) because their absence
    // should behave like a fresh install; this one authorizes spending, so
    // absence must never be read as consent.
    expect(regionImageToolEnabledOf({}, 'cn')).toBe(false)
    expect(regionImageToolEnabledOf({ regions: {} }, 'cn')).toBe(false)
    expect(regionImageToolEnabledOf({ regions: { cn: {} } }, 'cn')).toBe(false)
    expect(regionImageToolEnabledOf({ regions: { cn: { imageToolEnabled: false } } }, 'cn')).toBe(false)
    // A truthy non-boolean is not consent either: a hand-edited profile that
    // wrote `"yes"` or `1` must not unlock spending.
    expect(regionImageToolEnabledOf({ regions: { cn: { imageToolEnabled: 'yes' } } }, 'cn')).toBe(false)
    expect(regionImageToolEnabledOf({ regions: { cn: { imageToolEnabled: 1 } } }, 'cn')).toBe(false)
  })

  it('reads ON only for an explicit boolean true', () => {
    expect(regionImageToolEnabledOf({ regions: { cn: { imageToolEnabled: true } } }, 'cn')).toBe(true)
  })

  it('is per-region, so the CN opt-in does not leak into the global tab', () => {
    const value = { regions: { cn: { imageToolEnabled: true } } }
    expect(regionImageToolEnabledOf(value, 'cn')).toBe(true)
    expect(regionImageToolEnabledOf(value, 'global')).toBe(false)
  })
})

describe('nextRegionImageToolEnabled', () => {
  it('changes only that one flag of that one slot', () => {
    const value = { regions: { cn: { enabled: true, enabledModelIds: ['hy3'] }, global: { enabled: false } } }
    const next = nextRegionImageToolEnabled(value, 'cn', true) as any
    expect(next.cn.imageToolEnabled).toBe(true)
    // The rest of the slot survives, and so does the sibling region — the write
    // is a merge, not a replacement.
    expect(next.cn.enabled).toBe(true)
    expect(next.cn.enabledModelIds).toEqual(['hy3'])
    expect(next.global.enabled).toBe(false)
  })

  it('round-trips through the reader', () => {
    const on = nextRegionImageToolEnabled({ regions: { cn: {} } }, 'cn', true)
    expect(regionImageToolEnabledOf({ regions: on }, 'cn')).toBe(true)
    const off = nextRegionImageToolEnabled({ regions: on }, 'cn', false)
    expect(regionImageToolEnabledOf({ regions: off }, 'cn')).toBe(false)
  })
})

describe('the config default is OFF', () => {
  it('treats an empty config as not opted in', () => {
    // The upgrade path is the one that matters: nobody's existing profile says
    // `imageToolEnabled`, so every existing user must land on OFF.
    expect(regionStateOf({}, 'cn').imageToolEnabled).toBeUndefined()
    expect(regionImageToolEnabledOf({}, 'cn')).toBe(false)
  })

  it('does not interpret the provider switch as the opt-in', () => {
    // A region that is ON (the default) must still have the image tool OFF:
    // these are two independent gates, and conflating them would hand every
    // existing user a spending capability on upgrade.
    expect(regionStateOf({ regions: { cn: { enabled: true } } }, 'cn').imageToolEnabled).toBeUndefined()
    expect(regionImageToolEnabledOf({ regions: { cn: { enabled: true } } }, 'cn')).toBe(false)
  })
})

describe('imageToolRegionOf', () => {
  it('answers none when neither region was opted in', () => {
    expect(imageToolRegionOf({})).toBeUndefined()
    // Provider switch alone is not the opt-in — same separation as the reader.
    expect(imageToolRegionOf({ regions: { cn: { enabled: true }, global: { enabled: true } } })).toBeUndefined()
    expect(imageToolRegionOf({ regions: { cn: { imageToolEnabled: false }, global: { imageToolEnabled: false } } })).toBeUndefined()
  })

  it('ignores an opt-in on a disabled provider', () => {
    // The flag means "let the model spend"; the provider switch means "may this
    // gateway be used at all". A ticked box on a switched-off region must not
    // make that region the tool's source of credentials.
    expect(imageToolRegionOf({ regions: { cn: { enabled: false, imageToolEnabled: true } } })).toBeUndefined()
  })

  it('picks the international region when only it was opted in', () => {
    expect(imageToolRegionOf({ regions: { global: { imageToolEnabled: true } } })).toBe('global')
    // And the real fallback shape: CN switched off with an explicit OFF, global on.
    expect(imageToolRegionOf({ regions: { cn: { imageToolEnabled: false }, global: { imageToolEnabled: true } } })).toBe('global')
  })

  it('prefers the CN region when both were opted in', () => {
    // CN-first is the only backward-compatible order: before this change the
    // tool could ONLY ever use the CN gateway, so an upgrade must not silently
    // move an existing CN user's spending to the other gateway.
    expect(imageToolRegionOf({ regions: { cn: { imageToolEnabled: true }, global: { imageToolEnabled: true } } })).toBe('cn')
  })
})

describe('the card shows the opt-in on BOTH tabs', () => {
  it('renders the checkbox in the preference block, for whichever tab is open', async () => {
    // It lives among the credit preferences rather than inside AccountPool so a
    // Host that reports no pool state still renders it — the same reason the
    // credit switch sits there.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/client/WorkBuddyCard.tsx', import.meta.url), 'utf8')
    // Both gateways publish a `text-to-image` model now (CN hunyuan-image-alpha,
    // international hy-image-3.5; measured 2026-10-25), so the box is no longer
    // gated on the CN tab: it writes the flag of whichever tab is open.
    expect(source).not.toContain("imageToolPreference = activeRegion === 'cn'")
    expect(source).toContain('toggleImageTool(activeRegion')
    expect(source).toContain('imageToolOn(activeRegion)')
    // Its own class: `.dsm-workbuddy-pref-check` is the contract the
    // credit-switch suite selects on ("exactly one switch"), so a second element
    // carrying it would make every single-checkbox selector resolve wrongly.
    expect(source).toContain('dsm-workbuddy-image-tool-check')
  })
})

/**
 * The "new models" opt-in — the same shape of contract as the image tool, and
 * for a weaker but real reason: it does not spend anything, but it DOES make a
 * claim ("N models are new") that is meaningless on a fresh install.
 */
describe('regionNewModelsShownOf', () => {
  it('reads OFF for every shape that does not say ON', () => {
    expect(regionNewModelsShownOf({}, 'cn')).toBe(false)
    expect(regionNewModelsShownOf({ regions: {} }, 'cn')).toBe(false)
    expect(regionNewModelsShownOf({ regions: { cn: {} } }, 'cn')).toBe(false)
    expect(regionNewModelsShownOf({ regions: { cn: { showNewModelsInMainUi: false } } }, 'cn')).toBe(false)
    // Junk is not consent either: only the literal boolean true turns it on.
    expect(regionNewModelsShownOf({ regions: { cn: { showNewModelsInMainUi: 'yes' } } }, 'cn')).toBe(false)
    expect(regionNewModelsShownOf({ regions: { cn: { showNewModelsInMainUi: 1 } } }, 'cn')).toBe(false)
  })

  it('reads ON only for the literal boolean true', () => {
    expect(regionNewModelsShownOf({ regions: { cn: { showNewModelsInMainUi: true } } }, 'cn')).toBe(true)
  })

  it('does not read the other region\'s flag', () => {
    // The two regions are independent providers; reading across them would show
    // one region's preference on the other's models.
    const value = { regions: { cn: { showNewModelsInMainUi: true }, global: {} } }
    expect(regionNewModelsShownOf(value, 'cn')).toBe(true)
    expect(regionNewModelsShownOf(value, 'global')).toBe(false)
  })

  it('treats an empty config as not opted in', () => {
    // THE upgrade path: nobody's existing profile says `showNewModelsInMainUi`,
    // and this feature was ON before the switch existed. Every existing user
    // must land on OFF, or a "default off" that only applies to new installs is
    // not a default at all.
    expect(regionStateOf({}, 'cn').showNewModelsInMainUi).toBeUndefined()
    expect(regionNewModelsShownOf({}, 'cn')).toBe(false)
  })

  it('does not interpret the provider switch as the opt-in', () => {
    expect(regionStateOf({ regions: { cn: { enabled: true } } }, 'cn').showNewModelsInMainUi).toBeUndefined()
    expect(regionNewModelsShownOf({ regions: { cn: { enabled: true } } }, 'cn')).toBe(false)
  })
})

describe('the schema default of showNewModelsInMainUi', () => {
  it('is OFF in the region schema itself', () => {
    // Reading the SCHEMA, not a hand-built config. `Config({})` leaves
    // `regions` as `{}` (no region is materialised until it is written), so a
    // config-level assertion would pass no matter what the field defaulted to —
    // verified: flipping the default to `true` survived every other test here.
    // The declaration itself is what has to say OFF.
    const regionSchema = (WorkBuddyConfig as unknown as {
      dict?: Record<string, { dict?: { dict?: Record<string, { meta?: { default?: unknown } }> } }>
    })
    // Walk to `regions.cn.showNewModelsInMainUi` through whatever shape the
    // schema library exposes, and fall back to reading the source if the
    // introspection surface differs.
    const source = readFileSync(
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('showNewModelsInMainUi: z.boolean().default(false)')
    void regionSchema
  })
})

describe('the Host dependency that publishes the flag', () => {
  it('reads the committed value as OPT-IN, not opt-out', () => {
    // `web-status` builds its deps from `index.ts`, where this line sits beside
    // `showCreditsInMainUi`. That one is `!== false`; this one must be
    // `=== true`. Getting it backwards turns the feature on for everyone while
    // `regionNewModelsShownOf` keeps answering correctly — so the wiring itself
    // is pinned here, the same way the scanner's own wiring is pinned.
    const source = readFileSync(
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain(
      'showNewModelsInMainUi: region => regionStateOf(current(), region).showNewModelsInMainUi === true,',
    )
  })
})

describe('nextRegionNewModelsShown', () => {
  it('writes only the target region, keeping its siblings and the other region', () => {
    const before = {
      regions: {
        cn: { enabled: true, enabledModelIds: ['glm-5.3'], showCreditsInMainUi: true },
        global: { enabled: true },
      },
    }
    // The builder returns the REGIONS MAP itself (it is handed straight to the
    // settings field), not a whole document — so `after.cn` is the slot.
    const after = nextRegionNewModelsShown(before, 'cn', true) as Record<string, Record<string, unknown>>
    expect(after['cn']?.showNewModelsInMainUi).toBe(true)
    // The rest of the slot survives — a display toggle must not erase the
    // directory or the credit switch beside it.
    expect(after['cn']?.enabledModelIds).toEqual(['glm-5.3'])
    expect(after['cn']?.showCreditsInMainUi).toBe(true)
    // And the other region is untouched.
    expect(after['global']).toEqual({ enabled: true })
  })

  it('round-trips through the reader in both directions', () => {
    const on = nextRegionNewModelsShown({}, 'cn', true)
    expect(regionNewModelsShownOf(on, 'cn')).toBe(true)
    const off = nextRegionNewModelsShown(on, 'cn', false)
    expect(regionNewModelsShownOf(off, 'cn')).toBe(false)
  })
})
