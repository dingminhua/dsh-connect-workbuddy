/**
 * Pool failover in the chat path: the retry loop itself.
 *
 * The policy (which pool member counts as usable, and in what order) lives in
 * `src/index.ts` and is covered there; this file pins the WIRE rule the shim
 * owns — that a failed request may be re-sent against another account, under
 * exactly which failures, and what happens when nobody is left.
 *
 * The distinction that matters most here: a `client` failure is NOT retried.
 * The upstream rejected the request itself, so every account answers the same
 * 400 and walking the pool would only multiply the wait before the user sees an
 * error they must act on anyway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rankPool } from '../src/account-pool.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { workbuddyAccountId } from '../src/auth.ts'
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from '../src/auth.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyChatResult, WorkBuddyUpstreamClient } from '../src/upstream.ts'

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined; attempts.length = 0 })

/** A credential for a distinct account, keyed by `uin`. */
function credentialFor(uin: string): WorkBuddyCredential {
  return {
    accessToken: `access-${uin}`,
    refreshToken: `refresh-${uin}`,
    expiresAtMs: Date.now() + 86_400_000,
    domain: 'www.codebuddy.cn',
    uid: `uid-${uin}`,
    uin,
    source: 'desktop',
    filePath: `/tmp/auth-${uin}.info`,
  }
}

const SELECTED = credentialFor('selected')
const SELECTED_ID = workbuddyAccountId(SELECTED)

/** A store whose selection never moves, which is the whole point. */
function storeWith(others: readonly WorkBuddyCredential[], selected: WorkBuddyCredential = SELECTED): WorkBuddyCredentialStore {
  const byId = new Map([selected, ...others].map(c => [workbuddyAccountId(c), c]))
  return {
    resolve: async () => selected,
    credentialFor: async (accountId: string) => byId.get(accountId),
  } as unknown as WorkBuddyCredentialStore
}

type Failover = (triedAccountIds: readonly string[]) => Promise<WorkBuddyCredential | undefined>

/** Account ids the shim has sent, in order, across every mounted shim. */
const attempts: string[] = []

function mount(options: {
  chatStream: (credential: WorkBuddyCredential, body: string) => Promise<WorkBuddyChatResult>
  failover?: Failover
  others?: readonly WorkBuddyCredential[]
  /** The account `resolve()` returns; `SELECTED` unless a test needs a name. */
  selected?: WorkBuddyCredential
  shortfall?: () => Promise<string | undefined>
  logger?: { warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }
}): WorkBuddyShim {
  const client = {
    chatStream: async (credential: WorkBuddyCredential, body: string) => {
      attempts.push(workbuddyAccountId(credential))
      return await options.chatStream(credential, body)
    },
  } as unknown as WorkBuddyUpstreamClient
  return createWorkBuddyShim({
    store: storeWith(options.others ?? [], options.selected),
    client,
    catalog: new WorkBuddyCatalog(),
    ...options.logger === undefined ? {} : { logger: options.logger },
    ...options.failover === undefined ? {} : { failoverAccount: options.failover },
    ...options.shortfall === undefined ? {} : { failoverShortfall: options.shortfall },
  })
}

/** The account ids sent during ONE test, reset per `it`. */
function attemptsOf(): string[] {
  return attempts
}

/** Drive a chat completion through the shim, as the plugin's own client does. */
async function chat(instance: WorkBuddyShim, body = '{"messages":[]}'): Promise<{ status: number, body: string }> {
  const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
    body,
  })
  return { status: response.status, body: await response.text() }
}

const RATE_LIMITED: WorkBuddyChatResult = {
  ok: false,
  status: 429,
  kind: 'soft_rate',
  message: '您的使用量已超出频率限制，将在 2026-10-02 05:23:27 UTC+8 重置，您也可以切换其他模型继续使用。',
}

/**
 * The reporter's 14003 body from issue #56, verbatim.
 *
 * `kind` is set by `classifyUpstreamError` in production; this fixture states it
 * directly because the shim's contract is about what it DOES with a classified
 * failure, not about how it was classified (that is covered in
 * `issue56-model-scoped-throttle.spec.ts`).
 */
const MODEL_BUSY_MESSAGE = '{"code":14003,"msg":"too many requests","requestId":"00dc90c7-f7b6-40ad-8960-a00c2d92b567","displayMsg":{"en":"Too many requests. Please retry later.","zh":"请求过于频繁，请稍后重试。"},"displayTips":{"en":"Wait about a minute before retrying, or switch to a less busy model.","zh":"建议等待约 1 分钟后重试，或切换到负载较低的模型。"}}'

function ok(): WorkBuddyChatResult {
  return { ok: true, response: new Response('data: [DONE]\n\n', { status: 200 }) }
}

