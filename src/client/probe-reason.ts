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
 * `rate-limited` carries a reset instant, which the row prints right beside it;
 * its body restates that instant and adds a `code`/`requestId` pair nobody
 * reads.
 *
 * `out-of-credit` is here for a DIFFERENT reason than it once was. It no longer
 * prints an instant at all — the row states what replenishes the balance
 * (check-in / top-up) instead — and the recorded body's `msg` for the `14018`
 * family is the same quota envelope, which adds no evidence the label did not
 * already use. Printing it would bury the one actionable sentence under JSON.
 *
 * `model-busy` belongs here for the opposite reason: its label states the whole
 * finding INCLUDING the remedy ("this model is loaded right now · not your
 * account — wait about a minute or switch models"). The recorded body is the
 * upstream's `14003` envelope, and appending it in a 72-character cell would
 * bury the remedy under the JSON the label was written to translate.
 *
 * `credential-rejected` and `not-found` are deliberately NOT here: their labels
 * state a conclusion ("sign in again", "no such model"), and the upstream's own
 * words are what make that conclusion checkable rather than asserted.
 */
const SELF_EXPLANATORY: ReadonlySet<WorkBuddyWebProbeOutcome> = new Set([
  'rate-limited',
  'model-busy',
  'out-of-credit',
  // `account-restricted` belongs here for the same reason `model-busy` does, and
  // its contradiction is sharper: the label says the ACCOUNT is restricted, while
  // the recorded body's `msg` for the whole `11140` family is
  // `request illegal` — "the REQUEST was illegal". Printing both in one 72px cell
  // asserts two opposite conclusions about two different subjects. The label
  // already carries the remedy (appeal upstream, then re-test), so the JSON
  // sentence adds no evidence the label did not use. (issue #127 review)
  'account-restricted',
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
