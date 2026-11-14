/**
 * What a failed request SAYS (issue #78).
 *
 * The reporter's case was a plain 400 with upstream code 11133 — the model
 * refusing the request's parameters. The plugin rendered it as
 *
 *   workbuddy 上游失败：不可用（http 400）（http 400）：池中其余账号本次请求都已尝试过。
 *   {"code":11133,…,"displayMsg":{"en":"The model cannot handle this request. Pleas
 *   。池中没有其他可用账号，建议换一个模型继续，或稍后等待该账号的额度恢复
 *
 * i.e. three separate defects in one line:
 *   1. a client-class 400 is never failed over, yet the reply claimed the rest of
 *      the pool had been tried (it described a search that never ran);
 *   2. the generic path spliced `message.slice(0, 400)` of the raw JSON envelope,
 *      so the ONLY actionable sentence — `displayTips` — was always cut off;
 *   3. `failoverReasonText` embedded the status code that the caller appended
 *      again, printing `（http 400）（http 400）`.
 *
 * These tests pin the rendered sentence, not the helpers: the helpers are only
 * worth what the user reads. `detail` is produced by the real
 * `parseUpstreamErrorDetail` so parsing and rendering are covered together — a
 * fixture that hand-built `detail` could pass while parsing stayed broken.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { parseUpstreamErrorDetail } from '../src/upstream.ts'
import type { WorkBuddyChatResult, WorkBuddyUpstreamClient } from '../src/upstream.ts'

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  uin: 'selected',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}

const store = {
  resolve: async () => CREDENTIAL,
  credentialFor: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

/**
 * The reporter's 11133 body, verbatim from issue #78.
 *
 * Kept byte-exact — including the `extError` skeleton — because its LENGTH is
 * load-bearing: 637+ characters is what pushed `displayTips` past the old
 * 400-character cut, so a trimmed fixture would not reproduce the bug.
 */
const PARAMS_REJECTED_BODY = '{"code":11133,"msg":"the request parameters were rejected by the model provider","requestId":"33221fe5-f6d5-4ea1-8882-669411e07a5b","extError":{"code":"invalid_request_error","message":"the request parameters were rejected by the model provider","param":"","type":"invalid_request_error","StatusCode":400,"Request":null,"Response":null},"displayMsg":{"en":"The model cannot handle this request. Please retry","zh":"模型无法处理此请求，请重试"},"displayTips":{"en":"This model does not accept the current conversation. It is not a network issue. Please start a new task, switch models, or try again later.","zh":"这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。"},"actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","NEW_CONVERSATION"]}'

/** A failed upstream body as the client would classify it, with detail parsed for real. */
function failure(
  status: number,
  kind: 'client' | 'soft_rate' | 'policy_reject' | 'model_busy' | 'hard_credit' | 'server' | 'not_found' | 'session_dead',
  body: string,
): WorkBuddyChatResult {
  return { ok: false, status, kind, message: body, detail: parseUpstreamErrorDetail(body) }
}

function mount(options: {
  result: WorkBuddyChatResult
  failover?: (tried: readonly string[]) => Promise<WorkBuddyCredential | undefined>
  failoverAccountAbsent?: boolean
  shortfall?: () => Promise<string | undefined>
  reportRefusal?: (report: unknown) => void
}): WorkBuddyShim {
  const client = {
    chatStream: async () => options.result,
  } as unknown as WorkBuddyUpstreamClient
  return createWorkBuddyShim({
    store,
    client,
    catalog: new WorkBuddyCatalog(),
    ...options.failover === undefined ? {} : { failoverAccount: options.failover },
    ...options.shortfall === undefined ? {} : { failoverShortfall: options.shortfall },
    ...options.reportRefusal === undefined ? {} : { reportRefusal: options.reportRefusal as never },
  })
}

/**
 * The 11133 body a refusing model sends when it is asked for `off` — the shape
 * issue #83 reported: the SAME envelope as #78, but with `extError.param`
 * naming the parameter that was rejected.
 *
 * `param` is the whole point: without it the reply can only say "the upstream
 * rejected your request", which is what made the reporter read the log.
 */
const OFF_REJECTED_BODY = '{"code":11133,"msg":"the request parameters were rejected by the model provider","requestId":"8f1c0000-0000-4000-8000-000000000001","extError":{"code":"invalid_request_error","message":"reasoning_effort is not supported","param":"reasoning_effort","value":"off","type":"invalid_request_error","StatusCode":400,"Request":null,"Response":null},"displayMsg":{"zh":"模型无法处理此请求，请重试"},"displayTips":{"zh":"这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。"},"actions":["SWITCH_MODEL"]}'

