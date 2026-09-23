import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configuredAccountsOf,
  WorkBuddySettingsWriteError,
  writeAccountSlot,
  writeRegionEnabled,
  writeRegionModels,
} from '../src/client/account-selection.ts'
import type { WorkBuddyAccountScope } from '../src/client/account-selection.ts'

afterEach(() => { vi.restoreAllMocks() })

/**
 * A settings scope that reproduces the Windows silent-failure shape.
 *
 * On Windows `settings.yaml` is replaced by writing a temp file and renaming it
 * over the target; an antivirus scanner, a sync client, or an open editor can
 * hold the file, and `@deepseek-ai/dsh-atomic-write` retries `EPERM`/`EBUSY`/
 * `EACCES` only on `win32`. When those retries are exhausted the client's
 * `mutate()` handles the unsuccessful response by reloading Host state and
 * merely RETURNING — so `await set()` succeeds and the document never changed.
 *
 * `locked` models exactly that: the promise resolves, the write is dropped.
 */
function scopeWith(initial: Record<string, unknown>, options: { locked?: boolean } = {}): {
  scope: WorkBuddyAccountScope
  document: () => Record<string, unknown>
  writes: () => number
} {
  let document: Record<string, unknown> = { ...initial }
  let writes = 0
  return {
    scope: {
      getSnapshot: () => ({ value: document }),
      set: async (field: string, value: unknown) => {
        writes += 1
        // A locked file: the call settles normally, nothing is stored.
        if (options.locked === true) return
        document = { ...document, [field]: value }
      },
    },
    document: () => document,
    writes: () => writes,
  }
}

describe('configuredAccountsOf', () => {
  it('reads the accounts object and tolerates every absent shape', () => {
    expect(configuredAccountsOf({ accounts: { cn: 'a', global: 'b' } })).toEqual({ cn: 'a', global: 'b' })
    expect(configuredAccountsOf({})).toEqual({})
    expect(configuredAccountsOf(undefined)).toEqual({})
    // A non-object section must not throw: the card reads this on first paint.
    expect(configuredAccountsOf({ accounts: 'nonsense' })).toEqual({})
    expect(configuredAccountsOf({ accounts: null })).toEqual({})
  })
})

describe('writeAccountSlot', () => {
  it('saves a pick and preserves the other region', async () => {
    const { scope, document } = scopeWith({ accounts: { global: 'kept' } })
    await writeAccountSlot(scope, 'cn', 'chosen')
    expect(document()).toEqual({ accounts: { global: 'kept', cn: 'chosen' } })
  })

  it('writes the empty-string sentinel for a clear, not an absent key', async () => {
    // Absent and '' mean different things to the Host: absent falls back to the
    // legacy accountId, '' terminates that fallback. A clear that removed the
    // key instead of writing the sentinel would silently resurrect the choice.
    const { scope, document } = scopeWith({ accounts: { cn: 'saved' } })
    await writeAccountSlot(scope, 'cn', '')
    expect(document()).toEqual({ accounts: { cn: '' } })
    expect(Object.hasOwn(document()['accounts'] as object, 'cn')).toBe(true)
  })

  it('throws when the write silently did not persist (issue #11 on Windows)', async () => {
    // The whole point: `set()` resolved, so the caller would otherwise report
    // success — and the card would show "cleared" while the old selection keeps
    // running, which is exactly the confusion the state line exists to remove.
    const { scope, writes } = scopeWith({ accounts: { cn: 'saved' } }, { locked: true })
    await expect(writeAccountSlot(scope, 'cn', '')).rejects.toThrow(WorkBuddySettingsWriteError)
    expect(writes()).toBe(1)
  })

  it('reports which field failed so the card can name it', async () => {
    const { scope } = scopeWith({}, { locked: true })
    await expect(writeAccountSlot(scope, 'cn', 'x')).rejects.toMatchObject({
      name: 'WorkBuddySettingsWriteError',
      field: 'accounts',
    })
  })

  it('does not mistake an absent key for a successful clear', async () => {
    // A scope that DROPS the slot entirely instead of storing the sentinel:
    // the value reads back as `undefined`, which is not `''`. Accepting it
    // would report success for a write that reintroduced the legacy fallback.
    const scope: WorkBuddyAccountScope = {
      getSnapshot: () => ({ value: { accounts: {} } }),
      set: async () => {},
    }
    await expect(writeAccountSlot(scope, 'cn', '')).rejects.toThrow(WorkBuddySettingsWriteError)
  })

  it('accepts a write that lands, including a real id', async () => {
    const { scope } = scopeWith({ accounts: {} })
    await expect(writeAccountSlot(scope, 'global', 'global-id')).resolves.toBeUndefined()
  })

  it('reads back through the same resolved value the card writes from', async () => {
    // The write and the verification must look at ONE source. The bound scope
    // updates its mirror inside `set()` and `getSnapshot()` reads the store
    // synchronously (flush defaults to 'sync'), so a landed write is visible by
    // the time the promise settles — no polling and no false failure.
    const { scope, document } = scopeWith({ accounts: { global: 'kept' } })
    await writeAccountSlot(scope, 'cn', 'chosen')
    // What the card reads next must agree with what was verified.
    expect(configuredAccountsOf(scope.getSnapshot().value)).toEqual(document()['accounts'])
  })

  it('uses the Host fallback when the 0.1.7 ConfigForm is memory-backed', async () => {
    const { scope } = scopeWith({ accounts: { global: 'kept' } }, { locked: true })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(writeAccountSlot(scope, 'cn', 'chosen')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, request] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(request?.body))).toEqual({ field: 'accounts', region: 'cn', value: 'chosen' })
  })
})

