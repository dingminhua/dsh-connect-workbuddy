import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  WorkBuddyUpstreamClient,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
  classifyUpstreamError,
  declaredTools,
  parseCreditMultiplier,
  parseReasoning,
  parseUpstreamModel,
  prepareChatBody,
  regionOf,
  globalBase,
} from '../src/upstream.ts'

describe('prepareChatBody', () => {
  it('forces streaming and flattens object tool_choice', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3',
      stream: false,
      tool_choice: { type: 'function', function: { name: 'read' } },
    }))) as Record<string, unknown>
    expect(prepared['stream']).toBe(true)
    expect(prepared['tool_choice']).toBe('read')
  })

  it('normalizes DSH developer messages to WorkBuddy system messages', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'developer', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ],
    }))) as { messages: { role: string; content: string }[] }
    expect(prepared.messages.map(message => message.role)).toEqual(['system', 'user'])
  })

  it('drops tools when tool_choice is none', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'read' } }],
    }))) as Record<string, unknown>
    expect(prepared['tool_choice']).toBeUndefined()
    expect(prepared['tools']).toBeUndefined()
  })

  it('prepends the fallback system message when the body opens with a user turn', () => {
    // The international gateway refuses a user-first body with business code
    // 11128, which it surfaces as "blocked by security policy"; the domestic one
    // tolerates it. A system message can vanish before this module ever sees the
    // body (pi-ai emits a prompt only `if (context.systemPrompt)`, and demotes a
    // `system` entry left in `messages` to `user`), so the head is checked here.
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'still here' },
      ],
    }))) as { messages: { role: string; content: unknown }[] }
    expect(prepared.messages.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(prepared.messages[0]?.content).toBe(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
    expect(prepared.messages[1]?.content).toBe('hello')
  })

  it('leaves an already system-first body alone', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'the real prompt' },
        { role: 'user', content: 'hello' },
      ],
    }))) as { messages: { role: string; content: unknown }[] }
    expect(prepared.messages).toHaveLength(2)
    expect(prepared.messages[0]?.content).toBe('the real prompt')
  })

  it('adds no system message when the body carries no history', () => {
    // Nothing to repair, and inventing a turn for a body with no conversation
    // would change requests this rule is not about.
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({ messages: [] }))) as { messages: unknown[] }
    expect(prepared.messages).toEqual([])
    const noMessages = JSON.parse(prepareChatBody(JSON.stringify({ model: 'glm-5.3' }))) as Record<string, unknown>
    expect(noMessages['messages']).toBeUndefined()
  })

  it('passes non-JSON bodies through untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })
})

describe('classifyUpstreamError', () => {
  it('maps credit exhaustion from Chinese markers', () => {
    expect(classifyUpstreamError(400, '积分不足')).toBe('hard_credit')
  })

  it('maps dead sessions ahead of generic client errors', () => {
    expect(classifyUpstreamError(400, 'Offline user session not found')).toBe('session_dead')
  })

  it('maps rate limits and server faults', () => {
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })
})

describe('regionOf', () => {
  it('routes workbuddy.ai to global and everything else to cn', () => {
    expect(regionOf('www.workbuddy.ai')).toBe('global')
    expect(regionOf('app.workbuddy.ai')).toBe('global')
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('www.workbuddy.cn')).toBe('cn')
    expect(regionOf('')).toBe('cn')
  })

  it('classifies the codebuddy.ai brand domain as global', () => {
    // The CodeBuddy CLI signs the international account in at codebuddy.ai,
    // a second brand domain for the same product (issue #4). Classifying it as
    // cn sent its token to the CN gateway, which answered an openresty HTML 401.
    expect(regionOf('www.codebuddy.ai')).toBe('global')
    expect(regionOf('codebuddy.ai')).toBe('global')
    expect(regionOf('app.codebuddy.ai')).toBe('global')
    // Case and surrounding whitespace are normalized the same way.
    expect(regionOf('  WWW.CodeBuddy.AI  ')).toBe('global')
    // The CN brand domain must NOT be promoted by a loose suffix match.
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('notcodebuddy.ai')).toBe('cn')
  })
})