/** Drive one chat through the shim and return the host-facing error message. */
async function messageOf(instance: WorkBuddyShim): Promise<{ status: number, message: string, type: string }> {
  const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }),
  })
  const parsed = JSON.parse(await response.text()) as {
    error: { message: string, type: string, code: string }
  }
  return { status: response.status, message: parsed.error.message, type: parsed.error.type }
}

describe('issue #78: a parameter rejection must not read as an exhausted pool', () => {
  it('renders the reporter\'s 11133 body as the upstream\'s advice, not as raw JSON', async () => {
    // The full regression: the real envelope in, the sentence out. Both the
    // wording and the ABSENCE of the JSON skeleton are asserted — the old reply
    // was JSON-shaped, so a fix that merely prepends a nice lead is not enough.
    shim = mount({ result: failure(400, 'client', PARAMS_REJECTED_BODY) })
    await shim.ready

    const { status, message, type } = await messageOf(shim)
    expect(status).toBe(400)
    expect(type).toBe('client')
    // 1. The remedy the upstream shipped, previously always cut off.
    expect(message).toContain('这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。')
    // 2. The class, named honestly rather than as "不可用".
    expect(message).toContain('请求被上游拒绝')
    // 3. Support's two handles, compact — they used to hang off the end of a
    //    chopped JSON blob or fall inside it.
    expect(message).toContain('（code 11133，requestId 33221fe5-f6d5-4ea1-8882-669411e07a5b）')
    // 4. No raw envelope: the skeleton (not just the message) must be gone.
    expect(message).not.toContain('extError')
    expect(message).not.toContain('"requestId"')
    expect(message).not.toContain('displayMsg')
    // 5. Short enough to read in a chat transcript. The old line was 490 chars.
    expect(message.length).toBeLessThan(300)
  })

  it('does not claim the pool was searched when the failure class is never failed over', async () => {
    // The heart of defect 1. The real host supplies BOTH callbacks, so their
    // presence is not evidence that a search happened — `isFailoverWorthy`
    // excludes `client`, so the retry loop never ran and the pool was never
    // asked. Counting the ask is the only direct way to pin that.
    let asked = 0
    shim = mount({
      result: failure(400, 'client', PARAMS_REJECTED_BODY),
      failover: async () => undefined,
      shortfall: async () => {
        asked += 1
        return '池中其余账号本次请求都已尝试过'
      },
    })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(asked).toBe(0)
    expect(message).not.toContain('池中其余账号本次请求都已尝试过')
    expect(message).not.toContain('池中没有其他可用账号')
    // And the correct advice is the request-shaped one, because that is the
    // only thing that can fix a parameter rejection.
    expect(message).toContain('与网络、账号、额度都无关，换账号也不会改变结果')
  })

  it('prints the HTTP status exactly once', async () => {
    // Defect 3: `（http 400）（http 400）`. Counted rather than asserted-present,
    // because "contains http 400" was true of the broken line too.
    shim = mount({ result: failure(400, 'client', PARAMS_REJECTED_BODY) })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(message.match(/http 400/gu)).toHaveLength(1)
  })

  it('still asks the pool — and still prints the pool verdict — for a failure that IS failed over', async () => {
    // The complementary guard: fixing #78 by never asking would silently delete
    // the explanation #56 added. A rate limit does walk the pool, so it keeps
    // both the shortfall sentence and the model advice.
    let asked = 0
    shim = mount({
      result: {
        ok: false,
        status: 429,
        kind: 'soft_rate',
        message: '您的使用量已超出频率限制，将在 2026-10-02 05:23:27 UTC+8 重置。',
      },
      failover: async () => undefined,
      shortfall: async () => {
        asked += 1
        return '池中已无可用账号（2 个账号被限流）'
      },
    })
    await shim.ready

    const { status, message } = await messageOf(shim)
    expect(asked).toBe(1)
    expect(status).toBe(429)
    expect(message).toContain('池中已无可用账号（2 个账号被限流）')
    expect(message).toContain('建议换一个模型继续')
    expect(message).toContain('被限流')
    // The upstream's reset time survives: it is the one actionable fact a
    // generic sentence would destroy.
    expect(message).toContain('2026-10-02 05:23:27')
  })

  it('keeps the pool sentence off a failure the host did not describe', async () => {
    shim = mount({
      result: failure(429, 'soft_rate', '{"msg":"too fast"}'),
      failover: async () => undefined,
    })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(message).not.toContain('池中已无可用账号')
    expect(message).not.toContain('建议换一个模型继续')
    // With no `displayTips`, `displayMsg` is the receipt rather than the body.
    expect(message).toContain('too fast')
  })

  it('clips a long unparsed body with an ellipsis instead of ending mid-word', async () => {
    // A non-JSON gateway page has no `detail`, so the raw text IS the receipt —
    // and it is the case the old `slice(0, 400)` was written for. The ellipsis
    // says "the text continues", which a hard cut cannot.
    const page = `upstream gateway error ${'detail '.repeat(120)}`
    shim = mount({ result: failure(502, 'server', page) })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(message).toContain('upstream gateway error')
    expect(message).toContain('…')
    expect(message).not.toContain('detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail')
    // Bounded: the message cannot regrow into a wall of text.
    expect(message.length).toBeLessThan(600)
  })

  it('shows a short non-JSON page as-is, without inventing a cut', async () => {
    shim = mount({ result: failure(502, 'server', '<html><body>502 Bad Gateway</body></html>') })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(message).toContain('502 Bad Gateway')
    expect(message).not.toContain('…')
    expect(message).toContain('上游异常')
  })

  it('leaves the other failure branches untouched', async () => {
    // #78 must not reshape sentences that were already right. The policy and
    // model-busy branches each have their own hand-written copy and their own
    // tests; this is the cross-check that the generic rewrite did not capture
    // them by accident.
    const policy = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      requestId: '3498bf50',
      displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
      displayTips: { zh: '请修改输入后重试。' },
    })
    shim = mount({ result: failure(403, 'policy_reject', policy) })
    await shim.ready
    let first = await messageOf(shim)
    expect(first.message).toContain('内容未通过安全审核，请调整后重试。')
    expect(first.message).toContain('服务端策略拒绝')
    expect(first.message).toContain('3498bf50')
    expect(first.message).not.toContain('池中')
    await shim.close()

    const busy = JSON.stringify({
      code: 14003,
      msg: 'too many requests',
      displayMsg: { zh: '请求过于频繁，请稍后重试。' },
      displayTips: { zh: '建议等待约 1 分钟后重试，或切换到负载较低的模型。' },
    })
    shim = mount({ result: failure(429, 'model_busy', busy) })
    await shim.ready
    first = await messageOf(shim)
    expect(first.message).toContain('请求过于频繁，请稍后重试。')
    expect(first.message).toContain('这不是账号被限流')
    expect(first.message).not.toContain('已尝试')
  })
})

