import { describe, expect, it } from 'vitest'
import {
  cooldownOf,
  creditOfStream,
  outcomeOfFailure,
  parseRetryAfter,
  parseUpstreamResetAt,
  probeModel,
  probeRequestBody,
  probeSucceeded,
  PROBE_MAX_TOKENS,
  PROBE_SYSTEM_PROMPT,
} from '../src/probe.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  uin: '100000000001',
  nickname: 'Alpha',
  source: 'desktop',
  filePath: '/tmp/a.info',
}

/** A client double whose single answer each test controls. */
function clientAnswering(answer: {
  ok: boolean
  status: number
  retryAfter?: string | null
  body?: string
  stream?: string
}): {
  seen: string[]
  probeChat: (credential: WorkBuddyCredential, bodyJson: string) => Promise<{
    ok: boolean
    status: number
    retryAfter: string | null
    body?: string
    response?: Response
  }>
} {
  const seen: string[] = []
  return {
    seen,
    async probeChat(_credential, bodyJson) {
      seen.push(bodyJson)
      return {
        ok: answer.ok,
        status: answer.status,
        retryAfter: answer.retryAfter ?? null,
        ...answer.body === undefined ? {} : { body: answer.body },
        ...answer.stream === undefined ? {} : { response: new Response(answer.stream) },
      }
    },
  }
}

describe('probeRequestBody', () => {
  it('always opens with a system message', () => {
    // The international gateway answers HTTP 400 / code 11128
    // ("first message is not system prompt") to a user-only conversation. A
    // probe without this message would report every global model as broken —
    // measured live, not inferred.
    const body = JSON.parse(probeRequestBody('glm-5.3')) as {
      messages: { role: string, content: string }[]
    }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[0]?.content).toBe(PROBE_SYSTEM_PROMPT)
    expect(body.messages[1]?.role).toBe('user')
  })

  it('caps output at one token and forces streaming', () => {
    // One token is what makes a probe free in practice: a live measurement saw
    // "credit": 0 and an unchanged balance. Non-streaming is rejected upstream.
    const body = JSON.parse(probeRequestBody('glm-5.3')) as { max_tokens: number, stream: boolean }
    expect(body.max_tokens).toBe(PROBE_MAX_TOKENS)
    expect(body.max_tokens).toBe(1)
    expect(body.stream).toBe(true)
  })

  it('names exactly the model it was given', () => {
    expect((JSON.parse(probeRequestBody('kimi-k2.7')) as { model: string }).model).toBe('kimi-k2.7')
  })
})

describe('parseRetryAfter', () => {
  const NOW = 1_800_000_000_000

  it('reads the delay-seconds form', () => {
    expect(parseRetryAfter('120', NOW)).toBe(NOW + 120_000)
  })

  it('reads the HTTP-date form', () => {
    const at = NOW + 300_000
    expect(parseRetryAfter(new Date(at).toUTCString(), NOW)).toBe(at)
  })

  it('refuses a delay that is not a cooldown', () => {
    // "retry now" is not a wait, and rendering it as one would be worse than
    // saying nothing.
    expect(parseRetryAfter('0', NOW)).toBeUndefined()
    expect(parseRetryAfter('-5', NOW)).toBeUndefined()
  })

  it('refuses an absent or unparsable value', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined()
    expect(parseRetryAfter('', NOW)).toBeUndefined()
    expect(parseRetryAfter('   ', NOW)).toBeUndefined()
    expect(parseRetryAfter('soon', NOW)).toBeUndefined()
  })

  it('refuses an HTTP-date already in the past', () => {
    expect(parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW)).toBeUndefined()
  })
})

