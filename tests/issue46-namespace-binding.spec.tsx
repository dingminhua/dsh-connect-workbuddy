/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
import { WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES } from '../src/status-paths.ts'

/**
 * Regression suite for issue #46 — "对话框积分读数关不掉" (4.3.0).
 *
 * The shipped defect had two halves and this file pins both:
 *
 * 1. The client entry resolved the settings namespace ONCE at `apply` time. The
 *    describe mirror is filled by an async `remote.settings.describe()`, so at
 *    that moment `view` is usually still absent; the old code read the absence
 *    as "the declared name must be right", bound `forms.get('workbuddy')`, and
 *    never looked again. But the settings namespace is the Host's Loader ENTRY
 *    ID (`dsh-connect-workbuddy`), and `ConfigFormController.derive()` matches
 *    it EXACTLY — so the guessed form stayed `unavailable` forever, and the
 *    composer gate read every value as `undefined`.
 *
 * 2. `regionCreditsShownOf` is opt-out (`!== false`), so `undefined` reads as
 *    "shown". Combined with (1): unticking the box wrote `false` correctly and
 *    the readout kept rendering. That is the reported symptom.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages), so — like `client-fallback.spec.ts` — the `apply()` below mirrors
 * `src/client/index.tsx`. DRIFT WARNING: it is NOT the product code. It is kept
 * in sync by hand; if the real entry's binding strategy changes, change it here.
 */

/** A `configForms` stub mimicking the real service's observable behaviour. */
function formsStub(options: {
  /** Namespace spellings the mirror will report, initially served. */
  served?: string[]
  /** When true, the mirror starts EMPTY and populates on the next tick. */
  mirrorLandsLater?: boolean
}): {
  forms: any
  /** Namespaces whose form was actually minted, in order. */
  minted: string[]
  /** Total `whileServed` watches opened. */
  watches: number
  /** Resolve the mirror's contents (used by `mirrorLandsLater`). */
  land: (namespaces: string[]) => void
} {
  const minted: string[] = []
  const state = { namespaces: options.served ?? [] }
  const watchers = new Set<() => void>()
  const out = {
    forms: undefined as any,
    minted,
    watches: 0,
    land(namespaces: string[]) {
      state.namespaces = namespaces
      for (const watcher of watchers) watcher()
    },
  }
  out.forms = {
    describe: () => ({
      getSnapshot: () => ({ view: { namespaces: state.namespaces.map(ns => ({ ns })) } }),
    }),
    // The real `get()` mints a ConfigFormController keyed by the given entry id.
    // A form for a namespace nothing serves never reaches `ready` — `derive()`
    // finds no matching view and pins `unavailable`, which is the defect's
    // second half. We model that with a `minted` list plus a ready flag that
    // only the served id gets.
    get: (ns: string) => {
      minted.push(ns)
      return {
        ns,
        getSnapshot: () => ({
          status: state.namespaces.includes(ns) ? 'ready' : 'unavailable',
          value: state.namespaces.includes(ns) ? { regions: {} } : undefined,
        }),
        subscribe: (_: () => void) => () => {},
        set: async () => true,
      }
    },
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
      out.watches += 1
      let off: (() => void) | undefined
      const sync = () => {
        const served = new Set(state.namespaces)
        const watched = namespaces.some(ns => served.has(ns))
        if (watched && off === undefined) off = register(served)
        else if (!watched && off !== undefined) {
          off()
          off = undefined
        }
      }
      watchers.add(sync)
      sync()
      return () => {
        watchers.delete(sync)
        off?.()
        off = undefined
      }
    },
  }
  if (options.mirrorLandsLater === true) state.namespaces = []
  return out
}

/**
 * Mirror of the namespace-binding half of `src/client/index.tsx apply()`.
 *
 * Returns the slots registered right now, so a test can see whether a
 * namespace arriving late produced FRESH registrations (the fix) or left the
 * stale ones in place (the defect).
 */
