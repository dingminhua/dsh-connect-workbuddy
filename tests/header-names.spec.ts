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
 *   2. the price of P1 — which headers appear in which tier — must be visible.
 */

const SALT = 'a'.repeat(64)

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
    // `chatHeaders` does not build it — `chatStream` merges it at the call site.
    // Without this the report would claim chat is unauthenticated.
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

  it('sends the client identity in the default tier, with or without usageIdentity', () => {
    // P1 moved X-IDE-* off the `usageIdentity` switch: "who this client is" and
    // "which id format it writes" are different decisions, and the first one now
    // holds for every balanced request.
    expect(describeRequestHeaderNames('chat', credential)).toContain('X-IDE-Name')
    expect(describeRequestHeaderNames('chat', credential, { usageIdentity: true })).toContain('X-IDE-Name')
  })

  it('drops the whole identity family in the conservative tier', () => {
    const names = describeRequestHeaderNames('chat', credential, { profile: 'conservative' })
    for (const name of ['X-IDE-Name', 'X-IDE-Type', 'X-Agent-Purpose', 'X-CodeBuddy-Request', 'Accept-Language', 'X-Root-Request-ID']) {
      expect(names, name).not.toContain(name)
    }
    // Still authenticated and still a conversation, though.
    expect(names).toContain('Authorization')
    expect(names).toContain('X-Conversation-ID')
  })

  it('reports the device pair only when the salt is actually available', () => {
    // The pair is derived FROM the salt; without one there is nothing to send,
    // and reporting it anyway would make `doctor` claim an identity the request
    // never carried.
    expect(describeRequestHeaderNames('chat', credential)).not.toContain('X-Machine-ID')
    const withSalt = describeRequestHeaderNames('chat', credential, { deviceSalt: SALT })
    expect(withSalt).toContain('X-Machine-ID')
    expect(withSalt).toContain('X-Session-ID')
  })

  it('never sends X-Device-Token from this tier — that is P2/P3', () => {
    // A real token alongside derived machine/session ids is the self-
    // contradiction the audit's §5.3 warns about. This assertion is the tripwire
    // for anyone wiring the token source without splitting the tiers first.
    for (const kind of ['chat', 'image', 'refresh', 'billing'] as const) {
      expect(describeRequestHeaderNames(kind, credential, { deviceSalt: SALT }), kind).not.toContain('X-Device-Token')
    }
  })

  it('closes the billing gap the audit called D2', () => {
    // Before P1 the same token presented two clients a second apart: chat with a
    // UA, Origin and identity; billing as a bare HTTP client with none of them.
    const names = describeRequestHeaderNames('billing', credential, { deviceSalt: SALT })
    expect(names).toContain('Authorization')
    expect(names).toContain('X-Tenant-Id')
    expect(names).toContain('User-Agent')
    expect(names).toContain('Origin')
    expect(names).toContain('Referer')
    expect(names).toContain('X-Requested-With')
    expect(names).toContain('X-CodeBuddy-Request')
    expect(names).toContain('X-Product')
    expect(names).toContain('X-Machine-ID')
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
      for (const name of describeRequestHeaderNames(kind, credential, { deviceSalt: SALT })) {
        expect(name, `${kind}: ${name}`).not.toContain('Bearer')
        expect(name).not.toContain(credential.accessToken)
        expect(name).not.toContain(credential.refreshToken)
        expect(name).not.toContain(SALT)
      }
    }
  })
})