describe('cooldownOf', () => {
  const NOW = 1_800_000_000_000

  it('prefers a Retry-After header over everything else', () => {
    const result = cooldownOf({
      outcome: 'out-of-credit',
      retryAfter: '60',
      nowMs: NOW,
      quotaRefreshAtMs: NOW + 999_999,
    })
    expect(result.retryAtMs).toBe(NOW + 60_000)
    expect(result.retrySource).toBe('retry-after')
  })

  it('reads the reset time out of the upstream failure body', () => {
    // The defect this covers: the upstream's 429 body DOES name a reset time
    // (`将在 … 重置`) while carrying no `Retry-After` header, so a reader that
    // only consulted headers reported "the upstream gave no time" with the
    // answer sitting in the text. Captured verbatim from a live 429.
    const result = cooldownOf({
      outcome: 'rate-limited',
      retryAfter: null,
      nowMs: NOW,
      body: LIVE_RATE_LIMIT_BODY,
    })
    expect(result.retryAtMs).toBe(Date.UTC(2026, 8, 29, 18, 30, 30))
    expect(result.retrySource).toBe('upstream-message')
  })

  it('lets a Retry-After header win over the body text', () => {
    const result = cooldownOf({
      outcome: 'rate-limited',
      retryAfter: '60',
      nowMs: NOW,
      body: LIVE_RATE_LIMIT_BODY,
    })
    expect(result.retryAtMs).toBe(NOW + 60_000)
    expect(result.retrySource).toBe('retry-after')
  })

  it('falls back to the quota refresh point for an exhausted quota', () => {
    // The one cooldown a monthly resource declares: a known reset cycle. This is
    // the honest answer to "when can I use it again" when nothing else said.
    const result = cooldownOf({
      outcome: 'out-of-credit',
      retryAfter: null,
      nowMs: NOW,
      quotaRefreshAtMs: NOW + 3_600_000,
    })
    expect(result.retryAtMs).toBe(NOW + 3_600_000)
    expect(result.retrySource).toBe('quota-refresh')
  })

  it('invents NO time for a rate limit the upstream did not time', () => {
    // The load-bearing assertion of the whole feature, still: when the upstream
    // states no time ANYWHERE — no header, no reset sentence in the body — the
    // result MUST stay timeless. A client-side countdown would look like an
    // upstream answer while being fiction.
    const result = cooldownOf({ outcome: 'rate-limited', retryAfter: null, nowMs: NOW, body: '{"code":6004}' })
    expect(result.retryAtMs).toBeUndefined()
    expect(result.retrySource).toBeUndefined()
    expect('retryAtMs' in result).toBe(false)
  })

  it('does not borrow the quota refresh point for a rate limit', () => {
    // A quota reset is not a rate-limit release: showing the monthly refresh
    // time next to a 429 would tell the user to wait weeks for a limit that may
    // clear in seconds.
    const result = cooldownOf({
      outcome: 'rate-limited',
      retryAfter: null,
      nowMs: NOW,
      quotaRefreshAtMs: NOW + 3_600_000,
    })
    expect(result.retryAtMs).toBeUndefined()
  })

  it('reports nothing for a successful probe', () => {
    const result = cooldownOf({ outcome: 'ok', retryAfter: null, nowMs: NOW })
    expect('retryAtMs' in result).toBe(false)
  })
})

/**
 * The exact 429 body the Chinese gateway returned on 2026-09-29, kept verbatim
 * as the fixture the parsing rules are pinned against. Trimming it to a
 * convenient shape would let the parser drift away from what the service
 * actually sends — the failure mode this whole change is about.
 */
const LIVE_RATE_LIMIT_BODY
  = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-30 02:30:30 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"fd51dd8c-1f48-4a72-a79d-4cf80003f1d4"}'

