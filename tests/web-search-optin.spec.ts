/**
 * Issue #332: the WorkBuddy web-search opt-in.
 *
 * Like every capability that can spend credits or claim a global seat, this one
 * must ship OFF and only an explicit `enabled: true` may turn it on. The write
 * must also preserve the tuned siblings (`agentic` / `maxContentChars`) so
 * flipping the checkbox never erases a choice the user made in the config file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  webSearchEnabledOf,
  writeWebSearchEnabled,
  WorkBuddySettingsWriteError,
} from '../src/client/account-selection.ts'
import type { WorkBuddyAccountScope } from '../src/client/account-selection.ts'

function scopeWith(value: unknown): WorkBuddyAccountScope {
  let current = value
  return {
    getSnapshot: () => ({ value: current }),
    set: async (_field, next) => {
      const key = typeof _field === 'string' ? _field : ''
      current = { ...current as Record<string, unknown>, [key]: next }
      return true
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('webSearchEnabledOf', () => {
  it('reads absent / malformed as OFF', () => {
    expect(webSearchEnabledOf(undefined)).toBe(false)
    expect(webSearchEnabledOf({})).toBe(false)
    expect(webSearchEnabledOf({ webSearch: 'true' })).toBe(false)
    expect(webSearchEnabledOf({ webSearch: { enabled: 1 } })).toBe(false)
  })

  it('only an explicit enabled:true is ON', () => {
    expect(webSearchEnabledOf({ webSearch: { enabled: true } })).toBe(true)
    expect(webSearchEnabledOf({ webSearch: { enabled: false, agentic: true } })).toBe(false)
  })

  it('unwraps a volatile getter reference', () => {
    expect(webSearchEnabledOf({ webSearch: { get: () => ({ enabled: true }) } })).toBe(true)
  })
})

describe('the config default is OFF', () => {
  it('the reader treats an absent webSearch as OFF', () => {
    expect(webSearchEnabledOf({})).toBe(false)
  })
})

describe('writeWebSearchEnabled', () => {
  it('preserves agentic / maxContentChars when flipping enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    // The Host endpoint answers {ok:true} with no `value`, so the writer falls
    // back to the settings scope. The scope starts with the tuned block.
    const scope = scopeWith({ webSearch: { enabled: false, agentic: true, maxContentChars: 12000 } })
    await writeWebSearchEnabled(scope, true)
    const saved = (scope.getSnapshot().value as { webSearch: Record<string, unknown> }).webSearch
    expect(saved).toMatchObject({ enabled: true, agentic: true, maxContentChars: 12000 })
  })

  it('throws when neither writer lands the value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const scope: WorkBuddyAccountScope = {
      getSnapshot: () => ({ value: {} }),
      set: async () => false,
    }
    await expect(writeWebSearchEnabled(scope, true)).rejects.toBeInstanceOf(WorkBuddySettingsWriteError)
  })
})