function applyBinding(ctx: any): {
  /** Every slot registration made, in order, with the scope it captured. */
  registrations: Array<{ slot: string, scope: any }>
  /** Dispose everything, as the plugin fiber would. */
  dispose: () => void
} {
  const registrations: Array<{ slot: string, scope: any }> = []
  const disposers: Array<() => void> = []
  let liveDisposers: Array<() => void> = []
  let settingsScope: any

  const forms = ctx.get('configForms')
  const namespace = 'settings.workbuddy'

  const registerAllSlots = (): Array<() => void> => {
    // The real entry registers several slots; one suffices to observe the
    // re-registration contract, and the scope each one captured is the point.
    // The Settings section stands in for all of them: it is the seat whose
    // `inject` result the shell caches by entry identity, which is exactly why
    // a late namespace has to produce a FRESH registration.
    ctx.slots.register('settings.section', 'dsh-connect-workbuddy', () => settingsScope === undefined ? {} : { settingsScope })
    registrations.push({ slot: 'settings.section', scope: settingsScope })
    return [() => { registrations.push({ slot: 'disposed', scope: settingsScope }) }]
  }

  if (forms === undefined || typeof forms.whileServed !== 'function') {
    settingsScope = forms?.get('workbuddy')
    liveDisposers = registerAllSlots()
  } else {
    disposers.push(ctx.effect(() => forms.whileServed(
      WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES,
      (served: ReadonlySet<string>) => {
        const ns = WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES.find(candidate => served.has(candidate))
          ?? [...served].find(entry => /workbuddy/i.test(entry))
        settingsScope = ns === undefined ? undefined : forms.get(ns)
        for (const dispose of liveDisposers) dispose()
        liveDisposers = registerAllSlots()
        return () => {
          for (const dispose of liveDisposers) dispose()
          liveDisposers = []
        }
      },
    ), 'dsh-connect-workbuddy: settings namespace binding'))
  }

  void namespace
  return {
    registrations,
    dispose: () => {
      for (const dispose of disposers) dispose()
      for (const dispose of liveDisposers) dispose()
    },
  }
}

/** Minimal client context: `get()`, `effect()`, and a recording slot service. */
function contextWith(forms: any): any {
  const effects: Array<() => void> = []
  const registered: Array<() => void> = []
  return {
    effects,
    registered,
    get: (name: string) => (name === 'configForms' ? forms : undefined),
    // The real fiber runs the callback immediately and disposes it with the
    // plugin, which is what makes the watch live for the page's lifetime.
    effect: (run: () => () => void) => {
      const off = run()
      effects.push(off)
      return off
    },
    slots: {
      register: (_slot: string, _key: string, inject: () => any) => {
        registered.push(inject)
        return () => {}
      },
    },
  }
}

