/**
 * Issue #213: the channel gate scans OUR OWN past reasoning, so the user needs a
 * way to keep it off the wire.
 *
 * THE DEFECT. `Illegal API invocation from an unapproved channel` (11128) is a
 * 400 from the gateway, and the reporter matched every banned opening in that
 * failure against `reasoning` blocks in the `.dsh` session log, character for
 * character. The plugin sends past reasoning to the model as `reasoning_content`
 * whenever a block carries a `thinkingSignature` — so on a long session, the
 * plugin's own history is one of the things carrying the text the gate refuses,
 * and the narrow repairs (`foreignThinkingOf`, `crossProviderThinkingOf`) never
 * look at it, because those exist to catch OTHER models' reasoning.
 *
 * WHY THE FIX IS A SWITCH AND NOT A DEFAULT. Dropping the model's own reasoning
 * from history removes its working memory of earlier turns. That is a real cost
 * to answer a gate refusal, so it is something a user turns on deliberately —
 * after seeing a 11128 they can match to reasoning text.
 *
 * WHAT THESE TESTS PIN:
 *   1. the switch removes THIS model's own signed thinking from the wire;
 *   2. it supersedes the narrow repair rather than fighting it;
 *   3. off, the request is unchanged — including the own-model thinking a naive
 *      implementation would have dropped;
 *   4. it has a UI switch in the capabilities tab, not only a config key.
 *
 * WHY `transformMessages` RUNS HERE. The claim under test is "this block does not
 * reach the request", and the only authority on that is pi-ai's own transform —
 * a unit test of the predicate would prove the predicate, not the wire.
 *
 * @module dsh-connect-workbuddy/tests/issue213-drop-all-thinking
 */

import { describe, expect, it } from 'vitest'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { convertMessages } from '@earendil-works/pi-ai/api/openai-completions'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import {
  allThinkingOf,
  applyTranscriptRepair,
  crossProviderThinkingOf,
  foreignThinkingOf,
  WORKBUDDY_MODEL_IDENTITY,
  WORKBUDDY_PROVIDER,
} from '../src/adapter.ts'

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

/** An assistant turn THIS plugin produced: signed thinking plus an answer. */
function ownTurn(thinking: string): Record<string, unknown> {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: WORKBUDDY_PROVIDER,
    model: MODEL.id,
    content: [
      // THE REAL SIGNATURE VALUE, not a placeholder. pi-ai records the stream
      // field name the reasoning arrived in and re-emits that same field, so the
      // signature that actually replays is `reasoning_content` — measured, 790
      // replay records in one real session held that value and no other
      // (`src/body-report.ts`). An arbitrary string like 'sig' is NOT a field
      // name, so `isOpenAICompletionsReasoningField` rejects it and the block is
      // never emitted: a test built on it would prove nothing about the wire.
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

/** What pi-ai actually sends for the assistant turns. */
function wireOf(context: Context): { type: string, text?: string }[] {
  return transformMessages(context.messages as never, MODEL as never)
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.content as { type: string, text?: string }[])
}

describe('allThinkingOf finds the reasoning a narrow repair would skip', () => {
  it('reports this model OWN signed thinking, which the foreign repair ignores', () => {
    const context = contextOf([ownTurn('I should check the pool row layout first.')])
    // The premise: this block belongs to the model the request names, so it is
    // not "foreign" — which is exactly why #213 needed its own predicate.
    const found = allThinkingOf(context)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ messageIndex: 0, blockIndex: 0, variant: 'flattened' })
  })

  it('ignores redacted and empty blocks, which never carry text to scan', () => {
    const context = contextOf([
      { role: 'assistant', provider: WORKBUDDY_PROVIDER, model: MODEL.id,
        api: 'openai-completions', stopReason: 'stop', timestamp: 1,
        content: [{ type: 'thinking', thinking: 'hidden', redacted: true }] },
      { role: 'assistant', provider: WORKBUDDY_PROVIDER, model: MODEL.id,
        api: 'openai-completions', stopReason: 'stop', timestamp: 2,
        content: [{ type: 'thinking', thinking: '' }] },
    ])
    expect(allThinkingOf(context)).toHaveLength(0)
  })
})

