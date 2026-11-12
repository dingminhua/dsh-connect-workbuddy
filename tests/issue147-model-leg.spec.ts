/**
 * Issue #147, the leg that 5.12.0 missed: `isSameModel` has THREE comparisons.
 *
 * `transform-messages.js`'s `isSameModel` compares `provider`, `api` AND `model`
 * against the request (line numbers move between pi-ai releases, so this file
 * names the symbol instead). The 5.12.0 repair's own predicate (`isForeignAssistant`) compared
 * only the first two, so a session that switched MODELS inside a single region
 * — `hy3` → `deepseek-v4.1-flash`, both served by this bundle and both stamped
 * `provider: workbuddy` — reproduced the whole defect while the repair reported
 * nothing and removed nothing.
 *
 * These tests pin all three legs of that gap, through the REAL pi-ai transform
 * so the mechanism is under test rather than a mock of it:
 *   1. the miss is real (pi-ai stops treating it as the same model, the old
 *      predicate saw nothing) — what it then does with the block, flatten or
 *      discard, is the installed generation's business, measured by
 *      `foreign-thinking-helpers.ts` rather than assumed;
 *   2. with `requestModelId`, the same case is detected and repaired;
 *   3. omitting it keeps the previous behaviour exactly (no regression for the
 *      callers that cannot know the request's model);
 *   4. a message already on the request's model is never touched — the model
 *      leg must not turn into "everything is foreign".
 *
 * @module dsh-connect-workbuddy/tests/issue147-model-leg
 */

import { describe, expect, it } from 'vitest'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { foreignThinkingAsProse, foreignThinkingDisposition } from './foreign-thinking-helpers.ts'
import type { Context, Model, Api } from '@earendil-works/pi-ai'
import {
  dropForeignThinking,
  foreignThinkingOf,
  WORKBUDDY_MODEL_IDENTITY,
  WORKBUDDY_PROVIDER,
} from '../src/adapter.ts'

/** The request's model: this plugin's own identity, exactly as production builds it. */
const MODEL = {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  api: 'openai-completions',
  provider: WORKBUDDY_MODEL_IDENTITY,
  baseUrl: 'http://127.0.0.1:1/v1',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8_192,
  reasoning: true,
} as unknown as Model<Api>

/** One turn this plugin produced, recorded under `model`. */
function ownTurn(modelId: string, thinking = 'my own working notes'): Record<string, unknown> {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: WORKBUDDY_PROVIDER,
    model: modelId,
    content: [
      { type: 'thinking', thinking, thinkingSignature: 'reasoning_content' },
      { type: 'text', text: 'the answer' },
    ],
    usage: { input: 1, output: 1 },
    stopReason: 'stop',
    timestamp: 1,
  }
}

function contextOf(messages: readonly Record<string, unknown>[]): Context {
  return { messages: [...messages] } as unknown as Context
}

/** Block types of every assistant message after pi-ai's own transform. */
function typesAfterTransform(context: Context): string[][] {
  return transformMessages(context.messages as never, MODEL as never)
    .filter(message => message.role === 'assistant')
    .map(message => message.content.map(block => block.type))
}

/** Every `text` body pi-ai would publish, concatenated. */
function proseAfterTransform(context: Context): string {
  return transformMessages(context.messages as never, MODEL as never)
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.content)
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('the defect pi-ai still has when only the provider and api match', () => {
  it('flattens the reasoning of a turn recorded under a DIFFERENT model on the same route', () => {
    // The premise, through the real transform: provider and api are equal, so
    // the only failing leg is `model`. What pi-ai then DOES with the block is
    // the installed library's business — up to 1.2 it published the reasoning
    // as prose, 1.3+ discards it (tests/foreign-thinking-helpers.ts measures
    // which). The leg under test is that `model` is what decides, not the
    // eventual disposition.
    const context = contextOf([ownTurn('hy3')])
    expect(typesAfterTransform(context)).toEqual([[...foreignThinkingAsProse(), 'text']])
    if (foreignThinkingDisposition() === 'flattened') {
      expect(proseAfterTransform(context)).toContain('my own working notes')
    }
  })
})

describe('without the request model id the repair cannot see this case', () => {
  it('reports nothing, which is exactly the 5.12.0 blind spot', () => {
    const context = contextOf([ownTurn('hy3')])
    // The old, two-leg call. Kept as the control: if this ever starts reporting,
    // the tests below stop proving that the model leg is what fixes it.
    expect(foreignThinkingOf(context)).toHaveLength(0)
    expect(dropForeignThinking(context)).toBe(context)
  })
})