describe('issue #78: displayTips is parsed as data', () => {
  // Parsing is tested separately from rendering because the two can regress
  // independently: a caller that ignores `tips` would leave these green, and a
  // parser that stopped lifting them would leave the rendering tests green only
  // for bodies that also carry `displayMsg`.
  it('lifts displayTips from the object form, preferring zh', () => {
    const detail = parseUpstreamErrorDetail(PARAMS_REJECTED_BODY)
    expect(detail?.tips).toBe('这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。')
    expect(detail?.displayMsg).toBe('模型无法处理此请求，请重试')
    expect(detail?.upstreamCode).toBe(11133)
    expect(detail?.requestId).toBe('33221fe5-f6d5-4ea1-8882-669411e07a5b')
  })

  it('accepts displayTips as a plain string', () => {
    const detail = parseUpstreamErrorDetail(JSON.stringify({ code: 1, displayTips: 'Switch models.' }))
    expect(detail?.tips).toBe('Switch models.')
  })

  it('falls back to the English tips when no Chinese one is shipped', () => {
    const detail = parseUpstreamErrorDetail(JSON.stringify({ displayTips: { en: 'Start a new task.' } }))
    expect(detail?.tips).toBe('Start a new task.')
  })

  it('omits tips entirely for a body that has none', () => {
    const detail = parseUpstreamErrorDetail(JSON.stringify({ code: 2, msg: 'nope' }))
    expect(detail?.tips).toBeUndefined()
    expect(detail?.displayMsg).toBe('nope')
  })
})

describe('issue #83: an `off` refusal names the tier and reports it', () => {
  it('says WHICH tier was refused, instead of only that the request failed', async () => {
    // The reported experience: compaction showed "could not produce a useful
    // summary" and the log showed a bare 400 / 11133. The reader could act on
    // this — the remedy is one checkbox.
    shim = mount({ result: failure(400, 'client', OFF_REJECTED_BODY) })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(message).toContain('推理档位')
    expect(message).toContain('off')
    expect(message).toContain('reasoning_effort')
    // ...and the remedy, which is in the plugin's own words because the
    // upstream's tips describe a different problem.
    expect(message).toContain('可关闭思考')
  })

  it('does not blame the upgrade for a refusal it cannot attribute', async () => {
    // The #78 body has an EMPTY `param`. Guessing "reasoning tier" there would
    // put a wrong cause in front of a user whose request failed for another
    // reason, so the generic advice must survive untouched.
    shim = mount({ result: failure(400, 'client', PARAMS_REJECTED_BODY) })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(message).not.toContain('推理档位')
    expect(message).toContain('这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。')
  })

  it('reports the refusal so a surface that swallows the reply can still show it', async () => {
    // Compaction reads the failure as a boolean; this callback is the only route
    // the observation takes to the model card.
    const seen: { param?: string, tier?: string, code?: number, modelId?: string }[] = []
    shim = mount({
      result: failure(400, 'client', OFF_REJECTED_BODY),
      reportRefusal: report => { seen.push(report as { param?: string }) },
    })
    await shim.ready

    await messageOf(shim)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ param: 'reasoning_effort', tier: 'off', code: 11133 })
    // The model the body NAMED, not the account's route alias — otherwise the
    // badge would never attach to a row in the card.
    expect(seen[0]?.modelId).toBe('deepseek-v4.1-flash')
  })

  it('reports nothing for a failure that names no parameter', async () => {
    const seen: unknown[] = []
    shim = mount({ result: failure(500, 'server', '{"code":500,"msg":"internal"}'), reportRefusal: report => { seen.push(report) } })
    await shim.ready

    await messageOf(shim)
    expect(seen).toHaveLength(0)
  })
})

