/**
 * HOW THE INSTALLED pi-ai DISPOSES OF A THINKING BLOCK THAT BELONGS TO ANOTHER
 * MODEL — measured from the library, never inferred from its version.
 *
 * Two dispositions have shipped inside this plugin's declared peer range, and
 * they are opposite outcomes for the same input:
 *
 * - `flattened` (0.85 → 1.2). `transform-messages.js` rewrote the block into
 *   `{ type: 'text', text: block.thinking }`: another model's private working
 *   notes became part of the visible reply. That is the defect issues #147 and
 *   #163 were filed for, and the entire reason this plugin repairs the
 *   transcript before pi-ai sees it.
 * - `dropped` (1.3+). The block is returned as `[]`, with the library's own
 *   comment saying why ("Signatures and encrypted reasoning are only valid for
 *   the model that produced them, and sending readable thinking as plain text
 *   makes the new model treat it as part of the visible reply"). The reasoning
 *   never reaches the request.
 *
 * WHY THIS MATTERS TO A TEST THAT IS ABOUT THE PLUGIN. Several specs here are
 * PREMISE tests: they assert, through the real transform, that the defect being
 * repaired actually exists on the installed library. Those assertions were
 * written against `flattened` and are simply false on 1.3+, where the library
 * already does what the repair does. Left alone they fail on the stack real
 * users run — `dsh-llm-pi-ai@0.2.2-rc.2` ships `@earendil-works/pi-ai ^1.3.0`
 * — while the plugin's behaviour is correct in both cases.
 *
 * The repair itself stays unconditional and is NOT weakened by this: pi-ai
 * resolves per process and a nested copy shadows the host's (issue #24), so
 * "the installed library already handles it" is not a fact this bundle can
 * rely on for a given user. The repair is an invariant the plugin guarantees;
 * this file only describes what the library does beside it.
 *
 * MEASURED, NOT VERSION-MATCHED. The probe drives the real transform once and
 * reads back what happened. Comparing version numbers would be a second copy of
 * a rule that lives in the library, and it would be wrong the first time 1.x
 * changes its mind without changing its major — which is exactly the change
 * that produced this file.
 *
 * @module dsh-connect-workbuddy/tests/foreign-thinking-helpers
 */

import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'

/** What the installed pi-ai does with a thinking block it attributes to another model. */
export type ForeignThinkingDisposition = 'flattened' | 'dropped'

/** A string no other fixture contains, so the probe cannot match by accident. */
const PROBE_THINKING = 'probe-foreign-reasoning-do-not-assert-on-this'

/**
 * One entry per block type the installed transform PUBLISHES for a foreign
 * thinking block: `['text']` when it is flattened into prose, `[]` when it is
 * discarded. Spread it into the expected block-type list.
 */
export function foreignThinkingAsProse(): string[] {
  return foreignThinkingDisposition() === 'flattened' ? ['text'] : []
}

/** The disposition itself, for tests that need to say which line they are on. */
export function foreignThinkingDisposition(): ForeignThinkingDisposition {
  cached ??= probe()
  return cached
}

let cached: ForeignThinkingDisposition | undefined

/**
 * Drive the real `transformMessages` with one foreign turn and see whether the
 * reasoning text comes back out as visible prose.
 */
function probe(): ForeignThinkingDisposition {
  const turn = {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'workbuddy-global',
    model: 'hy3',
    content: [
      { type: 'thinking', thinking: PROBE_THINKING },
      { type: 'text', text: 'the answer' },
    ],
    usage: { input: 1, output: 1 },
    stopReason: 'stop',
    timestamp: 0,
  }
  const request = { id: 'hy3', api: 'openai-completions', provider: 'workbuddy', input: ['text'] }
  const transformed = transformMessages([turn] as never, request as never) as unknown as {
    content: { type: string, text?: string }[]
  }[]
  const published = transformed
    .flatMap(message => message.content)
    .some(block => block.type === 'text' && block.text === PROBE_THINKING)
  return published ? 'flattened' : 'dropped'
}
