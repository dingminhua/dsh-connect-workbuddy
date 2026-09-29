import { describe, expect, it } from 'vitest'
import {
  cooldownOf,
  creditOfStream,
  outcomeOfFailure,
  parseRetryAfter,
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

  it('falls back to the quota refresh point for an exhausted quota', () => {
    // The one cooldown this service actually declares: a monthly resource that
    // resets on a known cycle. This is the honest answer to "when can I use it
    // again" when the upstream sent no header.
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
    // This is the load-bearing assertion of the whole feature. Live probes found
    // no rate-limit metadata in any response — no Retry-After, no X-RateLimit-*
    // — and 12 rapid requests to one model all succeeded. So a limited result
    // with no stated time MUST stay timeless; a client-side countdown would look
    // like an upstream answer while being fiction.
    const result = cooldownOf({ outcome: 'rate-limited', retryAfter: null, nowMs: NOW })
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
