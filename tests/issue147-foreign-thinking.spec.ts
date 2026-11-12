/**
 * Issue #147: a foreign thinking block must not become the answer.
 *
 * THE DEFECT. pi-ai keeps a historical `thinking` block only while
 * `isSameModel` holds — provider AND api AND model id all equal to the request
 * (`api/transform-messages.js`, and the line numbers move between releases, so
 * this file names the symbol). For everything else, up to pi-ai 1.2, it did NOT
 * drop the block: it rewrote it to `{type:'text', text: thinking}`, i.e. the
 * answer channel. (From 1.3 the library discards the block instead, which makes
 * the repair a no-op — `tests/foreign-thinking-helpers.ts` measures which of the
 * two is in effect, and the premise assertion below follows it.) A session that moved between providers therefore arrives with
 * the OTHER model's working notes already spelled as prose, and the model reads
 * that shape and copies it.
 *
 * The reporter measured it on a real 80-step turn: 56 assistant messages
 * carried an answer while their own reasoning was ≤ 1 character, 20 of them
 * held English working notes totalling 58,960 characters, and CJK fell to 1.37%
 * of the visible text where the previous six turns had been entirely Chinese.
 * It also pushed the session from 696,966 to 758,005 total tokens against an
 * 800,000 compression threshold.
 *
 * WHY THE FIX IS "REMOVE" AND NOT "KEEP AS THINKING". `isSameModel` compares
 * the REQUEST's model against the MESSAGE's fields, and the only way to satisfy
 * it is to claim the foreign turn as this model's own output — the provenance
 * lie issue #111 removed. These blocks carry no `thinkingSignature`
 * (`dsh-llm-pi-ai`'s `foreignAssistant()` builds them without one), so they
 * could never be replayed as signed reasoning anyway: their ONLY possible
 * contribution to the wire was the prose they turned into.
 *
 * WHAT THESE TESTS PIN, all through the REAL pi-ai transform so the mechanism
 * itself is under test rather than a mock of it:
 *   1. the defect reproduces (a foreign block becomes `text`);
 *   2. with the repair on, no `text` block is produced from that reasoning;
 *   3. with it off, the request is byte-for-byte the OLD one;
 *   4. this plugin's OWN turns keep their thinking (issue #102 does not
 *      regress), including the route-id case that alignment exists for;
 *   5. text and tool calls are never touched;
 *   6. detection reports only what would actually surface.
 *
 * @module dsh-connect-workbuddy/tests/issue147-foreign-thinking
 */

import { describe, expect, it } from 'vitest'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { foreignThinkingAsProse, foreignThinkingDisposition } from './foreign-thinking-helpers.ts'
import type { Context, Model, Api } from '@earendil-works/pi-ai'
import {
  alignAssistantIdentities,
  crossProviderThinkingOf,
  dropForeignThinking,
  foreignThinkingOf,
  HOST_FOREIGN_API,
  WORKBUDDY_GLOBAL_PROVIDER,
  WORKBUDDY_MODEL_IDENTITY,
  WORKBUDDY_PROVIDER,
} from '../src/adapter.ts'

/** The request's model: this plugin's own stamp, exactly as production builds it. */
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

/** One assistant turn as `dsh-llm-pi-ai`'s `foreignAssistant()` builds it. */
function foreignTurn(thinking: string, stopReason = 'stop'): Record<string, unknown> {
  return {
    role: 'assistant',
    api: HOST_FOREIGN_API,
    provider: 'deepseek',
    model: 'deepseek-chat',
    content: [{ type: 'thinking', thinking }],
    usage: { input: 1, output: 1 },
    stopReason,
    timestamp: 1,
  }
}

