/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import {
  WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES,
  WORKBUDDY_SETTINGS_SECTION_ID,
  WORKBUDDY_SETTINGS_SECTION_ORDER,
} from '../src/status-paths.ts'

/**
 * Regression suite for the configuration ENTRY (5.19.0) — the successor to
 * `issue55-card-not-registered.spec.ts`.
 *
 * ## What changed, and why the old suite could not survive
 *
 * The card used to render in the Plugins page's KEYED slots
 * (`plugins.bundle.config` / `plugins.row.config`), looked up by
 * `<package name>`. Issue #55 was that lookup: the page compares the inventory's
 * `pkg.name` by EXACT equality, a deployment is free to mount the same code
 * under an `include:`-prefixed Loader entry id, and a key nobody predicted
 * rendered NOTHING — no section, no placeholder, no error. The fix was to
 * register under every spelling at once.
 *
 * That is a workaround for a contract that keys someone else's slot by OUR
 * name. `settings.section` is a LIST slot keyed by an id THIS plugin owns, so
 * there is no inventory name to agree with and the whole class of mismatch is
 * gone — which is why every "register under both spellings" assertion below was
 * DELETED rather than updated. Keeping them would have pinned a workaround for
 * a slot this plugin no longer touches.
 *
 * What is still worth pinning, and is asserted here:
 *
 * 1. ONE registration, under one stable id, at the declared order.
 * 2. Registration is UNCONDITIONAL — not gated on the settings mirror edge.
 *    That was the second half of #55: `whileServed` fires only on the
 *    unserved→served edge, so a mirror that never reports our namespace left the
 *    page blank with only a console line to show for it.
 * 3. A rebind REPLACES its registrations instead of appending, because the
 *    shell's inject result is cached by entry identity — a stale registration
 *    would keep serving stale props.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages), so — like `client-fallback.spec.ts` — the `apply()` below MIRRORS
 * `src/client/index.tsx`. DRIFT WARNING: it is NOT the product code.
 */

/** A list-slot stub that behaves like `SlotCore`: one entry per (id, priority). */
function listSlots(): {
  register: (options: any, component: unknown) => () => void
  idsOf: (name: string) => string[]
  duplicates: number
} {
  const cells = new Map<string, Map<string, unknown>>()
  let duplicates = 0
  return {
    register(options: any) {
      const cell = cells.get(options.name) ?? new Map<string, unknown>()
      cells.set(options.name, cell)
      const cellKey = `${String(options.key ?? options.id ?? '')}@${String(options.priority ?? 0)}`
      if (cell.has(cellKey)) {
        duplicates += 1
        throw new Error(`list slot "${options.name}" already has an entry for id "${String(options.id)}"`)
      }
      cell.set(cellKey, options)
      return () => { cell.delete(cellKey) }
    },
    idsOf(name: string) {
      return [...(cells.get(name)?.values() ?? [])].map((options: any) => String(options.id))
    },
    get duplicates() { return duplicates },
  }
}

/**
 * Mirror of the registration half of `src/client/index.tsx apply()`.
 *
 * `calls` records every `register()` the entry performs, so a missing
 * registration is distinguishable from a wrong one.
 */
function applyRegistration(ctx: any): {
  sections: string[]
  icons: string[]
  calls: string[]
  duplicates: number
  /** Whether the section registered before the settings mirror said anything. */
  registeredWithoutNamespace: boolean
} {
  const calls: string[] = []
  const slots = listSlots()
  let settingsScope: unknown
  const forms = ctx.get('configForms')

  const registerSettingsSection = (): (() => void) | undefined => {
    try {
      return ctx.slots.inject('settings.section', () => {
        const disposers: Array<() => void> = []
        calls.push('settings.section')
        disposers.push(slots.register({
          name: 'settings.section',
          id: WORKBUDDY_SETTINGS_SECTION_ID,
          order: WORKBUDDY_SETTINGS_SECTION_ORDER,
          inject: () => ({ t: () => '', settingsScope, surface: 'settings' }),
        }, {}))
        const iconInject = ctx.slots.inject('settings.section.icon', () => {
          calls.push('settings.section.icon')
          const off = slots.register({
            name: 'settings.section.icon',
            id: WORKBUDDY_SETTINGS_SECTION_ID,
          }, {})
          disposers.push(off)
          return off
        })
        if (typeof iconInject === 'function') disposers.push(iconInject)
        return () => { for (const dispose of disposers) dispose() }
      })
    } catch {
      return undefined
    }
  }

  let liveDisposers: Array<() => void> = []
  const rebind = (): void => {
    for (const dispose of liveDisposers) dispose()
    liveDisposers = []
    const section = registerSettingsSection()
    liveDisposers = section === undefined ? [] : [section]
  }

  if (forms !== undefined && typeof forms.whileServed === 'function') {
    ctx.effect(() => forms.whileServed(
      WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES,
      (served: ReadonlySet<string>) => {
        const ns = WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES.find(candidate => served.has(candidate))
          ?? [...served].find((entry: string) => /workbuddy/i.test(entry))
        settingsScope = ns === undefined ? undefined : forms.get(ns)
        rebind()
        return () => {
          for (const dispose of liveDisposers) dispose()
          liveDisposers = []
        }
      },
    ), 'dsh-connect-workbuddy: settings namespace binding')
    const before = calls.length
    rebind()
    return {
      sections: slots.idsOf('settings.section'),
      icons: slots.idsOf('settings.section.icon'),
      calls,
      duplicates: slots.duplicates,
      registeredWithoutNamespace: calls.length > before,
    }
  }
  rebind()
  return {
    sections: slots.idsOf('settings.section'),
    icons: slots.idsOf('settings.section.icon'),
    calls,
    duplicates: slots.duplicates,
    registeredWithoutNamespace: true,
  }
}

