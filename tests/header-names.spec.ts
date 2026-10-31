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

  it('sends X-Device-Token only when a token was actually supplied', () => {
    // P2: the token is optional and comes from a file; when it is absent the
    // header must not appear at all (a header with an empty value is worse than
    // no header — it claims a device identity that was never resolved).
    expect(describeRequestHeaderNames('chat', credential, { deviceSalt: SALT })).not.toContain('X-Device-Token')
    for (const kind of ['chat', 'image', 'billing'] as const) {
      expect(describeRequestHeaderNames(kind, credential, { deviceSalt: SALT, deviceToken: 'v3:abc' }), kind)
        .toContain('X-Device-Token')
    }
    // refresh 不参与身份统一，永远不带。
    expect(describeRequestHeaderNames('refresh', credential, { deviceSalt: SALT, deviceToken: 'v3:abc' }))
      .not.toContain('X-Device-Token')
  })

  it('never sends the token in the conservative tier', () => {
    // conservative 的契约是"逐字节等于 5.16.0"，而 5.16.0 从不发这个头。
    const names = describeRequestHeaderNames('chat', credential, { profile: 'conservative', deviceToken: 'v3:abc' })
    expect(names).not.toContain('X-Device-Token')
  })

  it('reports one header, not three, in the real tier (P3)', () => {
    // 真实值档下派生对不发——这条清单必须与真实请求一致，否则 `doctor` 会声称
    // 一条请求带了三个设备头，而它只带了一个。
    const real = describeRequestHeaderNames('chat', credential, {
      deviceSalt: SALT,
      deviceTier: 'real',
      deviceReal: 'v3:real',
    })
    expect(real).toContain('X-Device-Token')
    expect(real).not.toContain('X-Machine-ID')
    expect(real).not.toContain('X-Session-ID')
  })

  it('reports NO device header when the real tier has no token', () => {
    // 这一档在 SDK 不可用时是"一个设备头都不发"，而不是退回派生对。少了这条，
    // 报告里的空数组会被读成"设备层没接线"，而实际原因是"取不到真值"。
    const real = describeRequestHeaderNames('chat', credential, { deviceSalt: SALT, deviceTier: 'real' })
    expect(real).not.toContain('X-Device-Token')
    expect(real).not.toContain('X-Machine-ID')
    expect(real).not.toContain('X-Session-ID')
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
