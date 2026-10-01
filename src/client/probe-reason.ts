/**
 * The part of an upstream failure message worth showing INLINE.
 *
 * Both the pool table and the model table used to append the recorded body
 * verbatim. For a rate limit that body is
 * `{"code":6004,"msg":"…将在 2026-10-02 06:53:43 重置…","requestId":"…"}` — the
 * same instant the row already prints, wrapped in an envelope whose remaining
 * fields mean nothing to the reader. The result was a wall of JSON where the
 * row's actual point should have been.
 *
 * So the rule is stated once here:
 *
 *   - an outcome whose own label plus stated recovery time already say
 *     everything gets NO inline reason (its body only repeats them);
 *   - every other outcome gets a SHORT reason — the human sentence lifted out of
 *     a JSON envelope, or the transport error with its redundant prefix removed;
 *   - the full text stays on the element as a `title`, so shortening never means
 *     losing it.
 *
 * @module dsh-connect-workbuddy/client/probe-reason
 */

import type { WorkBuddyWebProbeOutcome } from '../status-paths.ts'

/**
 * Outcomes whose label + stated recovery time ARE the whole story.
 *
 * Both carry a reset instant, which the row prints right beside them; their
 * bodies restate that instant and add a `code`/`requestId` pair nobody reads.
 *
 * `credential-rejected` and `not-found` are deliberately NOT here: their labels
 * state a conclusion ("sign in again", "no such model"), and the upstream's own
 * words are what make that conclusion checkable rather than asserted.
 */
const SELF_EXPLANATORY: ReadonlySet<WorkBuddyWebProbeOutcome> = new Set([
  'rate-limited',
  'out-of-credit',
])

/**
 * Longest inline reason kept.
 *
 * A cap rather than a wrapper: one pathological body must not push the rest of
 * the table off screen. 72 characters holds a full transport error and a full
 * upstream sentence, while stopping well short of a raw JSON document.
 */
const REASON_LIMIT = 72

/** The inline reason for one measurement, or `undefined` when it adds nothing. */
export function inlineProbeReason(
  outcome: WorkBuddyWebProbeOutcome,
  message: string | undefined,
): string | undefined {
  if (message === undefined || message === '') return undefined
  if (SELF_EXPLANATORY.has(outcome)) return undefined
  const text = (humanSentenceOf(message) ?? stripTransportPrefix(message)).trim()
  return text === '' ? undefined : truncate(text)
}

function truncate(text: string): string {
  return text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`
}

/** `{"code":6004,"msg":"…","requestId":"…"}` → the `msg` sentence, if it has one. */
function humanSentenceOf(message: string): string | undefined {
  if (!message.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    // A truncated or non-JSON body is not worth reporting as an error: the
    // caller falls back to the raw text, which still beats showing nothing.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const msg = (parsed as Record<string, unknown>)['msg']
  return typeof msg === 'string' && msg !== '' ? msg : undefined
}

/** `transport error: TimeoutError: …` → `TimeoutError: …`. */
function stripTransportPrefix(message: string): string {
  return message.replace(/^transport error:\s*/u, '')
}
