// @vitest-environment jsdom
/**
 * ISSUE #288, in the card: a degraded directory must SAY SO, and it must not
 * narrow the user's picks.
 *
 * THE REPORT. A rate limit on the upstream (`soft_rate` / `quota_exceeded`)
 * left the model list with one row while the profile still held seven, and
 * nothing on screen said the directory could not be read.
 *
 * WHY THIS NEEDS A RENDERED CARD. The narrowing happened in the card's refresh
 * handler, which re-maps the user's picks onto the fresh roster BY
 * INTERSECTION. With a degraded roster that intersection is an artefact of the
 * refused document, not a fact about the upstream's offer — so the refresh
 * quietly shrank the selection, and the next Save wrote the shrunken list
 * back over the saved directory. A source-level guard cannot see that; only
 * executing the component can.
 *
 * So this file mounts the REAL card, presses the REAL refresh button, and
 * asserts on what the user would see: the rows that are still ticked, the rows
 * that are still listed, and the notice that explains why the list is short.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/**
 * Three rows. `fast-model` is one of the CLI-only rows: the document the
 * app-channel fallback reads does NOT publish it, which is the whole point.
 */
const MODELS = [
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
]

/** A signed-in usage body: three models, two of them enabled. */
function usageOf(): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'global',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'global-1', accountName: 'Global One' }],
    models: MODELS,
    enabledModelIds: ['fast-model', 'hy3'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
  }
}

/**
 * Mount the card and press "Refresh from WorkBuddy".
 *
 * `refresh` answers the refresh route; `usage` answers the status route.
 */
async function render(options: {
  refresh: (url: string, init: any) => { status?: number, body: unknown }
  usage?: () => Record<string, unknown>
}) {
  const scope = fakeScope({ regions: { global: {} } })
  stubFetch((url, init) => {
    if (url.includes('/models/refresh')) return options.refresh(url, init)
    return { body: options.usage?.() ?? usageOf() }
  })
  const m = await mount(WorkBuddyCard, { t, settingsScope: scope, view: 'page' })
  await m.settle()
  const button = m.buttons().find(b => (b.textContent ?? '').includes('row.modelsRefresh'))
  expect(button, 'the refresh button is missing').toBeDefined()
  await m.click(button as Element)
  await m.settle()
  return m
}

/**
 * The names of the rows the card currently shows as TICKED.
 *
 * The rows carry no id attribute — the name in `.dsm-workbuddy-model-name` is
 * what identifies them, and none of the rows in this file declares a credit
 * multiplier, so the name span holds nothing but the name.
 */
function enabledNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.dsm-workbuddy-model'))
    .filter(row => !row.classList.contains('dsm-workbuddy-model-disabled'))
    .map(row => row.querySelector('.dsm-workbuddy-model-name')?.textContent?.trim() ?? '')
}

/** The names of every row the card lists. */
function listedNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.dsm-workbuddy-model'))
    .map(row => row.querySelector('.dsm-workbuddy-model-name')?.textContent?.trim() ?? '')
}

describe('a degraded refresh', () => {
  it('keeps the rows the refused document published, and says which ones', async () => {
    // The app-channel document publishes `hy3` and nothing else; `fast-model`
    // lives in the CLI document, which the rate limit refused. The card must
    // still SHOW `fast-model` — it is the user's model — and must say where it
    // came from.
    const m = await render({
      refresh: () => ({
        body: {
          models: [{ id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 }],
          degraded: {
            missing: 'cli',
            used: 'app',
            reason: 'workbuddy upstream soft_rate (http 429): usage exceeds frequency limit',
            resetAtMs: Date.parse('2026-11-23T01:22:26Z'),
          },
        },
      }),
    })
    expect(listedNames(m.container)).toEqual(['Hy3', 'Fast', 'GLM-5.3'])
    const notice = m.container.querySelector('.dsm-workbuddy-models-degraded')
    expect(notice, 'the degraded-directory notice is missing').not.toBeNull()
    expect(notice?.textContent ?? '').toContain('row.catalogDegraded')
    // The recovery time the upstream stated: the one thing worth showing.
    expect(notice?.textContent ?? '').toContain('row.catalogDegradedReset')
    // And the rows that came from the saved snapshot are NAMED, so the user can
    // tell them apart from the ones this read really returned.
    expect(notice?.textContent ?? '').toContain('row.catalogDegradedCarried')
    expect(notice?.textContent ?? '').toContain('Fast')
  })

  it('does NOT narrow the user\'s picks', async () => {
    // The narrowing was the damage: the picks were re-mapped onto the fresh
    // roster BY INTERSECTION, so a degraded roster silently unticked the
    // models the refused document published — and the next Save wrote that
    // unticked list back. A degraded refresh must leave the picks alone.
    const m = await render({
      refresh: () => ({
        body: {
          models: [{ id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 }],
          degraded: { missing: 'cli', used: 'app', reason: 'rate limited' },
        },
      }),
    })
    const enabled = enabledNames(m.container)
    expect(enabled).toContain('Hy3')
    expect(enabled).toContain('Fast')
  })

  it('still narrows the picks on a COMPLETE refresh', async () => {
    // The other half, and the reason the two cases cannot share one rule: a
    // complete read is the upstream's truth, and a model it no longer lists
    // must stop being offered. Narrowing here is correct — narrowing there
    // was the defect.
    const m = await render({
      refresh: () => ({
        body: {
          models: [{ id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 }],
        },
      }),
    })
    const enabled = enabledNames(m.container)
    expect(enabled).toEqual(['Hy3'])
    expect(listedNames(m.container)).toEqual(['Hy3'])
    // A complete read has nothing to announce.
    expect(m.container.querySelector('.dsm-workbuddy-models-degraded')).toBeNull()
  })
})