describe('issue #46: the settings namespace is followed, not guessed', () => {
  it('candidate list prefers the real entry ids over the declared name', () => {
    // The declared name is LAST: it is the only spelling that is not a real
    // Loader entry id, kept purely as a last-resort probe.
    expect(WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES[WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES.length - 1])
      .toBe('workbuddy')
    expect(WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES).toContain('dsh-connect-workbuddy')
    expect(WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES).toContain('include:dsh-connect-workbuddy')
  })

  it('binds the ENTRY ID, not the declared name, when the mirror is already populated', () => {
    const stub = formsStub({ served: ['dsh-connect-workbuddy', 'other-plugin'] })
    const ctx = contextWith(stub.forms)
    const { registrations } = applyBinding(ctx)

    // The form the plugin actually bound must be the one the Host serves.
    expect(stub.minted).toEqual(['dsh-connect-workbuddy'])
    expect(registrations[0]?.scope?.getSnapshot().status).toBe('ready')
  })

  it('REBINDS when the mirror lands after apply — the shipped 4.3.0 defect', () => {
    // This is the exact race: `apply` sees no namespaces, the mirror populates
    // a moment later. The old one-shot code stopped at `forms.get('workbuddy')`
    // and every later read was `undefined`.
    const stub = formsStub({ mirrorLandsLater: true })
    const ctx = contextWith(stub.forms)
    const { registrations } = applyBinding(ctx)

    // Nothing was served at apply time, so no form was minted and no slot was
    // registered yet — the watch is what will notice the arrival...
    expect(stub.minted).toEqual([])
    expect(registrations).toEqual([])
    expect(stub.watches).toBe(1)

    // ...the mirror arrives...
    stub.land(['dsh-connect-workbuddy'])

    // ...and the plugin must now be bound to it, with the slots registered.
    // NOTHING was registered before, which is the whole point of the fix: the
    // old code registered against the guessed name and never revisited it.
    expect(stub.minted).toEqual(['dsh-connect-workbuddy'])
    expect(registrations.map(r => r.slot)).toEqual(['settings.section'])
    expect((registrations.at(-1) as any).scope.getSnapshot().status).toBe('ready')
  })

  it('picks the REAL entry id even when the declared name is also served', () => {
    // `whileServed` re-runs `register` on the unserved→served EDGE, so this is
    // the shape that matters: at the moment the watch fires, more than one
    // watched spelling may be present. The CANDIDATE ORDER is what picks the
    // real entry id — the declared name is last on purpose, because binding it
    // is the 4.3.0 defect.
    const stub = formsStub({ served: ['workbuddy', 'dsh-connect-workbuddy'] })
    const ctx = contextWith(stub.forms)
    applyBinding(ctx)
    expect(stub.minted).toEqual(['dsh-connect-workbuddy'])
    expect(stub.minted).not.toContain('workbuddy')
  })

  it('prefers the include:-wrapped id the live Desktop host uses', () => {
    const stub = formsStub({ served: ['workbuddy', 'include:dsh-connect-workbuddy'] })
    applyBinding(contextWith(stub.forms))
    // `dsh-connect-workbuddy` is not served, so the include: form wins — not
    // the bare declared name that happens to also be present.
    expect(stub.minted).toEqual(['include:dsh-connect-workbuddy'])
  })

  it('does not re-register on every mirror notification (no loop)', () => {
    // The real `whileServed` only calls `register` on the edge. This pins that
    // the plugin does not add its own churn on top of a re-fired sync.
    const stub = formsStub({ served: ['dsh-connect-workbuddy'] })
    applyBinding(contextWith(stub.forms))
    const before = stub.minted.length
    stub.land(['dsh-connect-workbuddy'])
    stub.land(['dsh-connect-workbuddy'])
    expect(stub.minted.length).toBe(before)
  })

  it('never mints a form for the declared name when the entry id is served', () => {
    // The defect in one line: `forms.get('workbuddy')` created a form nobody
    // serves, whose reads are permanently `undefined` — and the opt-out rule
    // then reads "shown" forever, which is why the tick did nothing.
    const stub = formsStub({ served: ['include:dsh-connect-workbuddy'] })
    applyBinding(contextWith(stub.forms))
    expect(stub.minted).not.toContain('workbuddy')
    expect(stub.minted).toEqual(['include:dsh-connect-workbuddy'])
  })

  it('falls back to a single declared-name bind when configForms has no whileServed', () => {
    // A pre-`whileServed` host still gets a read-only card rather than none.
    const forms = {
      describe: () => ({ getSnapshot: () => ({ view: undefined }) }),
      get: (ns: string) => ({ ns, getSnapshot: () => ({ status: 'ready', value: { regions: {} } }) }),
    }
    const stub = { minted: [] as string[] }
    const wrapped = {
      ...forms,
      get: (ns: string) => { stub.minted.push(ns); return forms.get(ns) },
    }
    applyBinding(contextWith(wrapped))
    expect(stub.minted).toEqual(['workbuddy'])
  })

  it('withdraws the binding if the Host stops serving the namespace', () => {
    const stub = formsStub({ served: ['dsh-connect-workbuddy'] })
    const ctx = contextWith(stub.forms)
    const { registrations, dispose } = applyBinding(ctx)
    expect(registrations.some(r => r.slot === 'settings.section')).toBe(true)

    const before = registrations.filter(r => r.slot === 'disposed').length
    stub.land([])
    // The registration is torn down, not left pointing at a dead namespace.
    expect(registrations.filter(r => r.slot === 'disposed').length).toBe(before + 1)

    // And disposing the plugin tears the watch down without throwing.
    expect(() => { dispose() }).not.toThrow()
  })

  it('opens exactly ONE watch, so the page does not re-register in a loop', () => {
    const stub = formsStub({ served: ['dsh-connect-workbuddy'] })
    const ctx = contextWith(stub.forms)
    applyBinding(ctx)
    stub.land(['dsh-connect-workbuddy'])
    stub.land(['dsh-connect-workbuddy'])
    expect(stub.watches).toBe(1)
  })
})