/**
 * Issue #253: the upstream refuses a TOOL DEFINITION with business code 11129,
 * and its own advice ("请新建任务，或换个模型") points at neither the tools nor
 * anything the reader can inspect. The reporter spent a day on account swaps,
 * re-logins and a reinstall because of that sentence.
 *
 * The plugin now rewrites the four known schema shapes on the way out (see
 * `tests/issue253-tool-schema-normalization.spec.ts`), so a 11129 that still
 * arrives means a shape this build does not know. The reply must say THAT —
 * and must stop repeating the upstream's two useless remedies.
 */
describe('issue #253: a tool-definition refusal names the tools, not the account', () => {
  /** The real 11129 envelope, verbatim from the measured upstream response. */
  const TOOL_SCHEMA_BODY = '{"code":11129,"msg":"invalid function call parameters","requestId":"f257ba60-491d-4b90-838a-ad6457059785","retry_policy":{"retry":false},"extError":{"code":"invalid_function_parameters","message":"invalid function call parameters","param":"","type":"invalid_request_error","StatusCode":400,"Request":null,"Response":null},"displayMsg":{"en":"Invalid tool definition. Please start a new task and retry","zh":"工具定义不合规，请新建任务重试"},"displayTips":{"en":"The tool\'s parameter structure does not meet the current model\'s requirements and was rejected. Please start a new task or switch to another model.","zh":"工具的参数结构不符合当前模型要求，被服务端拒绝。请新建任务，或换个模型。"},"actions":["RETRY","SUBMIT_FEEDBACK"]}'

  it('says the TOOLS were refused, lists what was already rewritten, and stops pointing at accounts', async () => {
    shim = mount({ result: failure(400, 'client', TOOL_SCHEMA_BODY) })
    await shim.ready

    const { status, message, type } = await messageOf(shim)
    expect(status).toBe(400)
    // Still `client`: this changes advice only, never the kind (which is what
    // decides failover).
    expect(type).toBe('client')
    expect(message).toContain('工具定义')
    expect(message).toContain('换账号或重试都不会改变结果')
    // The four shapes the rewrite already handles, so the reader can rule them out.
    expect(message).toContain('元组式 `items`')
    expect(message).toContain('外部 `$ref`')
    // The upstream's own two remedies must be REPLACED, not appended: "switch
    // models" only sidesteps the definition and "new task" does nothing at all.
    expect(message).not.toContain('请新建任务，或换个模型')
    expect(message).not.toContain('请新建任务重试')
    // And the raw envelope skeleton is still never rendered.
    expect(message).not.toContain('extError')
    expect(message).not.toContain('displayTips')
  })

  it('keeps the ordinary parameter-rejection wording for every OTHER client failure', async () => {
    // The 11133 body from issue #78 must not acquire the tool sentence: the
    // discrimination is by code, and getting it wrong would send a reasoning-tier
    // problem to an MCP server hunt.
    shim = mount({ result: failure(400, 'client', PARAMS_REJECTED_BODY) })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(message).not.toContain('工具定义')
    expect(message).toContain('这次对话的内容这个模型不接受')
  })

  it('reports a 11129 without a raw `"code": 11129` spelling (the envelope shape)', async () => {
    // `statesBusinessCode` reads the parsed document first, so the spaced and
    // string spellings must classify too — the same hole issue #155 closed for
    // 11140 must not reopen here.
    shim = mount({
      result: failure(400, 'client', JSON.stringify({
        code: '11129',
        msg: 'invalid function call parameters',
        displayTips: { zh: '工具的参数结构不符合当前模型要求' },
      })),
    })
    await shim.ready

    const { message } = await messageOf(shim)
    expect(message).toContain('工具定义')
  })
})
