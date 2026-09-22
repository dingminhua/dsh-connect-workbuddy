import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configuredAccountsOf,
  VERIFIED_WRITE_RETRY_DELAYS_MS,
  WorkBuddySettingsWriteError,
  writeAccountSlot,
  writeRegionModels,
} from '../src/client/account-selection.ts'
import type { WorkBuddyAccountScope } from '../src/client/account-selection.ts'

/**
 * The retry path suspends for real milliseconds, so the suite drives it on
 * fake timers: every assertion below stays about BEHAVIOUR (what lands, how
 * many attempts) while the wall clock cost stays at zero.
 */
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Advance past every retry delay, letting a pending write run to completion. */
const flushRetries = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(VERIFIED_WRITE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) + 1)
}

/**
 * Await a write that is expected to FAIL, driving its retries on fake timers.
 *
 * The rejection is captured by the helper itself the moment it happens, before
 * `vitest` can see an unhandled rejection: attaching a matcher and advancing
 * timers separately leaves a window where the two race, and the suite reports
 * it as an unhandled error even though every assertion passes.
 *
 * @param promise - the write under test.
 * @param assert - the matcher to apply to the rejection.
 */
async function expectRejection(
  promise: Promise<unknown>,
  assert: (rejection: Error) => void,
): Promise<void> {
  let caught: Error | undefined
  const settled = promise.then(
    () => { throw new Error('expected the write to be rejected, but it resolved') },
    (error: Error) => { caught = error },
  )
  await flushRetries()
  await settled
  assert(caught!)
}

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
 * `lockedFor` models the same interference for the FIRST n writes, which is
 * what a retry is expected to outlast (issue #13).
 */
function scopeWith(
  initial: Record<string, unknown>,
  options: { locked?: boolean, lockedFor?: number } = {},
): {
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
        if (options.lockedFor !== undefined && writes <= options.lockedFor) return
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
    await expectRejection(writeAccountSlot(scope, 'cn', ''), (error) => {
      expect(error).toBeInstanceOf(WorkBuddySettingsWriteError)
    })
    // One initial attempt plus one per retry delay, all before giving up.
    expect(writes()).toBe(VERIFIED_WRITE_RETRY_DELAYS_MS.length + 1)
  })

  it('recovers when transient interference clears before a retry (issue #13)', async () => {
    // The reported bug: the account picker appeared locked because the write
    // was silently dropped while `settings.yaml` was held. That interference is
    // transient, so a write dropped once must not be reported as a failure —
    // the retry lands and the switch takes effect.
    const { scope, document, writes } = scopeWith({ accounts: { cn: 'old' } }, { lockedFor: 1 })
    const settled = writeAccountSlot(scope, 'cn', 'new')
    await flushRetries()
    await expect(settled).resolves.toBeUndefined()
    expect(writes()).toBe(2)
    expect(document()).toEqual({ accounts: { cn: 'new' } })
  })

  it('preserves the other region across the retry', async () => {
    // The retry rebuilds the section from the LIVE snapshot, so a value that
    // moved between attempts is not clobbered by a stale first-attempt copy.
    const { scope, document } = scopeWith({ accounts: { global: 'first' } }, { lockedFor: 1 })
    const settled = writeAccountSlot(scope, 'cn', 'cn-id')
    await flushRetries()
    await settled
    expect(document()).toEqual({ accounts: { global: 'first', cn: 'cn-id' } })
  })

  it('reports the attempt count so a persistent lock is diagnosable', async () => {
    const { scope } = scopeWith({}, { locked: true })
    await expectRejection(writeAccountSlot(scope, 'cn', 'x'), (error) => {
      expect(error).toMatchObject({
        field: 'accounts',
        attempts: VERIFIED_WRITE_RETRY_DELAYS_MS.length + 1,
      })
    })
  })

  it('keeps the message short, since the card wraps it in localized guidance', async () => {
    // `row.accountsWriteFailed` / `row.saveError` already name the likely file
    // holders in the user's language and interpolate this message; duplicating
    // that guidance here would print it twice in one sentence.
    const { scope } = scopeWith({}, { locked: true })
    await expectRejection(writeAccountSlot(scope, 'cn', 'x'), (error) => {
      expect(error.message).not.toMatch(/antivirus|sync client|open editor/)
      expect(error.message).toContain('was not persisted')
    })
  })

  it('reports which field failed so the card can name it', async () => {
    const { scope } = scopeWith({}, { locked: true })
    await expectRejection(writeAccountSlot(scope, 'cn', 'x'), (error) => {
      expect(error).toMatchObject({
        name: 'WorkBuddySettingsWriteError',
        field: 'accounts',
      })
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
    await expectRejection(writeAccountSlot(scope, 'cn', ''), (error) => {
      expect(error).toBeInstanceOf(WorkBuddySettingsWriteError)
    })
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
    await expectRejection(writeRegionModels(scope, 'cn', payload), (error) => {
      expect(error).toBeInstanceOf(WorkBuddySettingsWriteError)
    })
  })

  it('recovers a model save once interference clears', async () => {
    // Same transient-window recovery as the account slot: a dropped save that
    // succeeds on retry must not discard the user's draft.
    const { scope, document, writes } = scopeWith({ regions: {} }, { lockedFor: 1 })
    const settled = writeRegionModels(scope, 'cn', payload)
    await flushRetries()
    await expect(settled).resolves.toBeUndefined()
    expect(writes()).toBe(2)
    expect(document()['regions']).toEqual({ cn: payload })
  })

  it('detects a truncated catalog rather than trusting a present-but-wrong slot', async () => {
    // The slot exists and is an object — a shallow "did anything land?" check
    // would pass — but the catalog differs from what was written.
    const scope: WorkBuddyAccountScope = {
      getSnapshot: () => ({ value: { regions: { cn: { lastCatalog: [{ id: 'glm-5.3' }] } } } }),
      set: async () => {},
    }
    await expectRejection(writeRegionModels(scope, 'cn', payload), (error) => {
      expect(error).toBeInstanceOf(WorkBuddySettingsWriteError)
    })
  })

  it('names the field it failed on', async () => {
    const { scope } = scopeWith({}, { locked: true })
    await expectRejection(writeRegionModels(scope, 'cn', payload), (error) => {
      expect(error).toMatchObject({ field: 'regions' })
    })
  })

  it('accepts a save that lands', async () => {
    const { scope } = scopeWith({})
    await expect(writeRegionModels(scope, 'global', payload)).resolves.toBeUndefined()
  })
})