describe('parseUpstreamResetAt', () => {
  it('reads the shipped UTC offset instead of assuming the host zone', () => {
    // `Date.parse` on the bare string would read 02:30:30 as LOCAL time: right
    // on a machine set to UTC+8, silently wrong by the offset anywhere else.
    // So the assertion is on the absolute instant, which is what the card
    // formats — and it must hold whatever zone the test host runs in.
    expect(parseUpstreamResetAt(LIVE_RATE_LIMIT_BODY)).toBe(Date.UTC(2026, 8, 29, 18, 30, 30))
  })

  it('accepts an ISO-style T separator and a compact offset', () => {
    expect(parseUpstreamResetAt('将在 2026-09-30T02:30:30 UTC+8 重置'))
      .toBe(Date.UTC(2026, 8, 29, 18, 30, 30))
    expect(parseUpstreamResetAt('将在 2026-09-30 02:30:30 UTC+0800 重置'))
      .toBe(Date.UTC(2026, 8, 29, 18, 30, 30))
  })

  it('honours a negative offset', () => {
    expect(parseUpstreamResetAt('将在 2026-09-30 02:30:30 UTC-5 重置'))
      .toBe(Date.UTC(2026, 8, 30, 7, 30, 30))
  })

  it('returns undefined rather than guessing when the time is incomplete', () => {
    // Each of these is a message a careless regex would turn into a WRONG time,
    // and a wrong time is worse than none: the card would count down to a
    // moment that means nothing.
    expect(parseUpstreamResetAt('{"msg":"您的使用量已超出频率限制"}')).toBeUndefined()
    expect(parseUpstreamResetAt('将在 2026-09-30 02:30:30 重置')).toBeUndefined() // no offset
    expect(parseUpstreamResetAt('将在 2026-09-30 02:30:30 UTC+8 恢复')).toBeUndefined() // no 重置
    expect(parseUpstreamResetAt('请在 2026-09-30 02:30:30 UTC+8 重置')).toBeUndefined() // not a reset
  })

  it('rejects an impossible calendar date instead of normalizing it', () => {
    // `Date.UTC` rolls month 13 into the next year and day 32 into the next
    // month, so an unchecked parse would fabricate a real-but-wrong instant.
    expect(parseUpstreamResetAt('将在 2026-13-30 02:30:30 UTC+8 重置')).toBeUndefined()
    expect(parseUpstreamResetAt('将在 2026-09-32 02:30:30 UTC+8 重置')).toBeUndefined()
    expect(parseUpstreamResetAt('将在 2026-02-30 02:30:30 UTC+8 重置')).toBeUndefined()
  })

  it('rejects an out-of-range offset', () => {
    expect(parseUpstreamResetAt('将在 2026-09-30 02:30:30 UTC+99 重置')).toBeUndefined()
  })
})

describe('outcomeOfFailure', () => {
  it('classifies a 429 as rate limited', () => {
    expect(outcomeOfFailure(429, '')).toBe('rate-limited')
  })

  it('classifies the Chinese and English quota markers as out of credit', () => {
    expect(outcomeOfFailure(400, '积分不足')).toBe('out-of-credit')
    expect(outcomeOfFailure(402, '')).toBe('out-of-credit')
    expect(outcomeOfFailure(400, 'insufficient credit')).toBe('out-of-credit')
  })

  it('classifies a 401/403 as a credential rejection, not a wait', () => {
    // Different advice entirely: re-auth or switch accounts, never "wait".
    expect(outcomeOfFailure(401, '')).toBe('credential-rejected')
    expect(outcomeOfFailure(403, '')).toBe('credential-rejected')
  })

  it('classifies a transport failure (status 0) as unavailable', () => {
    expect(outcomeOfFailure(0, 'transport error: ECONNREFUSED')).toBe('unavailable')
  })

  it('classifies a 5xx as unavailable and a 404 as not found', () => {
    expect(outcomeOfFailure(502, '')).toBe('unavailable')
    expect(outcomeOfFailure(404, 'no such model')).toBe('not-found')
  })

  it('classifies a plain 400 as a generic failure', () => {
    expect(outcomeOfFailure(400, 'bad request')).toBe('failed')
  })
})

describe('creditOfStream', () => {
  it('reads the credit the upstream reported', () => {
    expect(creditOfStream('{"usage":{"credit":0}}')).toBe(0)
    expect(creditOfStream('{"usage":{"credit":1.25}}')).toBe(1.25)
  })

  it('returns undefined when the stream carried no credit', () => {
    expect(creditOfStream('data: [DONE]')).toBeUndefined()
    expect(creditOfStream('{"usage":null}')).toBeUndefined()
  })
})