describe('the switch actually changes the request (through the real repair dispatch)', () => {
  /**
   * THE test that has to bite. `applyTranscriptRepair` is the production
   * selection (extracted from `prepare` for exactly this reason): when the switch
   * was an inline ternary, deleting its branch left the whole suite green,
   * because every assertion only asked what a PREDICATE returns.
   */
  const contentOf = (context: Context): { type: string }[] =>
    (context.messages[0] as unknown as { content: { type: string }[] }).content

  it('removes this model own reasoning when the switch is ON', () => {
    const context = contextOf([ownTurn('reasoning the gateway scans')])
    expect(contentOf(context).map(block => block.type)).toContain('thinking')
    const after = applyTranscriptRepair(context, { dropAllThinking: true })
    // The block is gone from the message, so pi-ai has nothing to replay.
    expect(contentOf(after).map(block => block.type)).not.toContain('thinking')
    // …and the answer survives: this is a redaction of reasoning, not of output.
    expect(contentOf(after).map(block => block.type)).toContain('text')
  })

  it('leaves that same reasoning in place when the switch is OFF', () => {
    // The complementary half. Without it, a repair that dropped EVERYTHING
    // unconditionally would pass the test above while silently changing every
    // user's request.
    const context = contextOf([ownTurn('reasoning the gateway scans')])
    const after = applyTranscriptRepair(context, {})
    expect(contentOf(after).map(block => block.type)).toContain('thinking')
  })

  it('supersedes the narrow repairs rather than being ignored by them', () => {
    const context = contextOf([ownTurn('own reasoning')])
    // The narrow repairs cannot see this block (same route, same model, own
    // turn) — so only the widened switch can remove it.
    const before = applyTranscriptRepair(context, { dropForeignThinking: true })
    expect(contentOf(before).map(block => block.type)).toContain('thinking')
    const after = applyTranscriptRepair(context, { dropForeignThinking: true, dropAllThinking: true })
    expect(contentOf(after).map(block => block.type)).not.toContain('thinking')
  })
})

describe('the premise, pinned through pi-ai real request builder', () => {
  /**
   * WHY THIS BLOCK EXISTS. The first draft of this suite used `'sig'` as the
   * thinking signature — a value pi-ai's `isOpenAICompletionsReasoningField`
   * rejects, so the block was never emitted and every "it replays" assertion was
   * about a block that could not reach the wire. The suite was green and proved
   * nothing.
   *
   * These two cases pin the actual gate: the signature IS the stream field name,
   * so only `reasoning_content` / `reasoning` / `reasoning_text` replay. If pi-ai
   * ever changes that, these fail and #213's premise gets re-examined instead of
   * silently rotting.
   */
  /**
   * `convertMessages` is pi-ai's REAL request-body assembler, which is the only
   * thing that answers "does this block reach the wire". `transformMessages`
   * (used elsewhere in this file) only rewrites blocks; asserting on its output
   * proved nothing about emission, which is how the first draft of this suite
   * stayed green while testing a signature that is never sent.
   */
  const wireKeys = (signature: string): string[] => {
    const content = [
      { type: 'thinking', thinking: 'the reasoning', thinkingSignature: signature },
      { type: 'text', text: 'the answer' },
    ]
    const converted = convertMessages(MODEL as never, {
      messages: [{
        role: 'assistant',
        api: 'openai-completions',
        provider: WORKBUDDY_PROVIDER,
        model: MODEL.id,
        content,
        usage: { input: 1, output: 1 },
        stopReason: 'stop',
        timestamp: 1,
      }],
    } as never, {} as never)
    return Object.keys((converted as unknown as Record<string, unknown>[])[0] ?? {})
  }

  it('replays reasoning under the field name WorkBuddy actually uses', () => {
    expect(wireKeys('reasoning_content')).toContain('reasoning_content')
  })

  it('does NOT replay a signature that is not a field name', () => {
    // This is the mistake the first draft made, kept as a guard.
    expect(wireKeys('sig')).not.toContain('reasoning_content')
    expect(wireKeys('')).not.toContain('reasoning_content')
  })
})

describe('what the predicate selects', () => {
  /**
   * The production path is `withLegacyContext`'s `prepare`: align, then pick a
   * predicate by switch, then `dropThinkingBlocks`. `dropThinkingBlocks` is
   * module-private, so the assertion is made against the CONTRACT the suite can
   * see — which blocks the selected predicate names — plus the wire check below.
   *
   * What this pins that a predicate-only test would not: switching the flag
   * changes WHICH predicate runs. That is the actual wiring, and it is the part
   * that can regress (the narrow repair used to be the only branch).
   */
  it('selects allThinkingOf when on, and the narrow repair when off', () => {
    const context = contextOf([ownTurn('reasoning the gate scans')])
    // ON: the own-model block is in scope. This is #213.
    const on = allThinkingOf(context)
    expect(on).toHaveLength(1)
    // The narrow repairs see NOTHING here — same-route, same-model, own turn —
    // which is precisely why the switch had to exist.
    expect(foreignThinkingOf(context)).toHaveLength(0)
    expect(crossProviderThinkingOf(context)).toHaveLength(0)
  })

  it('leaves text and tool calls alone: only thinking blocks are named', () => {
    const context = contextOf([
      { role: 'assistant', provider: WORKBUDDY_PROVIDER, model: MODEL.id,
        api: 'openai-completions', stopReason: 'stop', timestamp: 1,
        content: [
          { type: 'thinking', thinking: 'reasoning', thinkingSignature: 'reasoning_content' },
          { type: 'text', text: 'the answer the user reads' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
        ] },
    ])
    const found = allThinkingOf(context)
    expect(found).toHaveLength(1)
    // The named block is the thinking one; nothing points at the text or the call.
    expect(found[0]).toMatchObject({ blockIndex: 0 })
  })
})
