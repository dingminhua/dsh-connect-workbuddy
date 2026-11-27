/**
 * Issue #332: keeping the host's `web.searchProvider` in sync with the plugin
 * opt-in, and — more importantly — restoring it so an uninstall never leaves a
 * dangling provider id that breaks web_search for every route.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyProviderSetting,
  planToOp,
  restorePlan,
  takeoverPlan,
  webEntry,
  WEB_SETTINGS_NS,
  type WebSettingsService,
} from '../src/web-search-provider-setting.ts'

function settings(overrides: Partial<WebSettingsService> = {}): WebSettingsService {
  return {
    describe: () => [{ ns: WEB_SETTINGS_NS, revision: 3 }],
    mutate: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('takeoverPlan', () => {
  it('pins the host to our provider id', () => {
    expect(takeoverPlan('dsh-connect-workbuddy-search')).toEqual({ kind: 'set', value: 'dsh-connect-workbuddy-search' })
  })
})

describe('restorePlan', () => {
  it('restores an explicit saved user value', () => {
    expect(restorePlan({ user: { searchProvider: 'deepseek-official' }, base: {} }))
      .toEqual({ kind: 'set', value: 'deepseek-official' })
  })

  it('falls back to the composition base when there is no user value', () => {
    expect(restorePlan({ user: {}, base: { searchProvider: 'deepseek-search-api' } }))
      .toEqual({ kind: 'set', value: 'deepseek-search-api' })
  })

  it('prefers the explicit user value over the composition base', () => {
    expect(restorePlan({ user: { searchProvider: 'user-pick' }, base: { searchProvider: 'base-pick' } }))
      .toEqual({ kind: 'set', value: 'user-pick' })
  })

  it('unsets when neither layer had a value — back to the host default', () => {
    expect(restorePlan(undefined)).toEqual({ kind: 'unset' })
    expect(restorePlan({ user: {}, base: {} })).toEqual({ kind: 'unset' })
  })

  it('never re-applies a malformed saved value', () => {
    expect(restorePlan({ user: { searchProvider: 42 }, base: { searchProvider: '' } }))
      .toEqual({ kind: 'unset' })
  })

  it('treats our OWN persisted id as absent, so a restart+disable unsets instead of pinning ourselves (#332)', () => {
    // After a restart, describe() reports LAST RUN's takeover as the saved user
    // value. Restoring that would set the host right back to our now-unregistered
    // id and break web_search for every route with CONFIGURED_MISSING.
    const own = 'dsh-connect-workbuddy-search'
    expect(restorePlan({ user: { searchProvider: own }, base: {} }, own)).toEqual({ kind: 'unset' })
    expect(restorePlan({ user: {}, base: { searchProvider: own } }, own)).toEqual({ kind: 'unset' })
    // A genuinely different user choice must still be restored.
    expect(restorePlan({ user: { searchProvider: 'deepseek-official' }, base: {} }, own))
      .toEqual({ kind: 'set', value: 'deepseek-official' })
  })
})

describe('planToOp', () => {
  it('maps to the host set/unset path operators', () => {
    expect(planToOp({ kind: 'set', value: 'x' })).toEqual({ op: 'set', path: ['searchProvider'], value: 'x' })
    expect(planToOp({ kind: 'unset' })).toEqual({ op: 'unset', path: ['searchProvider'] })
  })
})

describe('webEntry', () => {
  it('finds the web namespace by exact id and ignores other entries', () => {
    const svc = settings({
      describe: () => [
        { ns: 'web-search-deepseek', revision: 1 },
        { ns: WEB_SETTINGS_NS, revision: 7, user: { searchProvider: 'x' } },
      ],
    })
    expect(webEntry(svc)?.revision).toBe(7)
  })
})

describe('applyProviderSetting', () => {
  it('writes with the current revision for conflict protection', async () => {
    const mutate = vi.fn(async () => {})
    const svc = settings({ mutate })
    const applied = await applyProviderSetting(svc, takeoverPlan('dsh-connect-workbuddy-search'))
    expect(applied).toBe(true)
    expect(mutate).toHaveBeenCalledWith(
      WEB_SETTINGS_NS,
      [{ op: 'set', path: ['searchProvider'], value: 'dsh-connect-workbuddy-search' }],
      3,
    )
  })

  it('restores via unset when no prior value existed', async () => {
    const mutate = vi.fn(async () => {})
    const svc = settings({ mutate, describe: () => [{ ns: WEB_SETTINGS_NS, revision: 9, user: {}, base: {} }] })
    await applyProviderSetting(svc, restorePlan({ user: {}, base: {} }))
    expect(mutate).toHaveBeenCalledWith(WEB_SETTINGS_NS, [{ op: 'unset', path: ['searchProvider'] }], 9)
  })

  it('does nothing when the host does not serve the web entry', async () => {
    const mutate = vi.fn(async () => {})
    const svc = settings({ mutate, describe: () => [{ ns: 'other', revision: 1 }] })
    expect(await applyProviderSetting(svc, takeoverPlan('x'))).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
  })
})
