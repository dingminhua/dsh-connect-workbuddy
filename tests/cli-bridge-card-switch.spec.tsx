// @vitest-environment jsdom
/**
 * The CLI-route SWITCH, card side: the global opt-in that mounts `codebuddy_ask`
 * and `/codebuddy`, or mounts nothing at all.
 *
 * Why this is its own suite rather than a line in `cli-bridge.spec.ts`: that
 * file pins what the route DOES once it is mounted. This one pins the thing a
 * user actually touches — a checkbox that must be OFF by default, must read a
 * COMMITTED value rather than the (documented-stale) browser mirror, and must
 * write the global settings block without dropping the caps sitting next to it.
 *
 * The server-side half of the merge is `cli-bridge-switch.spec.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliBridgeEffortOf, cliBridgeEnabledOf, cliBridgeModelOf, cliBridgeRegionOrderOf, writeCliBridgeEnabled, writeCliBridgeEffort, writeCliBridgeModel, writeCliBridgeRegionOrder } from '../src/client/account-selection.ts'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

describe('cliBridgeModelOf / cliBridgeEffortOf / cliBridgeRegionOrderOf', () => {
  it('read a pinned value, and "" for every shape that is not a string', () => {
    // '' is the real "not pinned, the CLI runs on its own default" answer.
    expect(cliBridgeModelOf(undefined)).toBe('')
    expect(cliBridgeModelOf({})).toBe('')
    expect(cliBridgeModelOf({ cliBridge: {} })).toBe('')
    expect(cliBridgeModelOf({ cliBridge: { enabled: true } })).toBe('')
    // A settings-file typo must not masquerade as a pinned model.
    expect(cliBridgeModelOf({ cliBridge: { model: 42 } })).toBe('')
    expect(cliBridgeModelOf({ cliBridge: { model: true } })).toBe('')
    expect(cliBridgeModelOf({ cliBridge: { model: 'glm-5.3' } })).toBe('glm-5.3')
    // An explicit empty string is the "back to the CLI default" answer, not a typo.
    expect(cliBridgeModelOf({ cliBridge: { model: '' } })).toBe('')
  })

  it('reads the effort pin the same way', () => {
    expect(cliBridgeEffortOf({ cliBridge: { effort: 'max' } })).toBe('max')
    expect(cliBridgeEffortOf({ cliBridge: { effort: null } })).toBe('')
    expect(cliBridgeEffortOf({ cliBridge: {} })).toBe('')
  })

  it('reads the region-order pin the same way', () => {
    expect(cliBridgeRegionOrderOf({ cliBridge: { regionOrder: 'global,cn' } })).toBe('global,cn')
    expect(cliBridgeRegionOrderOf({ cliBridge: { regionOrder: 42 } })).toBe('')
    expect(cliBridgeRegionOrderOf({ cliBridge: {} })).toBe('')
  })
})

describe('writeCliBridgeModel / writeCliBridgeEffort / writeCliBridgeRegionOrder', () => {
  it('post the one-key patch to the Host and mirror its authoritative block', async () => {
    const calls: { url: string, body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: unknown, init: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: { enabled: true, model: 'glm-5.3', maxTurns: 25 } }),
      }
    })
    const setCalls: [string, unknown][] = []
    const scope = {
      getSnapshot: () => ({ value: {} }),
      set: async (field: string, value: unknown) => {
        setCalls.push([field, value])
        return true
      },
    }
    await writeCliBridgeModel(scope as never, 'glm-5.3')
    // The patch carries ONLY the one key: the Host's one-level merge keeps the
    // caps sitting next to it.
    expect(calls[0]?.body).toEqual({ field: 'cliBridge', value: { model: 'glm-5.3' } })
    // The mirror is the HOST's block, not a client-side re-merge.
    expect(setCalls).toEqual([['cliBridge', { enabled: true, model: 'glm-5.3', maxTurns: 25 }]])
  })

  it('falls back to the settings scope, keeping the block sibling keys', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('offline') })
    const store: { value: Record<string, unknown> } = {
      value: { cliBridge: { enabled: true, maxTurns: 25 } },
    }
    const scope = {
      getSnapshot: () => ({ value: store.value }),
      set: async (field: string, value: unknown) => {
        store.value = { ...store.value, [field]: value }
        return true
      },
    }
    await writeCliBridgeEffort(scope as never, 'max')
    expect(store.value.cliBridge).toMatchObject({ enabled: true, effort: 'max', maxTurns: 25 })
  })

  it('post a one-key region-order patch to the Host, keeping the sibling caps', async () => {
    const calls: { url: string, body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: unknown, init: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: { enabled: true, regionOrder: 'global,cn', maxTurns: 25 } }),
      }
    })
    const setCalls: [string, unknown][] = []
    const scope = {
      getSnapshot: () => ({ value: {} }),
      set: async (field: string, value: unknown) => {
        setCalls.push([field, value])
        return true
      },
    }
    await writeCliBridgeRegionOrder(scope as never, 'global,cn')
    expect(calls[0]?.body).toEqual({ field: 'cliBridge', value: { regionOrder: 'global,cn' } })
    expect(setCalls).toEqual([['cliBridge', { enabled: true, regionOrder: 'global,cn', maxTurns: 25 }]])
  })

  it('throw when neither writer persists the value', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('offline') })
    const scope = {
      getSnapshot: () => ({ value: {} }),
      set: async () => false,
    }
    await expect(writeCliBridgeModel(scope as never, 'glm-5.3')).rejects.toThrow(/cliBridge/)
  })
})

describe('writeCliBridgeEnabled', () => {
  it('posts the GLOBAL field to the Host and mirrors what it stored', async () => {
    const calls: { url: string, body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: unknown, init: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: { enabled: true, maxTurns: 25 } }),
      }
    })
    const setCalls: [string, unknown][] = []
    const scope = {
      getSnapshot: () => ({ value: {} }),
      set: async (field: string, value: unknown) => {
        setCalls.push([field, value])
        return true
      },
    }
    await writeCliBridgeEnabled(scope as never, true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/plugins/dsh-connect-workbuddy/__save')
    // No region wrapper: this field is global, so the posted value is itself.
    expect(calls[0]?.body).toEqual({ field: 'cliBridge', value: { enabled: true } })
    // The mirror is refreshed with the HOST's block, not a client-side re-merge.
    expect(setCalls).toEqual([['cliBridge', { enabled: true, maxTurns: 25 }]])
  })

  it('falls back to the settings scope when the Host endpoint is unavailable, and verifies it landed', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('offline') })
    const store: { value: Record<string, unknown> } = {
      value: { cliBridge: { enabled: false, maxTurns: 25 } },
    }
    const scope = {
      getSnapshot: () => ({ value: store.value }),
      set: async (field: string, value: unknown) => {
        store.value = { ...store.value, [field]: value }
        return true
      },
    }
    await writeCliBridgeEnabled(scope as never, true)
    expect(store.value.cliBridge).toMatchObject({ enabled: true, maxTurns: 25 })
  })

  it('throws when neither writer persists the value', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('offline') })
    const scope = {
      getSnapshot: () => ({ value: {} }),
      // Settling `false` is the 0.1.7 refusal channel: nothing was stored, so
      // reporting success would silently throw the click away.
      set: async () => false,
    }
    await expect(writeCliBridgeEnabled(scope as never, true)).rejects.toThrow(/cliBridge/)
  })
})

/** A signed-in usage body carrying the route's committed values. */
function usageOf(
  cliBridgeEnabled: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'cn One' }],
    models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    enabledModelIds: ['glm-5.3'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
    enabled: true,
    cliBridgeEnabled,
    ...overrides,
  }
}