describe('globalBase', () => {
  it('follows the credential OWN brand domain', () => {
    // A token issued at codebuddy.ai is rejected by the workbuddy.ai gateway,
    // so the base has to track the credential rather than a fixed host.
    expect(globalBase('www.codebuddy.ai')).toBe('https://www.codebuddy.ai')
    expect(globalBase('codebuddy.ai')).toBe('https://www.codebuddy.ai')
    expect(globalBase('www.workbuddy.ai')).toBe('https://www.workbuddy.ai')
    // Unknown global spellings fall back to the desktop app's gateway.
    expect(globalBase('')).toBe('https://www.workbuddy.ai')
    expect(globalBase('some.other.ai')).toBe('https://www.workbuddy.ai')
  })
})

describe('WorkBuddyUpstreamClient.fetchModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function credential(domain: string): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain,
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  /** Run fetchModels against a stubbed upstream; return the URL it called. */
  async function fetchModelsUrl(domain: string): Promise<string> {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 200_000, maxOutputTokens: 48_000 }],
            agents: [{ name: 'cli', models: ['glm-5.3'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential(domain))
    expect(models.map(model => model.id)).toEqual(['glm-5.3'])
    expect(urls).toHaveLength(1)
    const url = urls[0]
    if (url === undefined) throw new Error('fetchModels performed no upstream request')
    return url
  }

  it('auto-routes CN and global accounts by credential domain', async () => {
    // CN reads the shared personal-models path on its chat gateway. The global
    // gateway serves the account's chat roster as the DESKTOP channel's product
    // config at /v3/config: its personal-models path returns HTTP 500 there,
    // and the CLI channel's config omits chat-usable models
    // (deepseek-v4.1-flash, gpt-6-astra) — so the desktop user agent is what
    // selects the right document. This pins the international-version fixes.
    expect(await fetchModelsUrl('www.codebuddy.cn'))
      .toBe('https://copilot.tencent.com/v2/enterprises/personal/models')
    expect(await fetchModelsUrl('www.workbuddy.cn'))
      .toBe('https://copilot.tencent.com/v2/enterprises/personal/models')
    expect(await fetchModelsUrl('www.workbuddy.ai'))
      .toBe('https://www.workbuddy.ai/v3/config')
  })

  it('routes a codebuddy.ai credential to its own gateway, not the CN one', async () => {
    // Regression for issue #4: www.codebuddy.ai was classified as cn, so the
    // request went to copilot.tencent.com and came back an openresty HTML 401.
    expect(await fetchModelsUrl('www.codebuddy.ai'))
      .toBe('https://www.codebuddy.ai/v3/config')
    expect(await fetchModelsUrl('codebuddy.ai'))
      .toBe('https://www.codebuddy.ai/v3/config')
  })

  it('sends the desktop user agent on the global config request', async () => {
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, credits: 'x0.00' }],
            agents: [{ name: 'cli', models: ['deepseek-v4.1-flash'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential('www.workbuddy.ai'))
    // The CLI user agent returns a 35-model roster without this model; only the
    // desktop channel's document carries the account's real chat list.
    expect(seen['User-Agent']).toBe('WorkBuddy/5.5.2')
    expect(seen['X-Product']).toBe('SaaS')
    expect(models.map(model => model.id)).toEqual(['deepseek-v4.1-flash'])
    expect(models[0]?.creditMultiplier).toBe(0)
  })

  it('keeps the CLI user agent on the CN gateway', async () => {
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 48_000 }],
            agents: [{ name: 'cli', models: ['glm-5.3'] }],
          },
        }),
      } as unknown as Response
    })
    await new WorkBuddyUpstreamClient().fetchModels(credential('www.codebuddy.cn'))
    // The CN desktop config carries no `cli` roster at all, so its gateway must
    // keep receiving the CLI agent the plugin actually chats as.
    expect(seen['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
  })

  it('explains a gateway HTML 401 instead of echoing the raw page', async () => {
    // The upstream edge (openresty/APISIX) answers an HTML page when it refuses
    // a revoked token. The user needs to know to re-sign in, not to read markup.
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      text: async () => '<html><head><title>401 Authorization Required</title></head>'
        + '<body><center><h1>401 Authorization Required</h1></center>'
        + '<hr><center>openresty</center></body></html>',
    }) as unknown as Response)
    const error = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'))
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('rejected by the upstream gateway')
    expect(error?.message).toContain('Re-sign in')
    expect(error?.message).not.toContain('<html>')
  })

  it('keeps the generic message for a non-auth non-JSON failure', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      text: async () => '<html><body>Bad Gateway</body></html>',
    }) as unknown as Response)
    const error = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'))
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('non-JSON')
  })
})

