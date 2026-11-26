/**
 * ISSUE #316 — a gateway 401 is ITS OWN CLASS, and it must say which credential it refused.
 *
 * The reporter shipped 5.32.1, triggered the failure, and got no provenance —
 * because the 401 reached him through a different path than the fix covered:
 *
 *   - `WorkBuddyCredentialRejectedError` was only constructed from a BUSINESS
 *     envelope (a JSON body with a code). A gateway edge refusal is raw HTML, so
 *     it fell through to `classifyUpstreamError` → `client`;
 *   - `client` means "the request's PARAMETERS are wrong: no account can help".
 *     The reply therefore said 「该请求被上游按参数拒绝：与网络、账号、额度都无关」
 *     while the same token answered 200 + SSE on all six host×account
 *     combinations he tried. The advice pointed at a fix that cannot work;
 *   - and provenance lived only on that unused class, so the diagnostic was
 *     silent exactly where it was needed.
 *
 * The two wrong answers that were available, and why neither is used:
 *   - `client` — see above; it asserts something about parameters that an edge
 *     page cannot know;
 *   - `session_dead` — issue #305 disproved it: an HTML page is not proof the
 *     credential was revoked. Only a `12153`/`Offline user session not found`
 *     business body, or a 401/403 on the refresh hop, is.
 *
 * @module dsh-connect-workbuddy/tests/issue316-gateway-auth
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'
import { classifyUpstreamError } from '../src/upstream.ts'

/** The exact body the reporter pasted (his 5.32.1 failure). */
const APISIX_HTML = '<html> <head><title>401 Authorization Required</title></head> <body>'
  + ' <center><h1>401 Authorization Required</h1></center> <hr><center>openresty</center>'
  + ' <p><em>Powered by <a href="https://apisix.apache.org/">APISIX</a>.</em></p></body> </html>'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAtMs: 1_812_001_890_181,
  domain: 'www.codebuddy.cn',
  uid: 'uid-100000000001',
  uin: '100000000001',
  source: 'desktop',
  filePath: '/Users/<you>/.dsh/auth-accountA.info',
}

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

describe('issue #316: a gateway edge refusal is classified as gateway_auth', () => {
  it('classifies an APISIX/openresty 401 page as gateway_auth, not client', () => {
    expect(classifyUpstreamError(401, APISIX_HTML)).toBe('gateway_auth')
    expect(classifyUpstreamError(403, APISIX_HTML)).toBe('gateway_auth')
  })

  it('does NOT reclassify a business JSON 401 — that is still the credential path', () => {
    // #305's lesson must survive: only the edge HTML gets its own kind. A JSON
    // envelope still goes through `envelopeError`, which is what constructs the
    // credential-rejected error.
    expect(classifyUpstreamError(401, '{"code":0,"msg":"unauthorized"}')).toBe('client')
  })

  it('leaves a plain 400 as client', () => {
    expect(classifyUpstreamError(400, '{"code":10001,"msg":"bad param"}')).toBe('client')
  })
})

describe('issue #316: the reply names the credential and stops blaming parameters', () => {
  async function replyFor(result: WorkBuddyChatResult): Promise<{ status: number, text: string }> {
    shim = createWorkBuddyShim({
      store: { resolve: async () => CREDENTIAL, credentialFor: async () => CREDENTIAL } as never,
      catalog: new WorkBuddyCatalog(),
      client: { chatStream: async () => result } as never,
    })
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    return { status: response.status, text: await response.text() }
  }

  const reject = (provenance = true): WorkBuddyChatResult => ({
    ok: false,
    status: 401,
    kind: 'gateway_auth',
    message: APISIX_HTML,
    ...provenance
      ? {
          provenance: {
            filePath: CREDENTIAL.filePath,
            domain: CREDENTIAL.domain,
            expiresAtMs: CREDENTIAL.expiresAtMs,
            source: CREDENTIAL.source,
          },
        }
      : {},
  })

  it('reports which file was used', async () => {
    const { text } = await replyFor(reject())
    expect(text, 'the provenance line the reporter asked for').toContain('凭据来源')
    expect(text).toContain('auth-accountA.info')
    expect(text).toContain('www.codebuddy.cn')
    expect(text).toContain('2027-06-03T05:51:30.181Z')
  })

  it('does NOT say the request was refused on its parameters', async () => {
    // The sentence the reporter measured to be false: his token answered 200
    // directly on six host×account combinations.
    const { text } = await replyFor(reject())
    expect(text).not.toContain('按参数拒绝')
    expect(text).toContain('边缘拒绝')
  })

  it('never puts the token or a phone number into the reply', async () => {
    const { text } = await replyFor(reject())
    expect(text).not.toContain('access-token-value')
    expect(text).not.toContain('100000000001')
  })

  it('still answers usefully when a Host supplies no provenance', async () => {
    const { status, text } = await replyFor(reject(false))
    expect(status).toBe(401)
    expect(text).toContain('边缘拒绝')
    expect(text).not.toContain('凭据来源')
  })
})