/** One assistant turn this plugin produced. `provider` is the route id, as recorded. */
function ownTurn(provider: string, thinking: string): Record<string, unknown> {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider,
    model: MODEL.id,
    content: [
      { type: 'thinking', thinking, thinkingSignature: 'sig' },
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

describe('the defect itself (issue #147)', () => {
  it('pi-ai publishes a foreign thinking block as prose — this is what the fix removes', () => {
    const context = contextOf([foreignTurn('Now add normalizeGistName and update…')])
    // The premise, pinned through the real transform. WHICH premise holds
    // depends on the installed library (see tests/foreign-thinking-helpers.ts):
    // up to 1.2 pi-ai published the reasoning AS the answer, and 1.3+ discards
    // it instead. Both are measured here rather than assumed from a version.
    expect(typesAfterTransform(context)).toEqual([foreignThinkingAsProse()])
    if (foreignThinkingDisposition() === 'flattened') {
      expect(proseAfterTransform(context)).toContain('Now add normalizeGistName')
    } else {
      // 1.3+: the block is gone BEFORE the repair runs, so the repair removes
      // nothing here. It still runs, because a nested pi-ai copy can shadow the
      // host's (issue #24) and this bundle cannot rely on which one a user has.
      expect(proseAfterTransform(context)).toBe('')
    }
  })
})

describe('with the repair on, foreign reasoning never reaches the answer', () => {
  it('removes the block instead of letting pi-ai flatten it', () => {
    const context = contextOf([foreignTurn('Let me check the schema first.')])
    const before = foreignThinkingOf(context)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ messageIndex: 0, blockIndex: 0, variant: 'flattened' })

    const repaired = dropForeignThinking(context)
    // No prose is manufactured from that reasoning, and no `text` block appears.
    expect(proseAfterTransform(repaired)).toBe('')
    expect(typesAfterTransform(repaired)).toEqual([[]])
  })

  it('keeps the characters it removed out of the visible channel, not out of the transcript', () => {
    // The durable message is untouched: only the REQUEST projection drops the
    // block. A user reading the transcript still sees what the other model said.
    const context = contextOf([foreignTurn('private notes')])
    const repaired = dropForeignThinking(context)
    expect((context.messages[0] as unknown as { content: unknown[] }).content).toHaveLength(1)
    expect((repaired.messages[0] as unknown as { content: unknown[] }).content).toHaveLength(0)
  })

  it('reports the dropped variant for an errored turn, which pi-ai skips wholesale', () => {
    const context = contextOf([foreignTurn('half a thought', 'error')])
    expect(foreignThinkingOf(context)[0]).toMatchObject({ variant: 'dropped' })
  })
})

describe('with the repair off the request is exactly what it was before', () => {
  it('returns the same context object, so nothing is reallocated or rewritten', () => {
    const context = contextOf([foreignTurn('notes')])
    // This is the "off" path by construction: the caller only invokes the repair
    // when the switch is on. Pinned as an identity assertion because a future
    // refactor that always copies would make the off-path silently differ.
    expect(foreignThinkingOf(context)).toHaveLength(1)
    const untouched = contextOf([ownTurn(WORKBUDDY_PROVIDER, 'ours')])
    expect(dropForeignThinking(untouched)).toBe(untouched)
  })

  it('a transcript with no foreign turn is returned as the same object', () => {
    const context = contextOf([ownTurn(WORKBUDDY_PROVIDER, 'ours')])
    expect(dropForeignThinking(context)).toBe(context)
  })
})

describe('cross-provider turns are repaired automatically; same-route switches are not', () => {
  it('selects a foreign turn and leaves this bundle\'s own turn alone', () => {
    const context = contextOf([
      foreignTurn('foreign notes'),
      ownTurn(WORKBUDDY_PROVIDER, 'our own plan'),
    ])
    expect(crossProviderThinkingOf(context).map(block => block.messageIndex)).toEqual([0])
  })

  it('does not select a model switch on one of this bundle\'s own routes', () => {
    // The turn WAS produced by this bundle; only the model id differs. That is
    // the #147 model leg, which stays behind the explicit switch.
    const message = ownTurn(WORKBUDDY_MODEL_IDENTITY, 'our own plan')
    message['model'] = 'hy3'
    const context = contextOf([message])
    expect(foreignThinkingOf(context, WORKBUDDY_MODEL_IDENTITY, 'deepseek-v4.1-flash')).toHaveLength(1)
    expect(crossProviderThinkingOf(context)).toHaveLength(0)
  })

  it('does not select an owned global-region turn after alignment', () => {
    // The host stamps this turn `dsh-foreign` because it was recorded under the
    // route id; alignment repairs it, so the automatic repair must not.
    const message = ownTurn(WORKBUDDY_GLOBAL_PROVIDER, 'our own plan')
    message['api'] = HOST_FOREIGN_API
    delete (message['content'] as Array<Record<string, unknown>>)[0]!['thinkingSignature']
    const aligned = alignAssistantIdentities(contextOf([message]))
    expect(crossProviderThinkingOf(aligned)).toHaveLength(0)
  })
})

