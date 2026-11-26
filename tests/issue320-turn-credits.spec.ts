/**
 * ISSUE #320 — show what each turn cost, not only the account's balance.
 *
 * The upstream's stream carries a `credit` figure; the probe path already read
 * it (`creditOfStream`), but the chat path never did, so a user could see their
 * balance move without being able to tell which turn moved it. The balance also
 * moves for reasons this card cannot attribute — another device, a check-in —
 * which is exactly why a per-turn figure is worth reporting separately.
 *
 * The two rules these tests exist for:
 *   - a turn the upstream did not price is COUNTED, never averaged in silently
 *     (a total that skipped them would look exact and be wrong);
 *   - a Host that predates the field renders nothing, because "no data" and
 *     "cost nothing" must not look the same.
 *
 * @module dsh-connect-workbuddy/tests/issue320-turn-credits
 */
import { describe, expect, it } from 'vitest'
import { usageOfChunk } from '../src/body-report.ts'

describe('issue #320: the credit figure is read from the stream', () => {
  it('reads credit from the usage block', () => {
    const usage = usageOfChunk({ usage: { prompt_tokens: 10, completion_tokens: 2, credit: 0.72 } })
    expect(usage?.credit).toBe(0.72)
  })

  it('reads credit from the chunk top level, the other spelling the probe regex allows', () => {
    // `creditOfStream` matches `"credit"` anywhere in the stream and therefore
    // cannot say where it sat; both placements must be accepted or the figure
    // disappears on whichever shape puts it outside `usage`.
    const usage = usageOfChunk({ credit: 1.5, usage: { prompt_tokens: 3 } })
    expect(usage?.credit).toBe(1.5)
  })

  it('prefers the usage block when both are present', () => {
    expect(usageOfChunk({ credit: 9, usage: { credit: 1 } })?.credit).toBe(1)
  })

  it('refuses a negative or non-finite figure rather than reporting it as cost', () => {
    // A negative credit is a refund or a parse artifact; either way calling it
    // "what this turn cost" would be a lie.
    expect(usageOfChunk({ usage: { credit: -1, prompt_tokens: 1 } })?.credit).toBeUndefined()
    expect(usageOfChunk({ usage: { credit: Number.POSITIVE_INFINITY } })).toBeUndefined()
    expect(usageOfChunk({ usage: { credit: '0.5' } })).toBeUndefined()
  })

  it('still reports token counts when there is no credit', () => {
    const usage = usageOfChunk({ usage: { prompt_tokens: 7, completion_tokens: 1 } })
    expect(usage?.promptTokens).toBe(7)
    expect(usage?.credit).toBeUndefined()
  })
})
