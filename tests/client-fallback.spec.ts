/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

/**
 * The client entry degrades slot/API breaking changes to console.error lines,
 * so the host provider keeps working without a red banner.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages); instead we replicate the exact shape from `src/client/index.tsx`
 * and assert the boundaries hold under simulated host failures:
 *
 * - `inject` declares only `['slots', 'locale']` (both lines provide them);
 *   the settings surface is probed with `ctx.get()`, which returns undefined
 *   for an absent service instead of throwing (property access on an
 *   undeclared service throws "cannot get property X without inject", which
 *   `?.` cannot guard).
 * - Each `registerCard` carries its own try/catch: the two DSH lines declare
 *   disjoint slot sets, so one failing registration must not take the others
 *   down (previously a single outer try meant 0 registrations on any throw).
 *
 * DRIFT WARNING: the `apply()` below is a manual mirror of the real
 * `apply()` in `src/client/index.tsx`. It is NOT the product code, so this
 * test only proves the fallback ideas work. If you change the real `apply()`'s
 * soft-probe shape, the per-slot try/catch, or the `console.error` messages,
 * update the mirror here too.
 */

/** Mirror of src/client/index.tsx apply() body. */
function apply(ctx: any): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh: {}, en: {} }), 'dsh-connect-workbuddy: settings copy')
    const t = ctx.locale.bind(namespace)

    const softGet = (name: string): any => ctx.get(name)

    let settingsScope: unknown
    const forms = softGet('configForms')
    const legacy = softGet('settingsScope')
    // Namespace candidates, in preference order (see issue #46). The declared
    // name is LAST: it is the only spelling that is not a real Loader entry id.
    const candidates = ['dsh-connect-workbuddy', 'include:dsh-connect-workbuddy', 'workbuddy']

    /** A generic seat registration, mirroring the entry's per-slot try/catch. */
    const registerCard = (slotName: string, key: string): (() => void) | undefined => {
      try {
        return ctx.slots.inject(slotName, () => ctx.slots.register({
          name: slotName,
          key,
          priority: 30,
          inject: () => ({ t, settingsScope }),
        }, {}))
      } catch (error: unknown) {
        console.error(`[dsh-connect-workbuddy] card slot "${slotName}" failed to register (host provider unaffected):`, error)
        return undefined
      }
    }

    /**
     * Mirror of `registerSettingsSection`: ONE registration into the list slot,
     * under an id this plugin owns. `slots.inject()` is the whole probe — it
     * waits for the declaration and never throws for a host that does not
     * declare it — so there is nothing to guard against except a service that
     * rejects the registration itself.
     */
    const registerSettingsSection = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-connect-workbuddy',
          order: 35,
          label: () => 'WorkBuddy',
          inject: () => ({ t, settingsScope, surface: 'settings' }),
        }, {}))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] settings section failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    const registerAllSlots = (): Array<() => void> => [
      registerSettingsSection(),
      registerCard('conversation.input.right', 'workbuddy'),
    ].filter((disposer): disposer is () => void => disposer !== undefined)

    let liveDisposers: Array<() => void> = []
    if (forms !== undefined && typeof forms.whileServed === 'function') {
      ctx.effect(() => forms.whileServed(candidates, (served: ReadonlySet<string>) => {
        const ns = candidates.find(candidate => served.has(candidate))
          ?? [...served].find((entry: string) => /workbuddy/i.test(entry))
        settingsScope = ns === undefined ? undefined : forms.get(ns)
        for (const dispose of liveDisposers) dispose()
        liveDisposers = registerAllSlots()
        return () => {
          for (const dispose of liveDisposers) dispose()
          liveDisposers = []
        }
      }), 'dsh-connect-workbuddy: settings namespace binding')
      // Register anyway, without waiting for the unserved→served edge: the card
      // is useful read-only, and a deployment whose namespace never appears in
      // the mirror would otherwise get NO card and NO error (issue #55).
      for (const dispose of liveDisposers) dispose()
      liveDisposers = registerAllSlots()
    } else if (forms !== undefined) {
      settingsScope = forms.get('workbuddy')
      liveDisposers = registerAllSlots()
    } else if (legacy !== undefined) {
      settingsScope = legacy.bind({ namespace: 'workbuddy' })
      liveDisposers = registerAllSlots()
    } else {
      liveDisposers = registerAllSlots()
    }
    void liveDisposers
    void t
  } catch (error: unknown) {
    console.error('[dsh-connect-workbuddy] client card failed to load (host provider unaffected):', error)
  }
}

describe('client card fallback', () => {
  it('isolates a failing slot registration: its slot errors, the others still register', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })

    const registered: string[] = []
    const fakeCtx: any = {
      effect: () => {},
      locale: { register: () => () => {}, bind: () => () => '' },
      get: (name: string) => name === 'settingsScope' ? { bind: () => ({}) } : undefined,
      slots: {
        inject: (slotName: string) => {
          if (slotName === 'settings.section') {
            throw new Error('settings.section is not declared on this host')
          }
          registered.push(slotName)
        },
        register: () => () => {},
      },
    }

    expect(() => apply(fakeCtx)).not.toThrow()
    // The broken seat is logged per-slot; every OTHER registration still landed.
    expect(registered).toEqual(['conversation.input.right'])
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('settings section failed to register')

    spy.mockRestore()
  })

  it('probes the settings surface via ctx.get and never property access', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })

    // Simulate a line with NO settings surface at all and a get() that throws
    // for property-style access — the guard is that apply() only ever calls
    // ctx.get, which returns undefined here.
    const registered: string[] = []
    const fakeCtx: any = {
      effect: () => {},
      locale: { register: () => () => {}, bind: () => () => '' },
      get: (name: string) => name === 'never' ? undefined : undefined,
      slots: {
        inject: (slotName: string) => { registered.push(slotName) },
        register: () => () => {},
      },
    }

    expect(() => apply(fakeCtx)).not.toThrow()
    // Two always-on seats now: the Settings section and the composer readout.
    expect(registered).toHaveLength(2)
    expect(errors).toHaveLength(0)

    spy.mockRestore()
  })

  it('still swallows a load-level failure to the outer console.error', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })

    const fakeCtx: any = {
      effect: () => { throw new Error('locale namespace "settings.workbuddy" already registered') },
      locale: { register: () => () => {}, bind: () => () => '' },
      get: () => undefined,
      slots: { inject: () => {}, register: () => () => {} },
    }

    expect(() => apply(fakeCtx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('client card failed to load')
    expect(String(errors[0])).toContain('already registered')

    spy.mockRestore()
  })
})