describe('probeModel', () => {
  it('reports a successful probe with its round-trip time', async () => {
    const client = clientAnswering({
      ok: true,
      status: 200,
      stream: 'data: {"usage":{"credit":0}}\n\ndata: [DONE]\n\n',
    })
    const result = await probeModel({
      client,
      credential: CREDENTIAL,
      modelId: 'glm-5.3',
      nowMs: Date.now(),
    })
    expect(result.outcome).toBe('ok')
    expect(probeSucceeded(result.outcome)).toBe(true)
    expect(result.modelId).toBe('glm-5.3')
    expect(typeof result.elapsedMs).toBe('number')
  })

  it('sends the system-led minimal body through the client', async () => {
    const client = clientAnswering({ ok: true, status: 200, stream: 'data: [DONE]\n\n' })
    await probeModel({ client, credential: CREDENTIAL, modelId: 'hy3', nowMs: Date.now() })
    expect(client.seen).toHaveLength(1)
    const sent = JSON.parse(client.seen[0] as string) as { model: string, messages: { role: string }[] }
    expect(sent.model).toBe('hy3')
    expect(sent.messages[0]?.role).toBe('system')
  })

  it('reports a rate limit without a time rather than inventing one', async () => {
    const client = clientAnswering({ ok: false, status: 429, body: 'too many requests' })
    const result = await probeModel({
      client,
      credential: CREDENTIAL,
      modelId: 'glm-5.3',
      nowMs: Date.now(),
    })
    expect(result.outcome).toBe('rate-limited')
    expect(result.retryAtMs).toBeUndefined()
    expect(result.status).toBe(429)
  })

  it('surfaces the reset time a real 429 body carries', async () => {
    // End-to-end through the shape that matters: the upstream's own 429 body,
    // with NO Retry-After header, must reach the card as a real time. This is
    // the whole user-visible defect — the card said "the upstream gave no time"
    // while this sentence was in the response all along.
    const client = clientAnswering({ ok: false, status: 429, body: LIVE_RATE_LIMIT_BODY })
    const result = await probeModel({
      client,
      credential: CREDENTIAL,
      modelId: 'deepseek-v4.1-flash',
      nowMs: Date.now(),
    })
    expect(result.outcome).toBe('rate-limited')
    expect(result.retryAtMs).toBe(Date.UTC(2026, 8, 29, 18, 30, 30))
    expect(result.retrySource).toBe('upstream-message')
  })

  it('keeps a stated time even when the failure is NOT a rate limit', async () => {
    // `cooldownOf` reads the body regardless of outcome, so a quota failure that
    // happens to carry the same sentence still yields a time rather than falling
    // through to "no time given".
    const client = clientAnswering({ ok: false, status: 400, body: LIVE_RATE_LIMIT_BODY })
    const result = await probeModel({
      client,
      credential: CREDENTIAL,
      modelId: 'glm-5.3',
      nowMs: Date.now(),
    })
    expect(result.retryAtMs).toBe(Date.UTC(2026, 8, 29, 18, 30, 30))
  })

  it('stamps the quota refresh time onto an out-of-credit result', async () => {
    const now = Date.now()
    const client = clientAnswering({ ok: false, status: 400, body: '积分不足' })
    const result = await probeModel({
      client,
      credential: CREDENTIAL,
      modelId: 'glm-5.3',
      nowMs: now,
      quotaRefreshAtMs: now + 3_600_000,
    })
    expect(result.outcome).toBe('out-of-credit')
    expect(result.retryAtMs).toBe(now + 3_600_000)
    expect(result.retrySource).toBe('quota-refresh')
  })

  it('never throws: a transport explosion becomes an unavailable result', async () => {
    // One dead model must not abort the batch and hide the other rows.
    const client = {
      probeChat: async () => { throw new Error('socket hang up') },
    }
    const result = await probeModel({
      client,
      credential: CREDENTIAL,
      modelId: 'glm-5.3',
      nowMs: Date.now(),
    })
    expect(result.outcome).toBe('unavailable')
    expect(result.message).toContain('socket hang up')
  })

  it('redacts token-shaped content out of a failure message', async () => {
    const client = clientAnswering({
      ok: false,
      status: 400,
      body: 'rejected access_token=supersecretvalue&x=1',
    })
    const result = await probeModel({
      client,
      credential: CREDENTIAL,
      modelId: 'glm-5.3',
      nowMs: Date.now(),
    })
    expect(result.message).not.toContain('supersecretvalue')
    expect(result.message).toContain('[redacted]')
  })

  it('keeps a success when the stream cannot be drained', async () => {
    // The credit figure is informational; losing it must not downgrade a probe
    // that already proved the model answered.
    const client = {
      probeChat: async () => ({
        ok: true,
        status: 200,
        retryAfter: null,
        response: new Response(new ReadableStream({ start(controller) { controller.error(new Error('aborted')) } })),
      }),
    }
    const result = await probeModel({
      client,
      credential: CREDENTIAL,
      modelId: 'glm-5.3',
      nowMs: Date.now(),
    })
    expect(result.outcome).toBe('ok')
  })
})
