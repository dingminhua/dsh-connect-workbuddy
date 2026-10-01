import { describe, expect, it } from 'vitest'
import {
  configuredAccountsOf,
  isFileContentionWriteError,
  WorkBuddySettingsWriteError,
  writeAccountSlot,
  writeRegionEnabled,
  writeRegionModels,
  writePoolPreferences,
} from '../src/client/account-selection.ts'
import type { WorkBuddyAccountScope } from '../src/client/account-selection.ts'

/**
 * Whether a save failure is the Windows locked-file refusal.
 *
 * The distinction decides which message the user sees: the contention hint tells
 * them to close the program holding the file, which is useless advice for any
 * other failure. The strings below are the ones actually observed — the first
 * was captured live from the 3.0.0 host with the profile's patch file held open.
 */
describe('isFileContentionWriteError', () => {
  it('recognises the refusal a Windows file lock produces', () => {
    const live = new WorkBuddySettingsWriteError(
      'regions',
      "Host save refused: Error EPERM: operation not permitted, rename "
      + "'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\cordis.patch.yml.79498ff8fb27.tmp' "
      + "-> 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\cordis.patch.yml'",
    )
    expect(isFileContentionWriteError(live)).toBe(true)
  })

  it('accepts the other two codes Windows uses for the same condition', () => {
    // `dsh-atomic-write` retries exactly EACCES/EBUSY/EPERM on win32, so these
    // are the three spellings this refusal can arrive as.
    expect(isFileContentionWriteError(new Error('EBUSY: resource busy or locked'))).toBe(true)
    expect(isFileContentionWriteError(new Error('EACCES: permission denied'))).toBe(true)
  })

  it('does not fire for a failure that has nothing to do with the file', () => {
    // Otherwise the hint sends the user hunting for a program holding a file
    // that no one is holding.
    expect(isFileContentionWriteError(new Error('value must be an integer'))).toBe(false)
    expect(isFileContentionWriteError(new Error('workbuddy: settings field "regions" was not persisted by the settings write'))).toBe(false)
    expect(isFileContentionWriteError(undefined)).toBe(false)
    expect(isFileContentionWriteError('boom')).toBe(false)
  })

  it('matches the code token, not a substring of another word', () => {
    // Word boundaries, so an unrelated identifier cannot smuggle the hint in.
    expect(isFileContentionWriteError(new Error('XEPERMZ'))).toBe(false)
    expect(isFileContentionWriteError(new Error('myEBUSYvalue'))).toBe(false)
  })
})

/**
 * A settings scope that reproduces the Windows silent-failure shape.
 *
 * On Windows the profile's configuration file is replaced by writing a temp file and renaming it
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

describe('writeRegionEnabled', () => {
  /** The region's whole slot, as the card builds it from one snapshot read. */
  const slot = (enabled: boolean): Record<string, unknown> => ({
    enabled,
    lastCatalog: [{ id: 'glm-5.3' }],
    enabledModelIds: ['glm-5.3'],
  })

  it('verifies the flag actually landed instead of trusting a resolved set()', async () => {
    // THE regression this guards. The toggle used to call `scope.set()`
    // directly, so on a scope that settles without storing anything the switch
    // appeared to work and then silently reverted — the same silent-failure
    // mode the account and catalog writes were already protected against.
    // `locked` reproduces exactly that scope.
    const { scope } = scopeWith({ regions: { cn: slot(true) } }, { locked: true })
    await expect(writeRegionEnabled(scope, 'cn', false, slot(false)))
      .rejects.toThrow(WorkBuddySettingsWriteError)
  })

  it('names the field it failed on', async () => {
    const { scope } = scopeWith({}, { locked: true })
    await expect(writeRegionEnabled(scope, 'cn', false, slot(false)))
      .rejects.toMatchObject({ field: 'regions' })
  })

  it('accepts a switch that lands', async () => {
    const { scope, document } = scopeWith({ regions: { cn: slot(true) } })
    await expect(writeRegionEnabled(scope, 'cn', false, slot(false))).resolves.toBeUndefined()
    const regions = document()['regions'] as Record<string, { enabled?: boolean }>
    expect(regions.cn?.enabled).toBe(false)
  })

  it('carries the rest of the slot through, so a switch keeps the directory', async () => {
    // Only `enabled` may change: the user's model picks, image opt-ins and
    // context budgets ride in the same object and must survive the round trip.
    const { scope, document } = scopeWith({ regions: {} })
    await writeRegionEnabled(scope, 'cn', false, slot(false))
    const regions = document()['regions'] as Record<string, { lastCatalog?: unknown, enabledModelIds?: unknown }>
    expect(regions.cn?.lastCatalog).toEqual([{ id: 'glm-5.3' }])
    expect(regions.cn?.enabledModelIds).toEqual(['glm-5.3'])
  })

  it('rejects a slot that exists but carries the WRONG flag', async () => {
    // A present slot is not proof: a shallow check would pass here while the
    // provider stayed switched on.
    const scope: WorkBuddyAccountScope = {
      getSnapshot: () => ({ value: { regions: { cn: { enabled: true } } } }),
      set: async () => {},
    }
    await expect(writeRegionEnabled(scope, 'cn', false, { enabled: true }))
      .rejects.toThrow(WorkBuddySettingsWriteError)
  })
})

/**
 * The pool preferences write.
 *
 * These matter more than most writes: the card DISCARDS its draft once the
 * write resolves, so a write that reports success without landing would throw
 * the user's selection away with nothing to recover from.
 */
