/**
 * ISSUE #316 — a 401 must say WHICH credential was refused, and must not invent the cause.
 *
 * The reporter had six auth files on disk for two accounts, with different
 * `domain`/`expiresAtMs`, and could not answer the one question that would have
 * localised the bug: "which file did this request read?" The error named no
 * file at all, and the same token worked when used directly — so the advice it
 * DID give ("a stale credential file, sign in again") pointed at a fix that
 * could not work.
 *
 * Two separate defects, both fixed here:
 *   1. no provenance — nothing identified which copy of the credential was used;
 *   2. a hard-coded cause — "most likely a stale credential file" was asserted
 *      as fact. `account-pool-run.ts` already records why that class of guess is
 *      dangerous: it sends users to repair a sign-in that is fine.
 *
 * The privacy rule that constrains the fix: NEVER the token, and never a `uid`
 * or `uin`, because on the CN side those are phone numbers and this string is
 * exactly what a reporter pastes into a public issue.
 *
 * @module dsh-connect-workbuddy/tests/issue316-401-provenance
 */
import { describe, expect, it } from 'vitest'
import {
  WorkBuddyCredentialRejectedError,
  isCredentialRejectedError,
  provenanceOf,
} from '../src/upstream.ts'

const CREDENTIAL = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAtMs: 1_812_001_890_181,
  domain: 'www.codebuddy.cn',
  uid: 'uid-100000000001',
  uin: '100000000001',
  source: 'desktop',
  filePath: '/Users/<you>/.dsh/auth-account.info',
}

describe('issue #316: a 401 names the credential it used', () => {
  it('reports the file, domain, expiry and source', () => {
    const error = new WorkBuddyCredentialRejectedError(401, provenanceOf(CREDENTIAL))
    // The four facts that tell several copies of the same account apart.
    expect(error.message).toContain('/Users/<you>/.dsh/auth-account.info')
    expect(error.message).toContain('www.codebuddy.cn')
    expect(error.message).toContain('2027-06-03T05:51:30.181Z')
    expect(error.message).toContain('source desktop')
  })

  it('never carries the token, the refresh token, the uid or the uin', () => {
    const error = new WorkBuddyCredentialRejectedError(401, provenanceOf(CREDENTIAL))
    expect(error.message).not.toContain('access-token-value')
    expect(error.message).not.toContain('refresh-token-value')
    // #234's rule: a uin is a phone number. It must not reach a pasteable string.
    expect(error.message).not.toContain('100000000001')
    expect(error.message).not.toContain('uid-100000000001')
    expect(JSON.stringify(error.provenance)).not.toContain('token')
  })

  it('does not assert a cause it cannot know', () => {
    // The old text said "most likely a stale credential file from an earlier
    // sign-in". #316 measured a case where the sign-in was fine and the refusal
    // tracked a desktop-side account switch, so the advice was wrong.
    const error = new WorkBuddyCredentialRejectedError(401, provenanceOf(CREDENTIAL))
    expect(error.message).not.toContain('most likely')
    // Possibilities are still offered, as possibilities.
    expect(error.message).toContain('Causes include')
  })

  it('still works without provenance, for the paths that have none', () => {
    const error = new WorkBuddyCredentialRejectedError(401)
    expect(error.message).toContain('http 401')
    expect(error.message).not.toContain('Credential used')
    expect(error.provenance).toBeUndefined()
    // The class check is unchanged — callers rely on it across module instances.
    expect(isCredentialRejectedError(error)).toBe(true)
  })

  it('omits fields the credential does not carry instead of printing undefined', () => {
    const bare = new WorkBuddyCredentialRejectedError(401, provenanceOf({ domain: 'www.workbuddy.cn' }))
    expect(bare.message).toContain('an unknown file')
    expect(bare.message).not.toContain('undefined')
    expect(bare.message).not.toContain('expires')
  })
})
