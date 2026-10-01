/**
 * The OUTGOING REQUEST BODY, not the context handed to the api.
 *
 * Issue #26's test recommendation: the 3.0.2 wiring tests asserted that the
 * provider received a FOLDED context — which cemented the defect as the
 * expected behaviour, because a folded context is exactly what loses the tools
 * when nobody promotes `toolsAdded`. What actually reaches the upstream is the
 * JSON body the api builds, so THAT is what this spec pins, by injecting the
 * fetch the real pi-ai api would call the shim with and capturing the body.
 *
 * This checkout resolves pi-ai 0.85.1, so the adapter takes its LEGACY branch:
 * the assertions below are the ones that failed before the tool-state
 * promotion existed (body.tools MISSING — reproduced in the issue and locally)
 * and must never regress. The modern (0.87+) branch is pinned in
 * adapter.spec.ts at the wiring level, because this repository cannot resolve
 * a 0.87 copy to run its real api here.
 */

import { describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { piAiRuntimeInfo } from '../src/pi-ai-runtime.ts'

/**
 * A model descriptor the 0.85 openai-completions api accepts as-is. The real
 * api reads baseUrl/input/cost/compat (a bare {id, api, provider} trips inside
 * buildParams before any fetch happens), so this mirrors what toPiModel emits.
 */
const MODEL = {
  id: 'hy3',
  name: 'hy3',
  api: 'openai-completions',
  provider: WORKBUDDY_PROVIDER,
  baseUrl: 'http://127.0.0.1:9/v1',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
  compat: {},
} as never

/** What dsh-llm-pi-ai 0.2.0-rc.2 + pi-ai 0.87.1 normalizeContext hands the provider. */
function normalizedTranscript(): { messages: unknown[] } {
  return {
    messages: [
      {
        role: 'system',
        content: 'You are helpful.',
        toolsAdded: [{
          name: 'pwsh',
          description: 'run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        }],
        timestamp: 0,
      },
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    ],
  }
}

describe('the outgoing request body carries the prompt and the tools', () => {
  it.skipIf(piAiRuntimeInfo().generation !== 'legacy')(
    'sends body.tools and a leading system message with the original prompt',
    async () => {
      const { adapter } = createWorkBuddyAdapter({
        shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
        store: {} as never,
        catalog: new WorkBuddyCatalog(),
      })
      const profile = (adapter as unknown as {
        config: { profiles: () => ReadonlyMap<string, { piProvider: { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown } }> }
      }).config.profiles().get(WORKBUDDY_PROVIDER)
      expect(profile).toBeDefined()

      let body: Record<string, unknown> | undefined
      const streamErrors: string[] = []
      const stream = profile?.piProvider.streamSimple(MODEL, normalizedTranscript(), {
        apiKey: 'k',
        maxTokens: 10,
        fetch: async (_url: unknown, init: { body?: unknown }) => {
          body = JSON.parse(String(init.body)) as Record<string, unknown>
          throw new Error('captured before any network')
        },
      }) as AsyncIterable<{ type?: string, error?: { errorMessage?: string } }>
      // Drain: the injected fetch throws, which surfaces as a stream error
      // event — the body has been captured by then. Any error BEFORE the
      // fetch means the request was never built; surface it in the failure.
      for await (const event of stream) {
        if (event?.type === 'error') streamErrors.push(String(event.error?.errorMessage ?? 'unknown stream error'))
      }
      expect(body, `no request was built; stream errors: ${streamErrors.join(' | ') || '(none)'}`).toBeDefined()

      // THE two assertions from issue #26: the tool declarations the host
      // folded into toolsAdded must reach the wire, and the conversation must
      // open with the original system prompt.
      const tools = body?.tools as { function?: { name?: string } }[] | undefined
      expect(tools).toBeDefined()
      expect(tools?.map(tool => tool.function?.name)).toEqual(['pwsh'])

      const messages = body?.messages as { role?: string, content?: unknown }[]
      expect(messages).toBeDefined()
      expect(messages.filter(message => message.role === 'system' || message.role === 'developer')).toHaveLength(1)
      expect(messages[0]?.role).toBe('system')
      expect(messages[0]?.content).toBe('You are helpful.')
    },
  )
})