describe('pool failover: retrying a failed chat on another account', () => {
  it('retries against the next account and streams the answer it gives', async () => {
    const other = credentialFor('other')
    const seen: string[] = []
    shim = mount({
      others: [other],
      chatStream: async credential => {
        seen.push(credential.uin ?? '')
        // The selected account is limited; the fallback serves the request.
        return seen.length === 1 ? RATE_LIMITED : ok()
      },
      failover: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
    })
    await shim.ready

    const response = await chat(shim)
    expect(seen).toEqual(['selected', 'other'])
    // Served, not refused: the client sees a normal stream.
    expect(response.status).toBe(200)
    expect(response.body).toContain('[DONE]')
    expect(attemptsOf()).toEqual([SELECTED_ID, workbuddyAccountId(other)])
  })

  it('does NOT retry a failure the request itself caused', async () => {
    // A 400 means the BODY was rejected. Every account answers the same way, so
    // walking the pool would burn N round trips to reach the same error.
    const other = credentialFor('other')
    let calls = 0
    shim = mount({
      others: [other],
      chatStream: async () => {
        calls += 1
        return { ok: false, status: 400, kind: 'client', message: 'bad request' }
      },
      failover: async () => other,
    })
    await shim.ready

    const response = await chat(shim)
    expect(calls).toBe(1)
    expect(response.status).toBe(400)
  })

  it('retries each of the per-account failure classes', async () => {
    // Rate limit, exhausted credits, a dead session and a gateway error all
    // describe ONE account's state, so another may well survive them.
    for (const kind of ['soft_rate', 'hard_credit', 'session_dead', 'server', 'not_found'] as const) {
      const other = credentialFor(`other-${kind}`)
      const seen: string[] = []
      shim = mount({
        others: [other],
        chatStream: async credential => {
          seen.push(credential.uin ?? '')
          return seen.length === 1 ? { ok: false, status: 429, kind, message: 'nope' } : ok()
        },
        failover: async () => other,
      })
      await shim.ready
      const response = await chat(shim)
      expect(seen, `kind=${kind} should have failed over`).toEqual(['selected', `other-${kind}`])
      expect(response.status).toBe(200)
      await shim.close()
      shim = undefined
    }
  })

  it('fails over an account the upstream RESTRICTED, and benches it (issue #127)', async () => {
    // The other half of the #127 split, which had no test at all: mutating
    // `isFailoverWorthy` to drop `account_restricted` left the whole suite green,
    // so nothing pinned the one behaviour that makes this class differ from a
    // content-policy refusal. A restricted credential is the ACCOUNT's problem —
    // the next member may well answer — whereas `policy_reject` on the same
    // `11140` code is a request-side refusal that another account cannot fix.
    const other = credentialFor('other-restricted')
    const seen: string[] = []
    shim = mount({
      others: [other],
      chatStream: async credential => {
        seen.push(credential.uin ?? '')
        return seen.length === 1
          ? {
            ok: false,
            status: 400,
            kind: 'account_restricted',
            message: '{"code":11140,"msg":"request illegal","displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}',
          }
          : ok()
      },
      failover: async () => other,
    })
    await shim.ready
    const response = await chat(shim)
    expect(seen, 'a restricted account is the account\u2019s problem, so the next member is tried').toEqual([
      'selected',
      'other-restricted',
    ])
    expect(response.status).toBe(200)
    await shim.close()
    shim = undefined
  })

  it('does NOT walk the pool for a MODEL-scoped throttle (issue #56)', async () => {
    // The 14003 limit belongs to the model, so a second account answers the same
    // 14003 one round trip later — and each attempt writes a rate-limited
    // measurement onto an account that was never the problem. The reporter's
    // measurement is what makes this decidable: same credential, same second,
    // other models answered 3/3.
    const other = credentialFor('other')
    const seen: string[] = []
    shim = mount({
      others: [other],
      chatStream: async credential => {
        seen.push(credential.uin ?? '')
        return { ok: false, status: 429, kind: 'model_busy', message: MODEL_BUSY_MESSAGE }
      },
      // The pool is HAPPY to offer another account; the shim must not ask.
      failover: async () => other,
    })
    await shim.ready

    const response = await chat(shim)
    expect(seen).toEqual(['selected'])
    expect(response.status).toBe(429)
  })

  it('tells the user the model is busy rather than blaming their account', async () => {
    shim = mount({
      chatStream: async () => ({ ok: false, status: 429, kind: 'model_busy', message: MODEL_BUSY_MESSAGE }),
    })
    await shim.ready

    const response = await chat(shim)
    // `code` names the class honestly now: spelling it `quota_exceeded` (as
    // issues #56 and #63 did) made the host classify a busy model as an
    // exhausted balance and replace this message with 「当前请求的额度已用尽」
    // (issue #84). Untranslated, the host reads `RATE_LIMIT` — outside its
    // substitution list, so the sentence below is what the user sees, and
    // inside its in-place retry set, so a transient 14003 is retried.
    expect(response.body).toContain('"code":"model_busy"')
    expect(response.body).toContain('"type":"model_busy"')
    expect(response.body).not.toContain('quota_exceeded')
    // The three things the user needs: it is not the account, what to do, and the
    // upstream's own words as the receipt.
    expect(response.body).toContain('这不是账号被限流')
    expect(response.body).toContain('等待约 1 分钟')
    expect(response.body).toContain('请求过于频繁，请稍后重试。')
    // The count of accounts tried is absent because nobody else was tried.
    expect(response.body).not.toContain('已尝试')
  })

  it('reports the failure unchanged when the pool offers nobody else', async () => {
    shim = mount({
      chatStream: async () => RATE_LIMITED,
      failover: async () => undefined,
    })
    await shim.ready

    const response = await chat(shim)
    // 429 on the wire, with the upstream's own words — including the reset time,
    // which is what makes the error actionable. A failover that swallowed it for
    // a generic message would lose the only useful part.
    expect(response.status).toBe(429)
    const parsed = JSON.parse(response.body) as { error?: { message?: string }, message?: string }
    const text = JSON.stringify(parsed)
    expect(text).toContain('2026-10-02 05:23:27')
    // One attempt only: no candidates means no extra round trips.
    expect(attemptsOf()).toHaveLength(1)
  })

  it('says how many accounts were tried when the whole pool fails', async () => {
    const first = credentialFor('first')
    const second = credentialFor('second')
    const queue = [first, second]
    shim = mount({
      others: [first, second],
      chatStream: async () => RATE_LIMITED,
      failover: async tried => queue.find(c => !tried.includes(workbuddyAccountId(c))),
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(429)
    // Without the count, a pool that failed over and still lost is
    // indistinguishable from the single account the user selected failing.
    expect(response.body).toContain('已尝试 3 个账号')
    expect(attemptsOf()).toHaveLength(3)
  })

  it('does not retry the same account twice when the pool keeps offering it', async () => {
    // A policy bug (or a pool whose membership changed mid-request) must not
    // turn into an unbounded loop: the tried list is the loop's only brake.
    const other = credentialFor('other')
    const seen: string[] = []
    shim = mount({
      others: [other],
      chatStream: async credential => {
        seen.push(credential.uin ?? '')
        return RATE_LIMITED
      },
      // Always answers with the SAME account, whatever it was asked.
      failover: async () => other,
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(429)
    // The shim stops when the policy returns an account it already tried for
    // this request, rather than re-sending forever.
    expect(seen.length).toBeLessThanOrEqual(2)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('stops retrying once the client has gone away', async () => {
    // Retrying on behalf of a hung-up client spends another account's quota to
    // fill a socket nobody is reading. The shim learns about the hang-up from
    // the request's `close` event, so the first attempt WAITS for it before
    // failing — otherwise the test races the event loop and proves nothing.
    const other = credentialFor('other')
    let calls = 0
    let release: () => void = () => {}
    const gone = new Promise<void>(resolve => { release = resolve })
    shim = mount({
      others: [other],
      chatStream: async () => {
        calls += 1
        await gone
        return RATE_LIMITED
      },
      failover: async () => other,
    })
    await shim.ready

    const url = new URL(shim.baseUrl())
    const { connect } = await import('node:net')
    const socket = connect(Number(url.port), url.hostname)
    await new Promise<void>(resolve => socket.once('connect', () => resolve()))
    const payload = JSON.stringify({ messages: [] })
    socket.write(
      'POST /v1/chat/completions HTTP/1.1\r\n'
      + `Host: ${url.hostname}:${url.port}\r\n`
      + 'Content-Type: application/json\r\n'
      + `Authorization: Bearer ${shim.token()}\r\n`
      + `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    )
    // Hang up, as a user closing the panel does.
    socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 20))
    // Now let the first attempt fail: the close event has already landed, so
    // the retry guard sees it.
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toBe(1)
  })

  it('records NO measurement when the client hung up (D1b)', async () => {
    // The defect this pins: our OWN abort reaches the plugin as a transport
    // failure (`status: 0`, `kind: 'server'`), which is indistinguishable from a
    // dead network where the host reads it. It was therefore recorded as
    // `unavailable` — a statement about the ACCOUNT — even though nothing was
    // wrong with the account. One closed panel could idle a healthy member, and
    // once every member was idled the pool had no candidate at all, so failover
    // had nowhere to go and the raw upstream error was reported to the user.
    //
    // Same hang-up choreography as the test above: the attempt waits for the
    // socket to die, so the abort is observable rather than raced.
    const reports: string[] = []
    let release: () => void = () => {}
    const gone = new Promise<void>(resolve => { release = resolve })
    shim = createWorkBuddyShim({
      store: storeWith([]),
      client: {
        chatStream: async () => {
          await gone
          // Exactly what an aborted `fetch` produces in `chatStream`'s catch.
          return { ok: false, status: 0, kind: 'server', message: 'transport error: AbortError' }
        },
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      onAccountFailure: accountId => { reports.push(accountId) },
    })
    await shim.ready

    const url = new URL(shim.baseUrl())
    const { connect } = await import('node:net')
    const socket = connect(Number(url.port), url.hostname)
    await new Promise<void>(resolve => socket.once('connect', () => resolve()))
    const payload = JSON.stringify({ messages: [] })
    socket.write(
      'POST /v1/chat/completions HTTP/1.1\r\n'
      + `Host: ${url.hostname}:${url.port}\r\n`
      + 'Content-Type: application/json\r\n'
      + `Authorization: Bearer ${shim.token()}\r\n`
      + `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    )
    // Hang up, as a user closing the panel does.
    socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(reports).toEqual([])
  })

  it('names the failure class it is retrying, so the log is diagnosable', async () => {
    const other = credentialFor('other')
    const warn = vi.fn()
    shim = mount({
      others: [other],
      logger: { warn, error: vi.fn() },
      chatStream: async credential => (credential.uin === 'selected' ? RATE_LIMITED : ok()),
      failover: async () => other,
    })
    await shim.ready
    await chat(shim)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('soft_rate')
  })

  it('reads the selection exactly once per request, however many retries it makes', async () => {
    // Failover borrows a credential for ONE request. The selection is what the
    // NEXT request and the card read, and a retry that re-resolved it (or, worse,
    // re-resolved it after another retry moved something) is how "the dropdown
    // says A but B is billed" starts. One resolution, one request.
    const other = credentialFor('other')
    const resolve = vi.fn(async () => SELECTED)
    const store = { resolve } as unknown as WorkBuddyCredentialStore
    const sent: string[] = []
    shim = createWorkBuddyShim({
      store,
      client: {
        chatStream: async (credential: WorkBuddyCredential) => {
          sent.push(credential.uin ?? '')
          return credential.uin === 'selected' ? RATE_LIMITED : ok()
        },
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      failoverAccount: async () => other,
    })
    await shim.ready
    await chat(shim)

    expect(resolve).toHaveBeenCalledTimes(1)
    // Both accounts served an attempt, and the selection was read only once —
    // for the first of them.
    expect(sent).toEqual(['selected', 'other'])
  })
})

/**
 * The candidate RULE, exercised through the real ranking the policy uses.
 *
 * `failoverAccountFor` iterates `rankPool(...)` and skips rows carrying
 * `excludedBy`. That makes the pool's measurement semantics the feature's
 * semantics, which is exactly what the product asks for — so it is pinned here
 * rather than left implicit in two files agreeing by accident:
 *
 *   - **never tested** ⇒ a candidate. A freshly discovered account must not be
 *     invisible, or a brand-new pool could not fail over at all;
 *   - **tested and rate-limited** ⇒ excluded while the stated cooldown runs,
 *     and back to being a candidate the moment it expires.
 */
describe('which pool members failover may try', () => {
  const NOW = 1_700_000_000_000

  it('includes an account that has never been tested', () => {
    const ranked = rankPool([{ account: { id: 'untested', accountName: 'Untested' } }], NOW)
    expect(ranked[0]?.excludedBy).toBeUndefined()
  })

  it('excludes a rate-limited account until its reset time, then includes it again', () => {
    const member = {
      account: { id: 'limited', accountName: 'Limited' },
      probe: { outcome: 'rate-limited' as const, atMs: NOW, retryAtMs: NOW + 60_000 },
    }
    expect(rankPool([member], NOW)[0]?.excludedBy).toBe('rate-limited')
    // The cooldown elapsed: the same stored measurement is no longer a reason to
    // skip it, because the account is usable again without another test.
    expect(rankPool([member], NOW + 60_001)[0]?.excludedBy).toBeUndefined()
  })

  it('excludes an account whose credential the upstream rejected', () => {
    const ranked = rankPool([{
      account: { id: 'dead', accountName: 'Dead' },
      probe: { outcome: 'credential-rejected' as const, atMs: NOW },
    }], NOW)
    expect(ranked[0]?.excludedBy).toBe('credential-rejected')
  })
})

describe('the pool decides who serves the FIRST attempt', () => {
  it('consults the pool before resolving, and uses the credential it produced', async () => {
    // With the pool on, the ranking owns who serves — the switch's whole point.
    // The shim cannot pick the account itself (it does not know the pool), so it
    // asks the plugin first and then resolves: that ordering is what lets token
    // REFRESH stay in `store.resolve()` instead of being re-implemented on the
    // routing path, where a missed refresh would send an expired token.
    const order: string[] = []
    const other = credentialFor('other')
    const store = {
      resolve: async () => {
        order.push('resolve')
        return other
      },
      credentialFor: async () => other,
    } as unknown as WorkBuddyCredentialStore
    shim = createWorkBuddyShim({
      store,
      client: {
        chatStream: async (credential: WorkBuddyCredential) => {
          order.push(`chat:${credential.uin ?? ''}`)
          return ok()
        },
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      prepareAccount: async () => { order.push('prepare') },
    })
    await shim.ready
    await chat(shim)
    expect(order).toEqual(['prepare', 'resolve', 'chat:other'])
  })

  it('still serves the request when the pool lookup fails', async () => {
    // Routing is an optimisation, not a gate. A pool that cannot be read (a
    // corrupt probe file, a store hiccup) must degrade to the account the store
    // already had rather than failing the user's request.
    const warn = vi.fn()
    const sent: string[] = []
    shim = createWorkBuddyShim({
      store: { resolve: async () => SELECTED } as unknown as WorkBuddyCredentialStore,
      client: {
        chatStream: async (credential: WorkBuddyCredential) => {
          sent.push(credential.uin ?? '')
          return ok()
        },
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      logger: { warn, error: vi.fn() },
      prepareAccount: async () => { throw new Error('probe store unreadable') },
    })
    await shim.ready
    const response = await chat(shim)
    expect(response.status).toBe(200)
    expect(sent).toEqual(['selected'])
    expect(warn).toHaveBeenCalled()
  })
})

describe('live failures are reported so the NEXT request avoids them', () => {
  const RATE_LIMIT_BODY = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-02 05:23:27 UTC+8 重置，您也可以切换其他模型继续使用。"}'

  it('reports every failed attempt, including the last one', async () => {
    // The last failure is the one that matters MOST: an account that failed with
    // nobody left to try it will be picked first again unless it is recorded.
    // Reporting only the ones that had a successor would miss exactly that case.
    const other = credentialFor('other')
    const reports: Array<{ id: string, status: number, kind: string }> = []
    shim = createWorkBuddyShim({
      store: storeWith([other]),
      client: {
        chatStream: async () => ({ ok: false, status: 429, kind: 'soft_rate', message: RATE_LIMIT_BODY }),
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      failoverAccount: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
      onAccountFailure: (accountId, failure) => {
        reports.push({ id: accountId, status: failure.status, kind: failure.kind })
      },
    })
    await shim.ready
    await chat(shim)

    expect(reports).toHaveLength(2)
    expect(reports.every(r => r.status === 429 && r.kind === 'soft_rate')).toBe(true)
    expect(new Set(reports.map(r => r.id)).size, 'both accounts must be reported').toBe(2)
  })

  it('carries the upstream body through, so the reset time survives', async () => {
    // The reset sentence lives in the failure BODY. Dropping it would leave the
    // host unable to compute a cooldown, and the account would come straight back
    // into rotation instead of waiting out the limit the upstream named.
    let message = ''
    shim = createWorkBuddyShim({
      store: storeWith([]),
      client: {
        chatStream: async () => ({ ok: false, status: 429, kind: 'soft_rate', message: RATE_LIMIT_BODY }),
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      onAccountFailure: (_id, failure) => { message = failure.message },
    })
    await shim.ready
    await chat(shim)
    expect(message).toContain('2026-10-02 05:23:27')
  })

  it('survives a reporting callback that throws', async () => {
    // Bookkeeping must never take down a request the user is waiting on.
    const warn = vi.fn()
    shim = createWorkBuddyShim({
      store: storeWith([]),
      client: {
        chatStream: async () => ({ ok: false, status: 429, kind: 'soft_rate', message: RATE_LIMIT_BODY }),
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      logger: { warn, error: vi.fn() },
      onAccountFailure: () => { throw new Error('disk on fire') },
    })
    await shim.ready
    const response = await chat(shim)
    // The failure is still reported to the caller as a 429.
    expect(response.status).toBe(429)
    expect(warn).toHaveBeenCalled()
  })
})

describe('failure reporting without a pool to fail over to', () => {
  it('reports the single failed attempt exactly once', async () => {
    // No `failoverAccount` at all (pool off): the request fails once and that
    // one account must still be recorded — otherwise turning the pool ON later
    // would start from a stale picture.
    const reports: string[] = []
    shim = createWorkBuddyShim({
      store: storeWith([]),
      client: {
        chatStream: async () => ({ ok: false, status: 429, kind: 'soft_rate', message: '{"code":6004}' }),
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      onAccountFailure: accountId => { reports.push(accountId) },
    })
    await shim.ready
    const response = await chat(shim)
    expect(response.status).toBe(429)
    expect(reports).toEqual([SELECTED_ID])
  })

  it('reports a 400 too — the CLASS is filtered by the plugin, not here', async () => {
    // The shim reports what happened; deciding that a malformed request says
    // nothing about the account is the plugin's call (and its own test). Keeping
    // that policy in one place is why the shim does not filter kinds.
    const reports: string[] = []
    shim = createWorkBuddyShim({
      store: storeWith([]),
      client: {
        chatStream: async () => ({ ok: false, status: 400, kind: 'client', message: 'bad request' }),
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      onAccountFailure: accountId => { reports.push(accountId) },
    })
    await shim.ready
    await chat(shim)
    expect(reports).toEqual([SELECTED_ID])
  })

  it('still reports a model-scoped throttle, and reports it once', async () => {
    // The shim refuses to FAIL OVER for `model_busy` (no point hitting the same
    // model wall twice), but it must still REPORT the attempt: the card lists why
    // an account is out, and the plugin's `recordAccountFailure` is what turns
    // the report into a measurement — on the SHORT clock, in
    // `issue56-model-scoped-throttle.spec.ts`. Reporting it once (not once per
    // suppressed candidate) is what keeps the pool's record honest.
    const other = credentialFor('other')
    const reports: string[] = []
    shim = createWorkBuddyShim({
      store: storeWith([other]),
      client: {
        chatStream: async () => ({ ok: false, status: 429, kind: 'model_busy', message: MODEL_BUSY_MESSAGE }),
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      failoverAccount: async () => other,
      onAccountFailure: accountId => { reports.push(accountId) },
    })
    await shim.ready
    await chat(shim)
    expect(reports).toEqual([SELECTED_ID])
  })

  it('waits between failover attempts so zero-gap retries do not hammer the upstream', async () => {
    // The upstream's rate limit (6004) fires on request volume. Firing retries
    // at zero gap makes every candidate hit the same wall — 4 accounts can all
    // fail in under a second. The gap is what prevents that; this test pins it.
    const other = credentialFor('other')
    const timestamps: number[] = []
    let calls = 0
    shim = createWorkBuddyShim({
      store: storeWith([other]),
      client: {
        chatStream: async () => {
          timestamps.push(Date.now())
          calls += 1
          return RATE_LIMITED
        },
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      failoverAccount: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
    })
    await shim.ready
    await chat(shim)

    // Two attempts (SELECTED then other), so one gap between them.
    expect(calls).toBe(2)
    const gap = timestamps[1]! - timestamps[0]!
    // The constant is 2_000ms; allow a small margin for scheduler jitter.
    expect(gap).toBeGreaterThanOrEqual(1_900)
  })
})

/**
 * The failover is ANNOUNCED in the answer, not only in the log.
 *
 * Why this file owns it: before this, a switch existed only as a `logger.warn`
 * line the user never reads. A reply that came from a fallback account looked
 * exactly like one from the account they chose, so the two facts they needed —
 * "the account I picked did not serve this" and "why" — were both invisible. The
 * notice is the user-facing half of the same event the retry loop performs.
 */
describe('a failover says so in the answer', () => {
  /** The concatenated `content` deltas of an SSE body, in order. */
  function contentOf(body: string): string {
    let text = ''
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
        text += chunk.choices?.[0]?.delta?.content ?? ''
      } catch { /* a keep-alive or a non-JSON frame: nothing to collect */ }
    }
    return text
  }

  /** A stream that says something, so there is content to carry the notice. */
  function answering(text: string): WorkBuddyChatResult {
    const frame = { choices: [{ index: 0, delta: { content: text }, finish_reason: '' }] }
    const done = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    return {
      ok: true,
      response: new Response(`data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { status: 200 }),
    }
  }

  it('names the abandoned account and the reason, before the answer itself', async () => {
    const other = credentialFor('other')
    const seen: string[] = []
    shim = mount({
      others: [other],
      chatStream: async credential => {
        seen.push(credential.uin ?? '')
        return seen.length === 1 ? RATE_LIMITED : answering('Hello from the fallback.')
      },
      failover: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(200)
    const text = contentOf(response.body)
    // The notice is there, names the account left behind (this fixture publishes
    // no display name, so the `uin` is the last resort — see the issue-#234 case
    // below for the labelled form) and gives the reason a person can act on.
    expect(text).toContain('dsh-connect-workbuddy')
    expect(text).toContain('selected')
    expect(text).toContain('被限流')
    // And it comes FIRST: an answer that opened with the model's prose and then
    // mentioned the switch would read as the model talking about itself.
    expect(text.indexOf('dsh-connect-workbuddy')).toBeLessThan(text.indexOf('Hello from the fallback.'))
  })

  it('names an exhausted account as out of credits, not as merely rate limited', async () => {
    // The two used to share one sentence ("rate limited"). They need opposite
    // advice: a rate limit clears on its own at a stated time, while an
    // exhausted account cannot pay for the model until it is topped up. Calling
    // both "rate limited" sends the user off to wait for something that will not
    // arrive — the same class of misleading-but-adjacent wording that issue #56
    // reported for the model-scoped throttle.
    const other = credentialFor('other')
    const seen: string[] = []
    shim = mount({
      others: [other],
      chatStream: async credential => {
        seen.push(credential.uin ?? '')
        return seen.length === 1
          ? { ok: false, status: 429, kind: 'hard_credit', message: '{"msg":"Credits exhausted."}' }
          : answering('Hello from the fallback.')
      },
      failover: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(200)
    const text = contentOf(response.body)
    expect(text).toContain('积分已耗尽')
    expect(text).not.toContain('被限流')
    // Still failover-worthy: another ACCOUNT may well have a balance, which is
    // the whole reason the notice has to name the real reason.
    expect(seen).toEqual(['selected', 'other'])
  })

  it('adds NO notice when the selected account serves the request', async () => {
    // The case that keeps the feature honest: a notice on every reply would be
    // noise, and would also mean the notice does not actually signal anything.
    const other = credentialFor('other')
    shim = mount({
      others: [other],
      chatStream: async () => answering('Straight answer.'),
      failover: async () => other,
    })
    await shim.ready

    const response = await chat(shim)
    const text = contentOf(response.body)
    expect(text).toContain('Straight answer.')
    expect(text).not.toContain('已改用池中另一个账号')
    expect(attemptsOf()).toEqual([SELECTED_ID])
  })

  it('names the account left behind by its NAME, not by its phone number (issue #234)', async () => {
    // The reporter read 「330135985725」 and could not tell what that was. Every
    // other surface (card, pool table, composer panel) calls an account by its
    // name, so the one sentence that explains a switch must use the same label.
    const other = credentialFor('other')
    const named = { ...SELECTED, nickname: 'Beta', displayName: 'Beta Display' }
    shim = mount({
      selected: named,
      others: [other],
      chatStream: async credential => (credential.uin === 'selected' ? RATE_LIMITED : answering('Recovered.')),
      failover: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
    })
    await shim.ready

    const text = contentOf((await chat(shim)).body)
    expect(text).toContain('被限流')
    // The DISPLAY name (first in `preferredAccountName`'s order), not the alias.
    expect(text).toContain('「Beta Display」')
    // And the bare identifier is gone: it is what the report was about.
    expect(text).not.toContain('「selected」')
  })

  it('falls back to the uin only when the app published no name at all', async () => {
    // An unnamed account still has to be pointed at, and a number the user can
    // match against a row is better than a sentence that names nobody. This is
    // ALSO the shape every other fixture in this file has, which is why the
    // notice assertions above still read `selected`.
    const other = credentialFor('other')
    shim = mount({
      others: [other],
      chatStream: async credential => (credential.uin === 'selected' ? RATE_LIMITED : answering('Recovered.')),
      failover: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
    })
    await shim.ready

    expect(contentOf((await chat(shim)).body)).toContain('「selected」')
  })

  it('says nothing when the request failed on every account', async () => {
    // Nothing was delivered, so there is no answer for a notice to preface. The
    // error response is where this user learns what happened.
    const other = credentialFor('other')
    shim = mount({
      others: [other],
      chatStream: async () => RATE_LIMITED,
      failover: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(429)
    expect(response.body).not.toContain('已改用池中另一个账号')
  })

  it('reports ONE reason even when several accounts fail before one answers', async () => {
    // Three accounts walked: the user needs to know the answer came from a
    // fallback, not a transcript of every candidate that was also limited.
    const second = credentialFor('second')
    const third = credentialFor('third')
    const seen: string[] = []
    shim = mount({
      others: [second, third],
      chatStream: async credential => {
        seen.push(credential.uin ?? '')
        return seen.length < 3 ? RATE_LIMITED : answering('Third time lucky.')
      },
      failover: async tried => {
        if (!tried.includes(SELECTED_ID)) return undefined
        if (!tried.includes(workbuddyAccountId(second))) return second
        if (!tried.includes(workbuddyAccountId(third))) return third
        return undefined
      },
    })
    await shim.ready

    const response = await chat(shim)
    expect(seen).toEqual(['selected', 'second', 'third'])
    const text = contentOf(response.body)
    expect(text).toContain('Third time lucky.')
    // Exactly one notice, naming the account the request STARTED on.
    expect(text.split('已改用池中另一个账号').length - 1).toBe(1)
    expect(text).toContain('selected')
  })

  it('still answers when the switch is due to a dead sign-in, and says that instead', async () => {
    // A different kind must produce a different phrase, or the notice would be
    // decoration: "rate limited" and "signed out" send the user to different
    // remedies (wait / re-authenticate) and must not read alike.
    const other = credentialFor('other')
    const seen: string[] = []
    shim = mount({
      others: [other],
      chatStream: async credential => {
        seen.push(credential.uin ?? '')
        return seen.length === 1
          ? { ok: false, status: 401, kind: 'session_dead', message: 'token revoked' }
          : answering('Recovered.')
      },
      failover: async tried => (tried.includes(SELECTED_ID) ? other : undefined),
    })
    await shim.ready

    const text = contentOf((await chat(shim)).body)
    expect(text).toContain('登录已失效')
    expect(text).not.toContain('被限流')
  })
})

/**
 * WHY THERE WAS NOWHERE ELSE TO GO.
 *
 * A failed request that already searched the pool left the user with the one
 * question the error itself could not answer: "why did nothing else work?".
 * Without an explanation the remaining advice reads as a guess, and the pool's
 * own reasoning — which the card shows per row — is invisible at the exact
 * moment it would have been acted on.
 *
 * The host supplies the reason through `failoverShortfall`; these tests pin how
 * the shim treats that reply, including the states where it must NOT let the
 * explanation make things worse.
 */
describe('a failed request explains why the pool had nowhere to go', () => {
  it('includes the pool\'s reason and points at the model', async () => {
    shim = mount({
      chatStream: async () => RATE_LIMITED,
      failover: async () => undefined,
      shortfall: async () => '池中已无可用账号（2 个账号被限流）',
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(429)
    // The pool's own verdict, present verbatim rather than paraphrased, so the
    // sentence the user reads is the one the routing decision was made on.
    expect(response.body).toContain('池中已无可用账号（2 个账号被限流）')
    // And the remaining move, stated as advice rather than left to inference.
    expect(response.body).toContain('建议换一个模型继续')
    // The upstream's own words survive: they carry the reset time, which is the
    // one actionable fact a generic sentence would destroy.
    expect(response.body).toContain('2026-10-02 05:23:27')
  })

  it('still names the failure class, so the reason is not only "the pool is full"', async () => {
    // The shortfall explains the POOL; the class explains THIS request. Both are
    // needed: "no accounts available" alone does not say the account was limited
    // rather than signed out.
    shim = mount({
      chatStream: async () => RATE_LIMITED,
      failover: async () => undefined,
      shortfall: async () => '池中已无可用账号',
    })
    await shim.ready

    expect((await chat(shim)).body).toContain('被限流')
  })

  it('reports the upstream failure unchanged when the host offers no reason', async () => {
    // `failoverShortfall` is optional and its absence is a supported state: an
    // older host must produce the failure it always produced. This is the
    // regression guard for making it required by accident.
    shim = mount({
      chatStream: async () => RATE_LIMITED,
      failover: async () => undefined,
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(429)
    expect(response.body).toContain('2026-10-02 05:23:27')
    // No dangling punctuation where the explanation would have gone, and no
    // advice about a pool the host never described.
    expect(response.body).not.toContain('池中已无可用账号')
    expect(response.body).not.toContain('建议换一个模型继续')
  })

  it('reports the real upstream failure when the explanation itself fails', async () => {
    // A bookkeeping callback must never replace the failure it was asked to
    // explain. A throw here degrades to "no explanation" — the same reply as an
    // absent callback — rather than turning a 429 into a plugin error.
    shim = mount({
      chatStream: async () => RATE_LIMITED,
      failover: async () => undefined,
      shortfall: async () => { throw new Error('pool state unreadable') },
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(429)
    expect(response.body).toContain('2026-10-02 05:23:27')
    expect(response.body).not.toContain('pool state unreadable')
  })

  it('does not ask for an explanation when the request SUCCEEDED', async () => {
    // The callback answers "why did nothing work", which is meaningless on a
    // reply that worked. Asking anyway would spend the pool's work on every
    // single request and, worse, would invite a future edit to render an
    // explanation beside a successful answer.
    let asked = 0
    shim = mount({
      others: [credentialFor('other')],
      chatStream: async () => ({
        ok: true,
        response: new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Straight answer.' }, finish_reason: '' }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { status: 200 },
        ),
      }),
      shortfall: async () => { asked += 1; return 'should never be read' },
    })
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(200)
    expect(asked).toBe(0)
    expect(response.body).toContain('Straight answer.')
    expect(response.body).not.toContain('should never be read')
  })
})


describe('request cancellation during pool preparation', () => {
  it('passes disconnect cancellation before resolving or sending a model request', async () => {
    let release: (() => void) | undefined
    let signalSeen: AbortSignal | undefined
    const resolveAccount = vi.fn(async () => SELECTED)
    const chatStream = vi.fn(async () => ok())
    shim = createWorkBuddyShim({
      store: { resolve: resolveAccount } as unknown as WorkBuddyCredentialStore,
      client: { chatStream } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      prepareAccount: async signal => {
        signalSeen = signal
        await new Promise<void>(resolve => {
          release = resolve
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    })
    await shim.ready
    const controller = new AbortController()
    const request = fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'fixture-model', messages: [] }), signal: controller.signal,
    }).catch(() => undefined)
    try {
      await vi.waitFor(() => expect(signalSeen).toBeDefined())
      controller.abort()
      await request
      await vi.waitFor(() => expect(signalSeen?.aborted).toBe(true))
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(resolveAccount).not.toHaveBeenCalled()
      expect(chatStream).not.toHaveBeenCalled()
    } finally {
      controller.abort()
      release?.()
      await request
    }
  })
})