describe('parseCreditMultiplier', () => {
  it('parses the observed upstream spellings', () => {
    expect(parseCreditMultiplier('x0.79 credits')).toBe(0.79)
    expect(parseCreditMultiplier('x0.05')).toBe(0.05)
    expect(parseCreditMultiplier('x0.00 credits')).toBe(0)
  })

  it('returns undefined rather than guessing', () => {
    expect(parseCreditMultiplier(undefined)).toBeUndefined()
    expect(parseCreditMultiplier('free')).toBeUndefined()
    expect(parseCreditMultiplier(0.5)).toBeUndefined()
  })
})

describe('parseReasoning', () => {
  it('keeps declared effort levels', () => {
    expect(parseReasoning({ supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' })).toEqual({
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
    })
  })

  it('drops an empty reasoning object instead of reporting a capability', () => {
    expect(parseReasoning({})).toBeUndefined()
    expect(parseReasoning({ unsupported: 1 })).toBeUndefined()
  })

  // The singular `effort` spelling (issue #7): `deepseek-v4.1-flash`,
  // `kimi-k3` and friends declare only a default level. Both gateways accept
  // the whole ladder on these models and think off when no reasoning_effort
  // is sent, so the fold widens supportedEfforts and keeps off available.
  it('folds the singular effort form into the full ladder', () => {
    expect(parseReasoning({ effort: 'high', summary: 'auto' })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(parseReasoning({ effort: 'medium', summary: 'auto' })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      canDisableThinking: true,
    })
  })

  it('passes an unrecognized singular effort through as the lone level', () => {
    expect(parseReasoning({ effort: 'turbo', summary: 'auto' })).toEqual({
      supportedEfforts: ['turbo'],
      defaultEffort: 'turbo',
      canDisableThinking: true,
    })
  })

  it('lets the plural form win when both spellings appear', () => {
    expect(parseReasoning({ effort: 'high', supportedEfforts: ['low', 'high'] })).toEqual({
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
    })
    expect(parseReasoning({ effort: 'high', canDisableThinking: false })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: false,
    })
  })
})