describe('writeRegionEnabled', () => {
  it('preserves the rest of the region slot through the native scope', async () => {
    const { scope, document } = scopeWith({
      regions: { cn: { enabled: true, enabledModelIds: ['glm-5.3'], contextBudgets: { 'glm-5.3': 1_000_000 } } },
    })
    await writeRegionEnabled(scope, 'cn', false)
    expect(document()['regions']).toEqual({
      cn: { enabled: false, enabledModelIds: ['glm-5.3'], contextBudgets: { 'glm-5.3': 1_000_000 } },
    })
  })

  it('falls back to the precise nested Host path', async () => {
    const { scope } = scopeWith({ regions: { global: { enabled: true } } }, { locked: true })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    await writeRegionEnabled(scope, 'global', false)
    const [, request] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(request?.body))).toEqual({ field: 'regions.enabled', region: 'global', value: false })
  })
})

describe('writeRegionModels', () => {
  const payload = {
    lastCatalog: [{ id: 'glm-5.3' }, { id: 'auto' }],
    enabledModelIds: ['glm-5.3'],
    imageModelIds: [],
    contextBudgets: {},
  }

  it('saves the region slot and preserves the other region', async () => {
    const { scope, document } = scopeWith({ regions: { global: { enabledModelIds: ['gpt-5.6-sol'] } } })
    await writeRegionModels(scope, 'cn', payload)
    expect(document()['regions']).toEqual({
      global: { enabledModelIds: ['gpt-5.6-sol'] },
      cn: payload,
    })
  })

  it('throws when the model save silently did not persist', async () => {
    // A save DISCARDS the draft afterwards, so a write that did not land makes
    // the card throw away the user's only copy while reporting success.
    const { scope } = scopeWith({ regions: {} }, { locked: true })
    await expect(writeRegionModels(scope, 'cn', payload)).rejects.toThrow(WorkBuddySettingsWriteError)
  })

  it('detects a truncated catalog rather than trusting a present-but-wrong slot', async () => {
    // The slot exists and is an object — a shallow "did anything land?" check
    // would pass — but the catalog differs from what was written.
    const scope: WorkBuddyAccountScope = {
      getSnapshot: () => ({ value: { regions: { cn: { lastCatalog: [{ id: 'glm-5.3' }] } } } }),
      set: async () => {},
    }
    await expect(writeRegionModels(scope, 'cn', payload)).rejects.toThrow(WorkBuddySettingsWriteError)
  })

  it('names the field it failed on', async () => {
    const { scope } = scopeWith({}, { locked: true })
    await expect(writeRegionModels(scope, 'cn', payload)).rejects.toMatchObject({ field: 'regions' })
  })

  it('accepts a save that lands', async () => {
    const { scope } = scopeWith({})
    await expect(writeRegionModels(scope, 'global', payload)).resolves.toBeUndefined()
  })
})