describe('writePoolPreferences', () => {
  const PREFERENCES = {
    enabled: true,
    targetModelId: 'glm-5.3',
    memberAccountIds: ['a', 'b'],
  }

  it('stores the preferences under the region slot', async () => {
    const { scope, document } = scopeWith({ regions: { cn: {} } })
    await writePoolPreferences(scope, 'cn', { ...PREFERENCES })
    const pool = (document()['regions'] as Record<string, { pool?: unknown }>).cn?.pool
    expect(pool).toEqual({ ...PREFERENCES })
  })

  it('PRESERVES the model list when saving pool preferences', async () => {
    // The pool shares a slot with the model list, so this write must merge
    // rather than replace — otherwise configuring the pool would delete the
    // user's models.
    const { scope, document } = scopeWith({
      regions: { cn: { lastCatalog: [{ id: 'm' }], enabledModelIds: ['m'] } },
    })
    await writePoolPreferences(scope, 'cn', { ...PREFERENCES })
    const slot = (document()['regions'] as Record<string, Record<string, unknown>>).cn
    expect(slot?.['lastCatalog']).toEqual([{ id: 'm' }])
    expect(slot?.['enabledModelIds']).toEqual(['m'])
    expect(slot?.['pool']).toEqual({ ...PREFERENCES })
  })

  it('accepts a membership set stored in a different ORDER', async () => {
    // Stored order is not meaningful; an order-sensitive check would reject a
    // write that landed correctly, and the card would then report a save
    // failure for a selection it actually stored.
    const { scope } = scopeWith({
      regions: { cn: { pool: { ...PREFERENCES, memberAccountIds: ['b', 'a'] } } },
    })
    // The merge base is the snapshot, so the swapped order is what lands; the
    // verification must still accept it.
    await expect(writePoolPreferences(scope, 'cn', { ...PREFERENCES })).resolves.toBeUndefined()
  })

  it('accepts an empty membership set', async () => {
    // "Nothing checked" is a real, saveable state — it is what keeps the batch
    // buttons disabled.
    const { scope, document } = scopeWith({ regions: { cn: {} } })
    const empty = { ...PREFERENCES, memberAccountIds: [] as string[], enabled: false, }
    await writePoolPreferences(scope, 'cn', empty)
    const pool = (document()['regions'] as Record<string, { pool?: { memberAccountIds?: string[] } }>).cn?.pool
    expect(pool?.memberAccountIds).toEqual([])
  })

  it('reports a write that did not persist instead of dropping the draft', async () => {
    // A locked profile settles without storing; the card treats a resolved write
    // as permission to discard its draft, so this must throw.
    const { scope } = scopeWith({ regions: { cn: {} } }, { locked: true })
    await expect(writePoolPreferences(scope, 'cn', { ...PREFERENCES }))
      .rejects.toBeInstanceOf(WorkBuddySettingsWriteError)
  })
})

/**
 * The two saves coexist in ONE region slot.
 *
 * The model list, the provider switch, and the pool's preferences are all
 * fields of the same `regions[region]` object. Every writer therefore has to
 * merge onto the existing slot: a writer that replaced the slot would delete
 * the other features' settings, so configuring the pool would wipe the user's
 * models (or the reverse), with no error to explain it.
 */
describe('coexisting writers on one region slot', () => {
  it('saving the MODEL LIST keeps the pool preferences', async () => {
    const { scope, document } = scopeWith({
      regions: { cn: { pool: { enabled: true, memberAccountIds: ['a'] } } },
    })
    await writeRegionModels(scope, 'cn', {
      lastCatalog: [{ id: 'm' }],
      enabledModelIds: ['m'],
    })
    const slot = (document()['regions'] as Record<string, Record<string, unknown>>).cn
    expect(slot?.['pool']).toEqual({ enabled: true, memberAccountIds: ['a'] })
    expect(slot?.['lastCatalog']).toEqual([{ id: 'm' }])
  })

  it('saving the POOL keeps the model list', async () => {
    const { scope, document } = scopeWith({
      regions: { cn: { lastCatalog: [{ id: 'm' }], enabledModelIds: ['m'] } },
    })
    await writePoolPreferences(scope, 'cn', {
      enabled: true,
      targetModelId: '',
      memberAccountIds: ['a'],
    })
    const slot = (document()['regions'] as Record<string, Record<string, unknown>>).cn
    expect(slot?.['lastCatalog']).toEqual([{ id: 'm' }])
    expect(slot?.['enabledModelIds']).toEqual(['m'])
    expect((slot?.['pool'] as Record<string, unknown>)?.['enabled']).toBe(true)
  })

  it('toggling the PROVIDER keeps both the model list and the pool', async () => {
    const { scope, document } = scopeWith({
      regions: { cn: { lastCatalog: [{ id: 'm' }], pool: { enabled: true } } },
    })
    const slot = (document()['regions'] as Record<string, Record<string, unknown>>).cn ?? {}
    await writeRegionEnabled(scope, 'cn', false, { ...slot, enabled: false })
    const after = (document()['regions'] as Record<string, Record<string, unknown>>).cn
    expect(after?.['enabled']).toBe(false)
    expect(after?.['lastCatalog']).toEqual([{ id: 'm' }])
    expect(after?.['pool']).toEqual({ enabled: true })
  })

  it('never disturbs the sibling region', async () => {
    const { scope, document } = scopeWith({
      regions: {
        cn: { pool: { enabled: true } },
        global: { lastCatalog: [{ id: 'g' }], pool: { enabled: false } },
      },
    })
    await writePoolPreferences(scope, 'cn', {
      enabled: false,
      targetModelId: '',
      memberAccountIds: [],
    })
    const regions = document()['regions'] as Record<string, Record<string, unknown>>
    expect(regions.global).toEqual({ lastCatalog: [{ id: 'g' }], pool: { enabled: false } })
  })
})
