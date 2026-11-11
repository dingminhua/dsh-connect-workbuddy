// @vitest-environment jsdom
/**
 * The OPTIONAL sidebar panel (PR #188), made opt-IN.
 *
 * ## Why this suite exists
 *
 * The PR shipped the panel unconditional: every install grew a sidebar row and
 * a `main` page whether the user wanted them or not. That is exactly the class
 * of change this plugin has refused everywhere else (the CLI route, image
 * generation, the video tool, the channel-continue retry — every one of them
 * ships OFF with a switch), and the row is worse than most of them because it
 * claims a GLOBAL seat every installed bundle shares.
 *
 * So the panel is now gated on `Config.sidebarPanel` (default false). This file
 * pins the three things that make that gate real:
 *
 *   DEFAULT   Absent settings read OFF, from the schema AND from both readers.
 *             An upgrade must not re-arrange a sidebar nobody asked to change.
 *   VISIBLE   OFF registers no `sidebar.panellist` entry and no `main` entry —
 *             the row is built from ENTRY METADATA, so a component returning
 *             null would render a blank but still-clickable button. The switch
 *             must also be able to turn it BACK on without a reload, and off
 *             again, which is the store the entry subscribes to.
 *   STICKY    `__save` accepts the field (it is in the closed allow-list) and
 *             both writers verify the value landed, so the switch cannot end up
 *             showing a state the Host never stored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sidebarPanelEnabledOf, writeSidebarPanelEnabled } from '../src/client/account-selection.ts'
import { Config } from '../src/index.ts'
import {
  resetSidebarPanelWanted, setSidebarPanelWanted, sidebarPanelWanted, subscribeSidebarPanelWanted,
} from '../src/client/panel-switch.ts'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
  resetSidebarPanelWanted()
})

/**
 * Source text of one file, for the schema/allow-list assertions.
 *
 * Resolved from `process.cwd()` rather than `import.meta.url`: this suite runs
 * under jsdom, where the module URL is not a `file:` URL.
 */
function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'src', relativePath), 'utf8')
}

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

function signedIn(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'real-1',
    accountName: 'Real One',
    region: 'cn',
    domain: 'www.workbuddy.cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [{ id: 'm-1', name: 'Model One', creditMultiplier: 1 }],
    enabledModelIds: ['m-1'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 100, expiringSoon: 0, packages: [] },
    ...extra,
  }
}

describe('the switch is writable through the card route', () => {
  it('is allowed to be written through the __save route', () => {
    const route = source('web-status.ts')
    const allowList = /const UPSTREAM_SWITCH_FIELDS[\s\S]*?\n\]\)/.exec(route)
    expect(allowList, 'UPSTREAM_SWITCH_FIELDS must still be a closed allow-list').not.toBeNull()
    // A closed allow-list is the whole point: an unlisted field is refused, so
    // the card's writer must have its field listed here or every save 400s.
    expect(allowList?.[0]).toContain("'sidebarPanel'")
  })
})

describe('the schema default of sidebarPanel', () => {
  it('is OFF in the Host schema itself', () => {
    /**
     * Read the SCHEMA's own default, not a hand-built config.
     *
     * `Config({})` cannot answer this: the volatile wrapper hands back a live
     * reference, so the field reads as `{}` whatever the default is. That is
     * exactly why this used to be a regex over `src/index.ts` — and why that
     * regex was worth replacing rather than deleting: it broke on any schema
     * reformatting while saying nothing about behaviour, yet with it gone
     * NOTHING pinned the default. Verified by mutation: flipping `.default(false)`
     * to `.default(true)` left the entire suite green.
     *
     * Schemastery records the default in `meta`, so the declaration can be read
     * as data. One row claims a global sidebar seat shared by every bundle; an
     * absent field has to render no row.
     */
    const declaration = (Config as unknown as {
      dict?: Record<string, { meta?: Record<string, unknown> }>
    }).dict?.['sidebarPanel']
    expect(declaration, 'sidebarPanel must still be declared in Config').toBeDefined()
    expect(declaration?.meta?.['default']).toBe(false)
    // Volatile, or a change would need a plugin reload to take effect — the
    // card writes it through `__save` and expects the row to appear at once.
    expect(declaration?.meta?.['volatile']).toBe(true)
  })
})

describe('the panel-switch store', () => {
  it('starts OFF, notifies on change, and stops after unsubscribe', () => {
    expect(sidebarPanelWanted()).toBe(false)
    const seen: boolean[] = []
    const stop = subscribeSidebarPanelWanted(() => { seen.push(sidebarPanelWanted()) })
    setSidebarPanelWanted(true)
    // Idempotent: the same value must not churn the registrations.
    setSidebarPanelWanted(true)
    setSidebarPanelWanted(false)
    stop()
    setSidebarPanelWanted(true)
    expect(seen).toEqual([true, false])
    expect(sidebarPanelWanted()).toBe(true)
  })

  it('does not let one throwing listener strand the rest', () => {
    const seen: string[] = []
    subscribeSidebarPanelWanted(() => { throw new Error('boom') })
    subscribeSidebarPanelWanted(() => { seen.push('second') })
    expect(() => { setSidebarPanelWanted(true) }).not.toThrow()
    expect(seen).toEqual(['second'])
  })
})

