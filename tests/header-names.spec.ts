import { describe, expect, it } from 'vitest'
import { describeRequestHeaderNames } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * `describeRequestHeaderNames` is the diagnostic view `doctor` prints, so it has
 * to answer exactly what the request path sends. These tests pin the two things
 * that could silently drift:
 *
 *   1. it must keep delegating to the real builders (a header added there shows
 *      up here without an edit), and
 *   2. the two known asymmetries of 5.16.0 must be visible, not papered over.
 */

const credential: WorkBuddyCredential = {
  accessToken: 'access-token-fixture',
  refreshToken: 'refresh-token-fixture',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'u-1',
  enterpriseId: 'ent-1',
  source: 'desktop',
  filePath: '/tmp/workbuddy-desktop.info',
}

describe('describeRequestHeaderNames', () => {
  it('folds the call-site Authorization into the chat answer', () => {
    // `chatHeaders` does not build it — `chatStream` merges it at the call site
    // (:3739 / :3810). Without this the report would claim chat is unauthenticated.
    const names = describeRequestHeaderNames('chat', credential)
    expect(names).toContain('Authorization')
    expect(names).toContain('X-Conversation-Request-ID')
    expect(names).toContain('X-Product')
  })

  it('keeps the conversation triple, which the gateways require', () => {
    expect(describeRequestHeaderNames('chat', credential)).toEqual(expect.arrayContaining([
      'X-Conversation-ID',
      'X-Conversation-Request-ID',
      'X-Conversation-Message-ID',
    ]))
  })

  it('hides X-IDE-* until usageIdentity is on', () => {
    expect(describeRequestHeaderNames('chat', credential)).not.toContain('X-IDE-Name')
    expect(describeRequestHeaderNames('chat', credential, { usageIdentity: true })).toContain('X-IDE-Name')
  })

  it('sends no device header on any path — the audit’s D1', () => {
    // The one assertion that makes "P0 changed nothing on the wire" checkable
    // for every path, not just chat. P1 flips the first two; P2/P3 the third.
    for (const kind of ['chat', 'image', 'refresh', 'billing'] as const) {
      const names = describeRequestHeaderNames(kind, credential)
      expect(names, kind).not.toContain('X-Device-Token')
      expect(names, kind).not.toContain('X-Machine-ID')
      expect(names, kind).not.toContain('X-Session-ID')
    }
  })

  it('keeps billing as the thin path it is today (audit D2)', () => {
    // Pinned on purpose. Billing is the ONE path with no User-Agent, no
    // Origin/Referer and no X-CodeBuddy-Request, so the same token presents two
    // different client shapes a second apart. When P1 closes that gap this test
    // must be rewritten — and that rewrite is the review checkpoint.
    const names = describeRequestHeaderNames('billing', credential)
    expect(names).toContain('Authorization')
    expect(names).toContain('X-Tenant-Id')
    expect(names).not.toContain('User-Agent')
    expect(names).not.toContain('Origin')
    expect(names).not.toContain('X-Requested-With')
  })

  it('keeps refresh authenticated by its own header, not by Bearer', () => {
    const names = describeRequestHeaderNames('refresh', credential)
    expect(names).toContain('X-Refresh-Token')
    expect(names).not.toContain('Authorization')
  })

  it('returns names only — never a value', () => {
    // This output is pasted into issues. A single value here would leak the very
    // tokens the rest of `doctor` is careful to redact.
    for (const kind of ['chat', 'image', 'refresh', 'billing'] as const) {
      for (const name of describeRequestHeaderNames(kind, credential)) {
        expect(name, `${kind}: ${name}`).not.toContain('Bearer')
        expect(name).not.toContain(credential.accessToken)
        expect(name).not.toContain(credential.refreshToken)
      }
    }
  })
})