/** Client context whose `configForms` mirror holds a fixed namespace list. */
function contextWithMirror(namespaces: string[]): any {
  const state = { namespaces }
  return {
    get: (name: string) => name !== 'configForms' ? undefined : {
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: state.namespaces.map(ns => ({ ns })) } }) }),
      get: (ns: string) => ({ ns, getSnapshot: () => ({ status: 'ready', value: {} }) }),
      whileServed: (watched: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        let off: (() => void) | undefined
        const sync = () => {
          const served = new Set(state.namespaces)
          const hit = watched.some(ns => served.has(ns))
          if (hit && off === undefined) off = register(served)
          else if (!hit && off !== undefined) { off(); off = undefined }
        }
        sync()
        return () => { off?.(); off = undefined }
      },
    },
    effect: (run: () => () => void) => { run() },
    locale: { register: () => () => {}, bind: () => () => '' },
    slots: {
      // `run()`'s result IS the disposer — the real `slots.inject` returns it,
      // and a stub that swallowed it would make every registration look
      // un-disposable, hiding the double-registration this suite is about.
      inject: (_name: string, run: () => any) => run(),
      register: (options: any) => {
        throw new Error('the mirror registers through its own stub, not this one')
      },
    },
  }
}

describe('the configuration page is one Settings section', () => {
  it('registers under an id this plugin owns, not a package-name spelling', () => {
    // The whole point of the move. `settings.section` is keyed by an id WE pick,
    // so no inventory name has to agree with it — the failure mode #55 shipped
    // for cannot occur.
    expect(WORKBUDDY_SETTINGS_SECTION_ID).toBe('dsh-connect-workbuddy')
    // The namespace candidates EXIST because a Loader entry id is a deployment
    // detail the Host may spell differently (`include:`-prefixed on the live
    // Desktop profile). This id is the opposite: ours, and spelled once. The
    // candidate list must therefore remain a lookup for the SETTINGS FORM only,
    // never a list of ids to register the page under.
    expect(WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES).toContain('include:dsh-connect-workbuddy')
    expect(WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES.length).toBeGreaterThan(1)
  })

  it('registers exactly ONE section and ONE icon, both under that id', () => {
    const seen = applyRegistration(contextWithMirror(['dsh-connect-workbuddy']))
    expect(seen.sections).toEqual([WORKBUDDY_SETTINGS_SECTION_ID])
    expect(seen.icons).toEqual([WORKBUDDY_SETTINGS_SECTION_ID])
    // The shell renders the glyph with `{ only: row.id }`, so a different id
    // would leave the row wearing the default gear with nothing to re-evaluate.
    expect(seen.icons[0]).toBe(seen.sections[0])
  })

  it('places the section after the shipped pages, before the market', () => {
    // Shipped: account -10, general 0, models 10, plugins 15, agent-presets 20.
    // Observed third-party: opencode-go 20, subagent-default-model 30, market 40,
    // archive-manager 45, better-sidebar 100.
    expect(WORKBUDDY_SETTINGS_SECTION_ORDER).toBeGreaterThan(20)
    expect(WORKBUDDY_SETTINGS_SECTION_ORDER).toBeLessThan(40)
  })

  it('registers even when the settings mirror NEVER reports our namespace', () => {
    // The second half of #55: `whileServed` opens its watch, sees nothing and
    // never fires the edge, so registration that waited for the edge never
    // happened and the page rendered nothing while `apply()` reported success.
    const seen = applyRegistration(contextWithMirror(['some-other-plugin']))
    expect(seen.registeredWithoutNamespace).toBe(true)
    expect(seen.sections).toEqual([WORKBUDDY_SETTINGS_SECTION_ID])
  })

  it('registers on a host with no settings surface at all', () => {
    const ctx: any = {
      get: () => undefined,
      effect: (run: () => () => void) => { run() },
      locale: { register: () => () => {}, bind: () => () => '' },
      slots: { inject: (_n: string, run: () => any) => run(), register: () => (() => {}) },
    }
    // No `configForms` means no form to bind, NOT no page: the page renders
    // read-only (every write control degrades), and the user can still see and
    // manage accounts there.
    const seen = applyRegistration(ctx)
    expect(seen.sections).toEqual([WORKBUDDY_SETTINGS_SECTION_ID])
  })

  it('replaces its registration on rebind instead of appending', () => {
    // The shell caches the inject result by ENTRY IDENTITY, so a late-arriving
    // settings mirror has to produce a FRESH registration. Registering twice
    // without disposing would make the slot service refuse the second one (its
    // own try/catch would swallow that into a console line), leaving the page
    // serving the stale, unbound props — the 4.3.0 defect in a new costume.
    const seen = applyRegistration(contextWithMirror(['dsh-connect-workbuddy']))
    expect(seen.duplicates).toBe(0)
    expect(seen.sections).toHaveLength(1)
  })

  it('documents the list-slot nature of the id it registers', () => {
    // A `list` slot is one entry per `id` per priority, and a second entry at the
    // same priority throws — pinned here so a later refactor that appends instead
    // of replacing fails loudly rather than silently losing the page.
    const slots = listSlots()
    slots.register({ name: 'settings.section', id: WORKBUDDY_SETTINGS_SECTION_ID }, {})
    expect(() => slots.register({ name: 'settings.section', id: WORKBUDDY_SETTINGS_SECTION_ID }, {})).toThrow(/already has an entry/u)
    expect(slots.duplicates).toBe(1)
  })
})