describe('with the request model id the model leg is covered', () => {
  it('detects the block and removes it, so no prose is manufactured', () => {
    const context = contextOf([ownTurn('hy3')])
    const affected = foreignThinkingOf(context, WORKBUDDY_MODEL_IDENTITY, MODEL.id)
    expect(affected).toHaveLength(1)
    expect(affected[0]).toMatchObject({ messageIndex: 0, blockIndex: 0, variant: 'flattened' })

    const repaired = dropForeignThinking(context, WORKBUDDY_MODEL_IDENTITY, MODEL.id)
    expect(proseAfterTransform(repaired)).toBe('the answer')
    expect(typesAfterTransform(repaired)).toEqual([['text']])
  })

  it('still reports the foreign-provider case, so the third leg is additive', () => {
    const foreign = {
      role: 'assistant',
      api: 'dsh-foreign',
      provider: 'deepseek',
      model: 'deepseek-chat',
      content: [{ type: 'thinking', thinking: 'their notes' }],
      usage: { input: 1, output: 1 },
      stopReason: 'stop',
      timestamp: 1,
    }
    expect(foreignThinkingOf(contextOf([foreign]), WORKBUDDY_MODEL_IDENTITY, MODEL.id)).toHaveLength(1)
  })
})

describe('the model leg never fires on a turn recorded under the request model', () => {
  it('returns the same context object for a message on this exact model', () => {
    // The failure mode of a careless model comparison: if it ignored the
    // request's id and compared against nothing, every turn would look foreign
    // and the repair would delete this model's own reasoning (#102's
    // regression, from the third direction).
    const context = contextOf([ownTurn(MODEL.id)])
    expect(foreignThinkingOf(context, WORKBUDDY_MODEL_IDENTITY, MODEL.id)).toHaveLength(0)
    expect(dropForeignThinking(context, WORKBUDDY_MODEL_IDENTITY, MODEL.id)).toBe(context)
  })

  it('leaves a message with no model field alone, because it cannot be compared', () => {
    const odd = { ...ownTurn('hy3') }
    delete (odd as Record<string, unknown>)['model']
    expect(foreignThinkingOf(contextOf([odd]), WORKBUDDY_MODEL_IDENTITY, MODEL.id)).toHaveLength(0)
  })

  it('a foreign turn stays foreign even when its model id happens to match', () => {
    // The other direction: matching model ids must not launder a turn whose
    // provider came from another adapter.
    const foreign = {
      role: 'assistant',
      api: 'dsh-foreign',
      provider: 'deepseek',
      model: MODEL.id,
      content: [{ type: 'thinking', thinking: 'their notes' }],
      usage: { input: 1, output: 1 },
      stopReason: 'stop',
      timestamp: 1,
    }
    expect(foreignThinkingOf(contextOf([foreign]), WORKBUDDY_MODEL_IDENTITY, MODEL.id)).toHaveLength(1)
  })
})

describe('a realistic mid-session model switch', () => {
  it('removes only the turns recorded under the previous model', () => {
    const context = contextOf([
      { role: 'user', content: 'continue' },
      ownTurn('hy3', 'A'.repeat(400)),
      ownTurn('step-5-preview', 'B'.repeat(90)),
      ownTurn(MODEL.id, 'C'.repeat(70)),
    ])
    const affected = foreignThinkingOf(context, WORKBUDDY_MODEL_IDENTITY, MODEL.id)
    expect(affected.map(block => block.messageIndex)).toEqual([1, 2])
    expect(affected.reduce((sum, block) => sum + block.characters, 0)).toBe(490)

    const repaired = dropForeignThinking(context, WORKBUDDY_MODEL_IDENTITY, MODEL.id)
    // The current model's own reasoning survives; the earlier models' become
    // nothing rather than prose. Their text blocks stay — only thinking goes.
    expect(typesAfterTransform(repaired)).toEqual([['text'], ['text'], ['thinking', 'text']])
    expect(proseAfterTransform(repaired)).toBe('the answer'.repeat(3))
  })

  it('is idempotent with the model leg on', () => {
    const once = dropForeignThinking(contextOf([ownTurn('hy3')]), WORKBUDDY_MODEL_IDENTITY, MODEL.id)
    expect(dropForeignThinking(once, WORKBUDDY_MODEL_IDENTITY, MODEL.id)).toBe(once)
  })
})