describe('parseUpstreamModel', () => {
  it('carries the fields the plugin card displays', () => {
    const model = parseUpstreamModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 48_000,
      credits: 'x0.79',
      supportsImages: true,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
      descriptionZh: '能力均衡',
    })
    expect(model).toMatchObject({
      id: 'glm-5.3',
      contextWindow: 1_000_000,
      maxTokens: 48_000,
      creditMultiplier: 0.79,
      descriptionZh: '能力均衡',
      supportsImages: true,
    })
    expect(model?.reasoning?.supportedEfforts).toEqual(['low', 'high'])
  })

  it('registers singular-effort models as reasoning-capable (issue #7)', () => {
    // Live /v3/config shape of `deepseek-v4.1-flash` on the global gateway:
    // only the singular `effort` default is declared, and without this fold
    // the whole reasoning object was dropped (thinking never enabled).
    const model = parseUpstreamModel({
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: { effort: 'high', summary: 'auto' },
    })
    expect(model?.reasoning).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
  })

  it('never infers multimodal from the upstream image flags', () => {
    // `multimodal` is the RUNTIME capability, stamped from the saved
    // `imageModelIds`; the parser must never set it, or a stale upstream flag
    // would silently re-enable image input the user had switched off.
    expect(parseUpstreamModel({
      id: 'a',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: true,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'b',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: false,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'c',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: true,
      disabledMultimodal: true,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'd',
      maxInputTokens: 1,
      maxOutputTokens: 1,
    })?.multimodal).toBeUndefined()
  })

  it('parses the upstream image default into supportsImages', () => {
    // The value only pre-fills the card's image checkboxes on refresh; the
    // effective capability still comes from the saved selection.
    const parsed = (extra: Record<string, unknown>): boolean | undefined => parseUpstreamModel({
      id: 'x',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      ...extra,
    })?.supportsImages
    expect(parsed({ supportsImages: true })).toBe(true)
    expect(parsed({ supportsImages: false })).toBe(false)
    // `disabledMultimodal: true` is a hard veto even alongside
    // `supportsImages: true`. Live data has never shown that conflict (CN
    // 2026-09-29: 0 of 30 entries), so this is a defensive rule: when upstream
    // does contradict itself, err on the side of NOT sending images.
    expect(parsed({ supportsImages: true, disabledMultimodal: true })).toBe(false)
    expect(parsed({ disabledMultimodal: true })).toBe(false)
    // Absent flags stay unknown rather than becoming an implicit `false`.
    expect(parsed({})).toBeUndefined()
  })

  it('rejects disabled models and models without token limits', () => {
    expect(parseUpstreamModel({ id: 'a', disabled: true, maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ id: 'b', maxInputTokens: 0, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ id: '', maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
  })
})

/**
 * The input to DSML recovery: which tool names THIS request offered.
 *
 * Getting this wrong is the difference between a recovery that can never fire
 * (names unrecognised, so every block is refused) and one that fires on a name
 * the caller never authorised — the production accident the gates exist for.
 * The `tool_choice: "none"` case is the important one: `prepareChatBody` deletes
 * `tools` for it, so gate 3 comes out of the same prepared JSON rather than
 * from a second rule someone has to remember to keep in sync.
 */
describe('declaredTools', () => {
  it('reads names and required parameters from a prepared body', () => {
    const prepared = prepareChatBody(JSON.stringify({
      tools: [
        { type: 'function', function: { name: 'bash', parameters: { type: 'object', required: ['command'] } } },
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      ],
    }))
    const declared = declaredTools(prepared)
    expect(declared?.names).toEqual(new Set(['bash', 'read_file']))
    expect(declared?.requiredParameters.get('bash')).toEqual(['command'])
    // A tool with no `required` list contributes no entry rather than an empty
    // one: an empty list would read as "checked and nothing is required", which
    // is the same answer but hides the difference between the two.
    expect(declared?.requiredParameters.has('read_file')).toBe(false)
    expect(declared?.pinnedToolName).toBeUndefined()
  })

  it('reports nothing when the prepared body declares no tools (gate 3)', () => {
    expect(declaredTools(prepareChatBody(JSON.stringify({ messages: [] })))).toBeUndefined()
    expect(declaredTools(prepareChatBody(JSON.stringify({
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'bash' } }],
    })))).toBeUndefined()
    expect(declaredTools(prepareChatBody(JSON.stringify({ tools: [] })))).toBeUndefined()
  })

  it('reports a pinned tool_choice as a bare name', () => {
    const prepared = prepareChatBody(JSON.stringify({
      tools: [{ type: 'function', function: { name: 'read' } }],
      tool_choice: { type: 'function', function: { name: 'read' } },
    }))
    expect(declaredTools(prepared)?.pinnedToolName).toBe('read')
  })

  it('does not treat auto or required as a pin', () => {
    for (const choice of ['auto', 'required']) {
      const prepared = prepareChatBody(JSON.stringify({
        tools: [{ type: 'function', function: { name: 'read' } }],
        tool_choice: choice,
      }))
      expect(declaredTools(prepared)?.pinnedToolName).toBeUndefined()
    }
  })

  it('returns nothing for an unparsable or malformed body', () => {
    expect(declaredTools('not json')).toBeUndefined()
    expect(declaredTools('[]')).toBeUndefined()
    expect(declaredTools(JSON.stringify({ tools: [{ type: 'function' }, { function: { name: 7 } }, null] })))
      .toBeUndefined()
  })
})
