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
  signedOutNotice,
  signedOutText,
} from '../src/client/searched-paths.ts'
import type { Translate } from '../src/client/searched-paths.ts'
import { en, zh } from '../src/client/locales.ts'
import type { WorkBuddyWebSearchPath } from '../src/status-paths.ts'

/**
 * Every reason the type allows, spelled out rather than derived from
 * `Object.keys` of the tables: a reason added to the union without copy, a
 * locale key, or a place in the grouping rules must fail a test, and a
 * self-updating list would hide exactly that.
 */
const ALL_REASONS = ['missing', 'unreadable', 'invalid', 'encrypted', 'wrong-region'] as const

/** A `resolve()`-style error that enumerates paths, as the Host really emits. */
const RESOLVE_MESSAGE
  = 'workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app'
    + ' (expected C:\\Users\\u\\AppData\\Local\\...\\workbuddy-desktop.info or WORKBUDDY_AUTH_FILE),'
    + ' or refresh an existing session'

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
    // are genuine findings too, and `wrong-region` is the strongest finding of
    // all — the user IS signed in, just on the other tab. Only a plain absence
    // may be hidden.
    expect([...INTERESTING_REASONS].sort()).toEqual(['encrypted', 'invalid', 'unreadable', 'wrong-region'])
    const view = searchedView([
      failure('missing'),
      failure('encrypted'),
      failure('invalid'),
      failure('unreadable'),
      failure('wrong-region'),
    ])
    expect(view.interesting).toHaveLength(4)
    expect(view.missing).toHaveLength(1)
  })

  it('groups EVERY reason in the union, so a new one cannot fall through', () => {
    // Guards the failure mode this suite just hit: a reason added to the union
    // lands in `missing` by default, which HIDES it behind the toggle — the
    // opposite of what a finding needs.
    for (const reason of ALL_REASONS) {
      const view = searchedView([failure(reason)])
      const grouped = reason === 'missing' ? view.missing : view.interesting
      expect(grouped.map(item => item.reason)).toEqual([reason])
    }
  })

  it('flags encrypted whenever any entry is encrypted', () => {
    const view = searchedView([failure('missing'), failure('encrypted')])
    expect(view.encrypted).toBe(true)
  })
})

