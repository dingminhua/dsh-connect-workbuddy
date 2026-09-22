/**
 * The signed-out card's probed-path presentation rules.
 *
 * These live in their own browser-free module because the card is a `.tsx`
 * component whose module graph pulls DSH's browser packages — there is no jsdom
 * or react-dom in this project, so anything left inside the component would be
 * untestable. The rules here decide what a signed-out user actually sees, which
 * is exactly what must not regress silently.
 */

import { describe, expect, it } from 'vitest'
import {
  INTERESTING_REASONS,
  searchReasonKey,
  searchReasonLabel,
  searchedView,
} from '../src/client/searched-paths.ts'
import type { Translate } from '../src/client/searched-paths.ts'
import { en, zh } from '../src/client/locales.ts'
import type { WorkBuddyWebSearchPath } from '../src/status-paths.ts'

/** A probe failure, with only the fields the rules read. */
function failure(
  reason: WorkBuddyWebSearchPath['reason'],
  path = `/p/${reason}`,
  source: WorkBuddyWebSearchPath['source'] = 'desktop',
): WorkBuddyWebSearchPath {
  return { path, source, reason }
}

/** A `t` that echoes the key, so assertions name the copy rather than its text. */
const echo: Translate = key => key

describe('searchedView', () => {
  it('hides merely-absent paths when a real finding exists', () => {
    // The normal machine: the live file is missing and so are the backups, but
    // one encrypted sibling explains everything. A flat list would bury it.
    const view = searchedView([
      failure('missing', '/a'),
      failure('encrypted', '/b'),
      failure('missing', '/c'),
    ])
    expect(view.interesting.map(item => item.path)).toEqual(['/b'])
    expect(view.missing.map(item => item.path)).toEqual(['/a', '/c'])
    expect(view.missingOpen).toBe(false)
    expect(view.encrypted).toBe(true)
    expect(view.total).toBe(3)
  })

  it('opens the absent list when nothing interesting was found', () => {
    // "Nothing found, and here is everywhere we looked" IS the answer when all
    // candidates are absent: the user needs those paths to redirect the plugin.
    const view = searchedView([failure('missing', '/a'), failure('missing', '/b')])
    expect(view.interesting).toEqual([])
    expect(view.missingOpen).toBe(true)
    expect(view.encrypted).toBe(false)
  })

  it('opens the absent list for an empty result rather than claiming detail', () => {
    const view = searchedView([])
    expect(view.total).toBe(0)
    expect(view.missingOpen).toBe(true)
    expect(view.encrypted).toBe(false)
  })

  it('preserves the Host probe order inside each group', () => {
    // The store reports the live file before its timestamped backups, and that
    // order is the useful one to read.
    const view = searchedView([
      failure('unreadable', '/live'),
      failure('missing', '/backup-1'),
      failure('invalid', '/backup-2'),
      failure('missing', '/backup-3'),
    ])
    expect(view.interesting.map(item => item.path)).toEqual(['/live', '/backup-2'])
    expect(view.missing.map(item => item.path)).toEqual(['/backup-1', '/backup-3'])
  })

  it('keeps every non-missing reason visible', () => {
    // `encrypted` is the reason the feature exists; `invalid` and `unreadable`
    // are genuine findings too. Only a plain absence may be hidden.
    expect([...INTERESTING_REASONS].sort()).toEqual(['encrypted', 'invalid', 'unreadable'])
    const view = searchedView([
      failure('missing'),
      failure('encrypted'),
      failure('invalid'),
      failure('unreadable'),
    ])
    expect(view.interesting).toHaveLength(3)
    expect(view.missing).toHaveLength(1)
  })

  it('flags encrypted whenever any entry is encrypted', () => {
    const view = searchedView([failure('missing'), failure('encrypted')])
    expect(view.encrypted).toBe(true)
  })
})

describe('searchReasonKey', () => {
  it('maps each reason to its own copy key', () => {
    const keys = (['missing', 'unreadable', 'invalid', 'encrypted'] as const).map(searchReasonKey)
    expect(keys).toEqual([
      'row.reasonMissing',
      'row.reasonUnreadable',
      'row.reasonInvalid',
      'row.reasonEncrypted',
    ])
    // Each reason must be distinguishable: two reasons sharing copy would make
    // the encrypted case look like a plain absence again.
    expect(new Set(keys).size).toBe(4)
  })

  it('has copy for every reason in both locales', () => {
    // The `zh` table is typed against `en`, but an empty string would satisfy
    // the type and render as a blank cause.
    for (const reason of ['missing', 'unreadable', 'invalid', 'encrypted'] as const) {
      const key = searchReasonKey(reason)
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
      expect(zh[key]).not.toBe(en[key])
    }
  })

  it('gives each reason DISTINCT copy in each locale', () => {
    // Four reasons exist precisely so they read as four different situations.
    // If `encrypted` shared `missing`'s text, the whole feature would collapse
    // back into "the file was not found" while every other test still passed.
    const keys = (['missing', 'unreadable', 'invalid', 'encrypted'] as const).map(searchReasonKey)
    for (const table of [en, zh]) {
      const texts = keys.map(key => table[key])
      expect(new Set(texts).size).toBe(4)
    }
  })
})

describe('searchReasonLabel', () => {
  it('names the store the path belongs to', () => {
    // The two sources are fixed differently — the app's installation vs the
    // plugin's own storage — so the label must say which one this is.
    expect(searchReasonLabel(failure('encrypted', '/a', 'desktop'), echo))
      .toBe('row.sourceDesktop · row.reasonEncrypted')
    expect(searchReasonLabel(failure('invalid', '/a', 'dsh'), echo))
      .toBe('row.sourceDsh · row.reasonInvalid')
  })

  it('labels every reason without falling through to a default', () => {
    for (const reason of ['missing', 'unreadable', 'invalid', 'encrypted'] as const) {
      expect(searchReasonLabel(failure(reason), echo)).toContain(searchReasonKey(reason))
    }
  })
})

describe('signed-out diagnostics copy', () => {
  it('says the desktop app is needed, and does not tell the user to sign in again', () => {
    // The encrypted cause is the one where the user is already signed in;
    // repeating "sign in once in the desktop app" would send them to an action
    // that cannot work.
    const notice = zh['row.searchedEncryptedNotice']
    expect(notice).toContain('WORKBUDDY_APP_EXECUTABLE')
    expect(notice).toContain('重新登录')
    expect(notice).toContain('解决不了')
    expect(en['row.searchedEncryptedNotice']).toContain('WORKBUDDY_APP_EXECUTABLE')
  })

  it('names the auth-file override in the hint so the user can redirect the probe', () => {
    for (const table of [en, zh]) {
      expect(table['row.searchedHint']).toContain('WORKBUDDY_AUTH_FILE')
      expect(table['row.searchedTitle'].length).toBeGreaterThan(0)
    }
  })

  it('interpolates a count into the absent-list toggle', () => {
    const t: Translate = (key, params) => `${key}:${String(params?.['count'])}`
    expect(t('row.searchedMore', { count: 7 })).toBe('row.searchedMore:7')
    for (const table of [en, zh]) expect(table['row.searchedMore']).toContain('{count}')
  })
})
