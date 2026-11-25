/**
 * ISSUE #314 — sub-path-safe request URLs.
 *
 * When DSH is mounted under a path prefix (e.g. a NAS gateway serving it at
 * `/app/dsh/`), a hardcoded `fetch('/plugins/...')` resolves against the site
 * ROOT and loses the prefix. The gateway then answers its own HTML page and the
 * card's `response.json()` throws `Unexpected token '<'`. DSH itself resolves
 * its own API paths against `document.baseURI`; these tests pin the plugin's
 * equivalent, with the base injected so they run in Node.
 *
 * @module dsh-connect-workbuddy/tests/request-url
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveRequestUrl } from '../src/client/request-url.ts'

const PATH = '/plugins/dsh-connect-workbuddy/oauth?region=cn&action=start'

describe('resolveRequestUrl (issue #314)', () => {
  it('leaves the path unchanged at the site root (direct / desktop deployment)', () => {
    expect(resolveRequestUrl(PATH, 'http://127.0.0.1:28000/')).toBe(PATH)
    expect(resolveRequestUrl(PATH, 'dsh-app://app/')).toBe(PATH)
  })

  it('prepends a gateway sub-path when DSH is mounted under one', () => {
    expect(resolveRequestUrl(PATH, 'http://nas.example:5666/app/dsh/'))
      .toBe('/app/dsh/plugins/dsh-connect-workbuddy/oauth?region=cn&action=start')
  })

  it('keeps query strings and never changes the origin', () => {
    const out = resolveRequestUrl('/plugins/x?a=1&b=2', 'http://nas.example:5666/app/dsh/')
    expect(out).toBe('/app/dsh/plugins/x?a=1&b=2')
    // Origin-relative result only — no scheme/host, so same-origin credentials
    // keep their meaning and no base can redirect the request off-box.
    expect(out.startsWith('/')).toBe(true)
    expect(out).not.toContain('://')
  })

  it('handles a base with query/hash and an unparseable input safely', () => {
    expect(resolveRequestUrl('/plugins/x', 'http://nas.example:5666/app/dsh/?q=1#f'))
      .toBe('/app/dsh/plugins/x')
    expect(resolveRequestUrl(PATH, undefined)).toBe(PATH)
    expect(resolveRequestUrl(PATH, 'not a url')).toBe(PATH)
  })
})

describe('issue #314: every client fetch of a plugin route goes through resolveRequestUrl', () => {
  // Source guard: a new route added with a bare `fetch('/plugins/...')` would
  // silently break sub-path deployments (the exact defect #314 reports), and
  // behavioural tests at the site root cannot see it. This is the only way to
  // catch "the next caller forgot to wrap" without a browser at that base.
  it('has no bare absolute plugin-path fetch in any client module', () => {
    const files = [
      'account-selection.ts', 'device-sdk.ts', 'device-profile.ts',
      'WorkBuddyCard.tsx', 'AccountPool.tsx', 'AccountTransfer.tsx',
      'ComposerCredits.tsx', 'OAuthSignIn.tsx', 'WorkBuddyModelLabel.tsx',
      'CodebuddyLive.tsx', 'index.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
      // Strip lines that already wrap with resolveRequestUrl before checking,
      // so a correctly-wrapped call is not mistaken for a bare one.
      const bare = source.split('\n').filter(line =>
        /fetch\(\s*['"`]\/plugins\//u.test(line)
        || /fetch\(\s*`\$\{?path/u.test(line) && !line.includes('resolveRequestUrl'),
      )
      expect(bare, `${file} must wrap plugin-path fetches with resolveRequestUrl`).toEqual([])
    }
  })

  it('wraps the inline __save literal, which has no path constant', () => {
    const source = readFileSync(new URL('../src/client/account-selection.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/fetch\(resolveRequestUrl\('\/plugins\/dsh-connect-workbuddy\/__save'\)/u)
  })
})