describe('searchReasonKey', () => {
  it('maps each reason to its own copy key', () => {
    const keys = ALL_REASONS.map(searchReasonKey)
    expect(keys).toEqual([
      'row.reasonMissing',
      'row.reasonUnreadable',
      'row.reasonInvalid',
      'row.reasonEncrypted',
      'row.reasonWrongRegion',
    ])
    // Each reason must be distinguishable: two reasons sharing copy would make
    // the encrypted case look like a plain absence again.
    expect(new Set(keys).size).toBe(ALL_REASONS.length)
  })

  it('has copy for every reason in both locales', () => {
    // The `zh` table is typed against `en`, but an empty string would satisfy
    // the type and render as a blank cause.
    for (const reason of ALL_REASONS) {
      const key = searchReasonKey(reason)
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
      expect(zh[key]).not.toBe(en[key])
    }
  })

  it('gives each reason DISTINCT copy in each locale', () => {
    // Five reasons exist precisely so they read as five different situations.
    // If `encrypted` shared `missing`'s text, the whole feature would collapse
    // back into "the file was not found" while every other test still passed.
    const keys = ALL_REASONS.map(searchReasonKey)
    for (const table of [en, zh]) {
      const texts = keys.map(key => table[key])
      expect(new Set(texts).size).toBe(ALL_REASONS.length)
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
    // `searchReasonKey` is a lookup table, so a reason missing from it would
    // silently render as `invalid`. Assert each label carries ITS OWN key.
    for (const reason of ALL_REASONS) {
      expect(searchReasonLabel(failure(reason), echo)).toContain(searchReasonKey(reason))
    }
    expect(new Set(ALL_REASONS.map(reason => searchReasonLabel(failure(reason), echo))).size)
      .toBe(ALL_REASONS.length)
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

describe('signedOutNotice', () => {
  it('does NOT repeat the resolve() path list when a probed list is rendered', () => {
    // The reported bug: the paragraph echoed `resolve()`'s "expected <a> or <b>
    // or WORKBUDDY_AUTH_FILE" and the <details> below listed those same paths
    // with reasons. Both hints also said "no sign-in was found", so one screen
    // stated one fact four times.
    const notice = signedOutNotice({
      selectionLost: false,
      message: RESOLVE_MESSAGE,
      searched: [failure('missing', '/a'), failure('missing', '/b')],
    })
    expect(notice.fallback).toBeUndefined()
    expect(notice.key).toBe('row.signedOutHint')

    // Assert on the string actually rendered, not just on the inputs: this is
    // the guarantee that was violated.
    const rendered = signedOutText(notice, key => zh[key])
    expect(rendered).toBe(zh['row.signedOutHint'])
    expect(rendered).not.toContain('workbuddy-desktop.info')
    expect(rendered).not.toContain('WORKBUDDY_AUTH_FILE')
    expect(rendered).not.toContain('no signed-in WorkBuddy account')
  })

  it('renders the Host message when the fallback DOES apply', () => {
    const rendered = signedOutText(
      signedOutNotice({ selectionLost: false, message: RESOLVE_MESSAGE, searched: [] }),
      key => zh[key],
    )
    expect(rendered).toContain(RESOLVE_MESSAGE)
    expect(rendered).toContain(zh['row.signedOutHint'])
  })

  it('opens with copy that does not itself re-announce "no sign-in"', () => {
    // The list's own summary is "Paths checked"; the paragraph above it says
    // the situation. Neither may also restate the absence the third time.
    expect(zh['row.searchedHint']).not.toContain('未找到登录信息')
    expect(en['row.searchedHint']).not.toContain('No sign-in was found')
  })

  it('still shows the Host message when nothing was probed at all', () => {
    // Then it is not a duplicate — it is the only account of what happened, and
    // dropping it would leave a bare "sign in once" with no explanation.
    const notice = signedOutNotice({ selectionLost: false, message: RESOLVE_MESSAGE, searched: [] })
    expect(notice.fallback).toBe(RESOLVE_MESSAGE)
  })

  it('leaves the hint alone when the Host sent no message', () => {
    const notice = signedOutNotice({ selectionLost: false, message: undefined, searched: [] })
    expect(notice.fallback).toBeUndefined()
    expect(notice.key).toBe('row.signedOutHint')
  })

  it('leads with the wrong-region fix instead of "not signed in"', () => {
    // The user IS signed in; telling them to sign in again is the one action
    // that cannot help, and burying the real fix in a collapsed list hides it.
    const notice = signedOutNotice({
      selectionLost: false,
      message: RESOLVE_MESSAGE,
      searched: [failure('wrong-region', '/a'), failure('missing', '/b')],
    })
    expect(notice.key).toBe('row.signedOutWrongRegion')
    expect(notice.fallback).toBeUndefined()
  })

  it('lets an orphaned saved id outrank everything', () => {
    // Tokens are healthy there; only re-picking an account helps, and no path
    // list or region hint may replace that advice.
    for (const searched of [[], [failure('wrong-region')], [failure('encrypted')]]) {
      const notice = signedOutNotice({ selectionLost: true, message: RESOLVE_MESSAGE, searched })
      expect(notice.key).toBe('row.selectionLostMessage')
      expect(notice.fallback).toBeUndefined()
    }
  })

  it('never returns copy that is missing from a locale', () => {
    for (const table of [en, zh]) {
      expect(table['row.signedOutWrongRegion'].length).toBeGreaterThan(0)
    }
    expect(zh['row.signedOutWrongRegion']).not.toBe(en['row.signedOutWrongRegion'])
  })
})