describe('issue #46: the composer gate must not read a dead scope as "shown"', () => {
  it('reproduces the symptom: an unserved scope reads as shown', async () => {
    const { regionCreditsShownOf } = await import('../src/status-paths.ts')
    // `forms.get('workbuddy')` on a host serving `dsh-connect-workbuddy`
    // resolves to a form that never reaches `ready`, so its value is undefined.
    // Opt-out semantics then answer "shown" — the readout stays.
    expect(regionCreditsShownOf(undefined, 'cn')).toBe(true)
    expect(regionCreditsShownOf({ regions: {} }, 'cn')).toBe(true)
    // Only an explicit false hides it, which is what the Host writes.
    expect(regionCreditsShownOf({ regions: { cn: { showCreditsInMainUi: false } } }, 'cn')).toBe(false)
  })

  it('the Host answer outranks the scope, so a dead scope cannot resurrect the readout', async () => {
    const { composerCreditsRegionOf } = await import('../src/client/ComposerCreditsGate.tsx')
    const deadScope: any = {
      getSnapshot: () => ({ status: 'unavailable', value: undefined }),
      subscribe: () => () => {},
    }
    const projection = { next: { provider: 'workbuddy' } }

    // Without the Host answer the dead scope says "shown" — the bug.
    expect(composerCreditsRegionOf(projection, deadScope)).toBe('cn')
    // With the Host's `false` the readout is hidden even though the scope is dead.
    expect(composerCreditsRegionOf(projection, deadScope, false)).toBeUndefined()
    // And a Host `true` still shows it, even if the scope (stalely) says false.
    const staleScope: any = {
      getSnapshot: () => ({ status: 'ready', value: { regions: { cn: { showCreditsInMainUi: false } } } }),
      subscribe: () => () => {},
    }
    expect(composerCreditsRegionOf(projection, staleScope, true)).toBe('cn')
    // A non-boolean Host value is "did not say": the scope stays in charge.
    expect(composerCreditsRegionOf(projection, deadScope, undefined)).toBe('cn')
  })

  it('the component hides the readout when the Host reports it hidden', async () => {
    const { hostCreditsShownOf } = await import('../src/client/ComposerCredits.tsx')
    expect(hostCreditsShownOf({ status: 'signed-in', showCreditsInMainUi: false } as any)).toBe(false)
    expect(hostCreditsShownOf({ status: 'signed-in', showCreditsInMainUi: true } as any)).toBe(true)
    // A document that predates the field, and the error variant, both mean
    // "the Host did not say" — not "hidden".
    expect(hostCreditsShownOf({ status: 'error', message: 'x' } as any)).toBeUndefined()
    expect(hostCreditsShownOf({ status: 'signed-in' } as any)).toBeUndefined()
    expect(hostCreditsShownOf(undefined)).toBeUndefined()
  })
})

describe('issue #46: the fix survives a host with no settings surface', () => {
  it('registers no watch and no scope when configForms is absent', () => {
    const ctx = contextWith(undefined)
    const { registrations } = applyBinding(ctx)
    // A read-only host: the card still registers (it degrades to read-only),
    // and nothing throws.
    expect(registrations.length).toBeGreaterThan(0)
    expect(registrations[0]?.scope).toBeUndefined()
  })
})

// Keep the spy import meaningful for future cases without tripping lint.
void vi