describe('the card renders the global CLI switch', () => {
  const render = async (cliBridgeEnabled: boolean, overrides?: Record<string, unknown>) => {
    const calls = stubFetch((url: string) => ({
      body: url.includes('__save') ? { ok: true, value: { enabled: true } } : usageOf(cliBridgeEnabled, overrides),
    }))
    const m = await mount(WorkBuddyCard, {
      t,
      settingsScope: fakeScope({ regions: { cn: { enabled: true } } }),
      view: 'page',
    })
    await m.settle()
    return { m, calls }
  }

  it('renders it OFF when the Host says off, and usable for a live region', async () => {
    const { m } = await render(false)
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-cli-bridge-check')
    expect(box).not.toBeNull()
    expect(box?.checked).toBe(false)
    // GLOBAL: unlike the credit line it is not gated on the region's provider,
    // because the route can pull its credential from the other region.
    expect(box?.disabled).toBe(false)
  })

  it('renders it ON when the Host says on', async () => {
    const { m } = await render(true)
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-cli-bridge-check')
    expect(box?.checked).toBe(true)
  })

  it('posts the global field when clicked, not a region slot', async () => {
    const { m, calls } = await render(false)
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-cli-bridge-check')
    await m.click(box as Element)
    const save = calls.find(call => String(call.url).includes('__save'))
    expect(save).toBeDefined()
    expect(String(save?.init?.body)).toContain('"field":"cliBridge"')
    expect(String(save?.init?.body)).toContain('"enabled":true')
  })

  it('keeps its own class, so the credit-switch suite still sees exactly one `.dsm-workbuddy-pref-check`', async () => {
    const { m } = await render(false)
    // `.dsm-workbuddy-pref-check` is that suite's contract; a second element
    // carrying it would make every single-checkbox selector resolve wrongly.
    const shared = m.container.querySelectorAll('.dsm-workbuddy-pref-check')
    expect(shared).toHaveLength(1)
  })

  describe('the quick-adjust pickers under the switch', () => {
    /** [0] is the model select, [1] the effort select, [2] the region-order select. */
    const selects = (container: HTMLDivElement): HTMLSelectElement[] =>
      Array.from(container.querySelectorAll<HTMLSelectElement>('.dsm-workbuddy-cli-bridge-select'))

    /** The option VALUES of a select, in order. */
    const optionValues = (select: HTMLSelectElement): string[] =>
      Array.from(select.options).map(option => option.value)

    it('are hidden while the route is off, where they would configure nothing', async () => {
      const { m } = await render(false)
      expect(m.container.querySelector('.dsm-workbuddy-cli-bridge-select')).toBeNull()
    })

    it('offer the catalog model plus the explicit "CLI default" while the route is on', async () => {
      const { m } = await render(true)
      const [model] = selects(m.container)
      expect(model).toBeDefined()
      // No pin anywhere: the value is the explicit empty, not a missing option.
      expect(model?.value).toBe('')
      expect(optionValues(model as HTMLSelectElement)).toEqual(['', 'glm-5.3'])
    })

    it('keep a committed pin the catalog no longer lists, instead of dropping it', async () => {
      const { m } = await render(true, { cliBridgeModel: 'custom-x' })
      const [model] = selects(m.container)
      expect(model?.value).toBe('custom-x')
      expect(optionValues(model as HTMLSelectElement)).toEqual(['', 'glm-5.3', 'custom-x'])
    })

    it('post a one-key model patch when the model picker changes', async () => {
      const { m, calls } = await render(true)
      const [model] = selects(m.container)
      await m.choose(model as HTMLSelectElement, 'glm-5.3')
      await m.settle()
      const save = calls.find(call => String(call.url).includes('__save') && String(call.init?.body).includes('"model"'))
      expect(save).toBeDefined()
      expect(String(save?.init?.body)).toContain('"field":"cliBridge"')
      expect(String(save?.init?.body)).toContain('"model":"glm-5.3"')
      // The picker then renders the pinned value it just committed.
      expect(optionValues(selects(m.container)[0] as HTMLSelectElement)).toContain('glm-5.3')
    })

    it('narrow the effort picker to the pinned model\'s supported tiers', async () => {
      const { m } = await render(true, {
        cliBridgeModel: 'glm-5.3',
        models: [{ id: 'glm-5.3', name: 'GLM-5.3', reasoning: { supportedEfforts: ['low', 'max'] } }],
      })
      const [, effort] = selects(m.container)
      // The six CLI tiers, filtered to the ones the pinned model names.
      expect(optionValues(effort as HTMLSelectElement)).toEqual(['', 'low', 'max'])
    })

    it('offer every CLI tier when the pinned model names none', async () => {
      const { m } = await render(true)
      const [, effort] = selects(m.container)
      expect(optionValues(effort as HTMLSelectElement)).toEqual(['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    })

    it('post a one-key effort patch when the effort picker changes', async () => {
      const { m, calls } = await render(true)
      const [, effort] = selects(m.container)
      await m.choose(effort as HTMLSelectElement, 'high')
      await m.settle()
      const save = calls.find(call => String(call.url).includes('__save') && String(call.init?.body).includes('"effort"'))
      expect(save).toBeDefined()
      expect(String(save?.init?.body)).toContain('"effort":"high"')
    })

    it('offer the four region orders, defaulting to CN first when nothing is pinned', async () => {
      const { m } = await render(true)
      const regionOrder = selects(m.container)[2]
      expect(regionOrder).toBeDefined()
      // No pin anywhere: the picker shows the CLI's own default order.
      expect(regionOrder?.value).toBe('cn,global')
      expect(optionValues(regionOrder as HTMLSelectElement))
        .toEqual(['cn,global', 'global,cn', 'cn', 'global'])
    })

    it('shows a committed region order the presets do not name, instead of dropping it', async () => {
      const { m } = await render(true, { cliBridgeRegionOrder: 'us,cn' })
      const regionOrder = selects(m.container)[2]
      expect(regionOrder?.value).toBe('us,cn')
      expect(optionValues(regionOrder as HTMLSelectElement))
        .toEqual(['cn,global', 'global,cn', 'cn', 'global', 'us,cn'])
    })

    it('post a one-key region-order patch when the region picker changes', async () => {
      const { m, calls } = await render(true)
      const regionOrder = selects(m.container)[2]
      await m.choose(regionOrder as HTMLSelectElement, 'cn')
      await m.settle()
      const save = calls.find(call => String(call.url).includes('__save') && String(call.init?.body).includes('"regionOrder"'))
      expect(save).toBeDefined()
      expect(String(save?.init?.body)).toContain('"field":"cliBridge"')
      expect(String(save?.init?.body)).toContain('"regionOrder":"cn"')
    })
  })
})