describe('writing the switch', () => {
  it('posts the field to the Host endpoint and mirrors only what it stored', async () => {
    const calls = stubFetch(url => (url.includes('__save')
      ? { body: { ok: true, value: { sidebarPanel: true } } }
      : { body: {} }))
    const scope = fakeScope()
    await writeSidebarPanelEnabled(scope, true)
    const save = calls.find(call => call.url.includes('__save'))
    expect(save, 'the Host endpoint must be tried first').toBeDefined()
    expect(JSON.parse(save?.init.body as string)).toEqual({ field: 'sidebarPanel', value: true })
    // The scope mirrors the AUTHORITATIVE answer, not a client-side re-merge.
    expect(scope.writes.at(-1)).toEqual({ field: 'sidebarPanel', value: true })
  })

  it('falls back to the settings scope when the endpoint refuses', async () => {
    stubFetch(url => (url.includes('__save') ? { status: 500, body: { error: 'nope' } } : { body: {} }))
    const scope = fakeScope()
    await writeSidebarPanelEnabled(scope, true)
    expect(scope.writes.at(-1)).toEqual({ field: 'sidebarPanel', value: true })
  })

  it('throws when NEITHER writer persisted the value', async () => {
    stubFetch(url => (url.includes('__save') ? { status: 500, body: { error: 'nope' } } : { body: {} }))
    const scope = fakeScope({}, true)
    await expect(writeSidebarPanelEnabled(scope, true)).rejects.toThrow(/sidebarPanel/u)
  })
})

async function mountCard(extra: Record<string, unknown>, scopeValue: Record<string, unknown>) {
  stubFetch(url => (url.startsWith(USAGE_PATH) ? { body: signedIn(extra) } : { body: {} }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope(scopeValue), view: 'page' })
  await m.settle()
  return m
}

/**
 * The card's capabilities tab, found the same way `card-panels.spec.tsx` does.
 *
 * Scanned by class plus id rather than a `#id` selector: inside this harness an
 * id selector occasionally resolves to null for an element that is plainly in
 * the tree, while the class query finds it in the same tick.
 */
async function openCapabilities(m: Awaited<ReturnType<typeof mountCard>>) {
  const tab = Array.from(m.container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-panels [role="tab"]'))
    .find(element => element.id === 'dsm-workbuddy-tab-capabilities')
  expect(tab, 'the capabilities tab must exist on a signed-in card').not.toBeUndefined()
  await m.click(tab as HTMLButtonElement)
}

describe('the card switch', () => {
  it('renders UNCHECKED when neither the Host nor the mirror has ever set it', async () => {
    const m = await mountCard({}, {})
    await openCapabilities(m)
    const box = m.container.querySelector('.dsm-workbuddy-sidebar-panel-check') as HTMLInputElement
    expect(box).not.toBeNull()
    expect(box.checked).toBe(false)
  })

  it('echoes the Host answer rather than the (possibly stale) mirror', async () => {
    // The mirror says OFF, the Host says ON: the Host is the authority, the same
    // rule every other Host-carried switch in this card follows.
    const m = await mountCard({ sidebarPanelEnabled: true }, { sidebarPanel: false })
    await openCapabilities(m)
    const box = m.container.querySelector('.dsm-workbuddy-sidebar-panel-check') as HTMLInputElement
    expect(box.checked).toBe(true)
  })

  it('turns the row on through the opt-in store, not just its own checkbox', async () => {
    stubFetch(url => (url.startsWith(USAGE_PATH)
      ? { body: signedIn() }
      : url.includes('__save')
        ? { body: { ok: true, value: { sidebarPanel: true } } }
        : { body: {} }))
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope(), view: 'page' })
    await m.settle()
    await openCapabilities(m)
    const box = m.container.querySelector('.dsm-workbuddy-sidebar-panel-check') as HTMLInputElement
    expect(sidebarPanelWanted()).toBe(false)
    await m.click(box)
    // The entry subscribes to this store; publishing it is what makes the row
    // exist, because the row is built from slot entry metadata.
    expect(sidebarPanelWanted()).toBe(true)
  })
})

describe('the client entry registers the panel only when switched on', () => {
  it('does not register the panel from the always-on slot set', () => {
    const entry = source('client/index.tsx')
    // `registerPanel()` must NOT be spliced into `registerAllSlots`: that set is
    // rebuilt on every settings rebind and never depends on a switch.
    //
    // Comments are stripped first — the removed line's replacement comment says
    // why it is gone, and naming the call there must not read as calling it.
    const allSlots = /const registerAllSlots = \(\): Array<\(\) => void> => \[([\s\S]*?)\]\.filter/.exec(entry)
    expect(allSlots, 'registerAllSlots must keep its array-literal shape').not.toBeNull()
    const body = (allSlots?.[1] ?? '')
      .split('\n')
      .filter(line => !/^\s*(\/\/|\/\*|\*)/u.test(line))
      .join('\n')
    expect(body).not.toContain('registerPanel()')
  })

  it('gates the registration on the store, and seeds it from the Host', () => {
    const entry = source('client/index.tsx')
    // The gate itself.
    expect(entry).toMatch(/if \(!sidebarPanelWanted\(\)\) return/u)
    // The subscription that makes the switch live.
    expect(entry).toContain('subscribeSidebarPanelWanted(syncPanelRegistration)')
    // The Host seed. OFF is the default, so only an explicit `true` may turn it
    // on — a failed read must leave the row absent.
    expect(entry).toContain('document.sidebarPanelEnabled === true')
  })
})