describe('this plugin\'s own turns keep their thinking (issue #102 must not regress)', () => {
  it('the CN route keeps its reasoning block', () => {
    const context = contextOf([ownTurn(WORKBUDDY_PROVIDER, 'our own plan')])
    expect(dropForeignThinking(context)).toBe(context)
    expect(foreignThinkingOf(context)).toHaveLength(0)
  })

  it('the GLOBAL route keeps its reasoning block — the route-vs-identity case', () => {
    const context = contextOf([ownTurn(WORKBUDDY_GLOBAL_PROVIDER, 'our own plan')])
    expect(foreignThinkingOf(context)).toHaveLength(0)
    expect(dropForeignThinking(context)).toBe(context)
  })

  it('a message already carrying the identity keeps its reasoning block', () => {
    const context = contextOf([ownTurn(WORKBUDDY_MODEL_IDENTITY, 'our own plan')])
    expect(foreignThinkingOf(context)).toHaveLength(0)
  })
})

describe('the repair is narrow: only unsigned foreign thinking goes', () => {
  it('leaves a foreign turn\'s text and tool calls untouched', () => {
    const message = {
      role: 'assistant',
      api: HOST_FOREIGN_API,
      provider: 'deepseek',
      model: 'deepseek-chat',
      content: [
        { type: 'thinking', thinking: 'notes' },
        { type: 'text', text: 'the real answer' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.md' } },
      ],
      usage: { input: 1, output: 1 },
      stopReason: 'toolUse',
      timestamp: 1,
    }
    const repaired = dropForeignThinking(contextOf([message]))
    const content = (repaired.messages[0] as unknown as { content: Array<{ type: string }> }).content
    expect(content.map(block => block.type)).toEqual(['text', 'toolCall'])
  })

  it('ignores a redacted block, which pi-ai never shows as prose', () => {
    const message = foreignTurn('')
    ;(message['content'] as Array<Record<string, unknown>>)[0] = { type: 'thinking', thinking: 'hidden', redacted: true }
    expect(foreignThinkingOf(contextOf([message]))).toHaveLength(0)
  })

  it('ignores an empty thinking block, which pi-ai already drops', () => {
    expect(foreignThinkingOf(contextOf([foreignTurn('')]))).toHaveLength(0)
  })
})

describe('a realistic post-switch transcript', () => {
  it('removes only the foreign reasoning and counts what it removed', () => {
    const context = contextOf([
      { role: 'user', content: 'continue' },
      foreignTurn('A'.repeat(500)),
      ownTurn(WORKBUDDY_GLOBAL_PROVIDER, 'B'.repeat(120)),
      foreignTurn('C'.repeat(60)),
    ])
    const affected = foreignThinkingOf(context)
    expect(affected.map(block => block.messageIndex)).toEqual([1, 3])
    expect(affected.reduce((sum, block) => sum + block.characters, 0)).toBe(560)
  })

  it('runs AFTER alignment, because this plugin\'s own global turn arrives as dsh-foreign', () => {
    // THE ORDER THAT MATTERS, and it is not hypothetical. A global-region turn
    // recorded through this plugin is rebuilt by `dsh-llm-pi-ai` as
    // `foreignAssistant()` (its `replayedAssistant` rejects the route-id
    // provider), so it arrives carrying `api: 'dsh-foreign'` — the very marker a
    // genuinely foreign turn carries. Diagnosing before
    // `alignAssistantIdentities` runs would classify OUR OWN turn as foreign and
    // delete its reasoning: issue #102's regression, from the other direction.
    const asRecorded = ownTurn(WORKBUDDY_GLOBAL_PROVIDER, 'B'.repeat(120))
    asRecorded['api'] = HOST_FOREIGN_API
    // A host-fallback message carries no signature; `foreignAssistant()` builds
    // the block as `{type:'thinking', thinking}` alone.
    delete (asRecorded['content'] as Array<Record<string, unknown>>)[0]?.['thinkingSignature']

    const context = contextOf([
      foreignTurn('A'.repeat(500)),
      asRecorded,
      foreignTurn('C'.repeat(60)),
    ])
    // Before alignment our own turn is indistinguishable from a foreign one —
    // which is precisely why the repair must not run at this point.
    expect(foreignThinkingOf(context).map(block => block.messageIndex)).toEqual([0, 1, 2])

    const aligned = alignAssistantIdentities(context)
    // After alignment only the two genuinely foreign turns are left.
    expect(foreignThinkingOf(aligned).map(block => block.messageIndex)).toEqual([0, 2])

    const repaired = dropForeignThinking(aligned)
    // Our own turn still replays as thinking; the foreign ones contribute no prose.
    expect(typesAfterTransform(repaired)).toEqual([[], ['thinking', 'text'], []])
    expect(proseAfterTransform(repaired)).toBe('the answer')
  })

  it('is idempotent', () => {
    const once = dropForeignThinking(contextOf([foreignTurn('notes')]))
    expect(dropForeignThinking(once)).toBe(once)
  })
})
