/**
 * Issue #258: a long session died with a stable HTTP 422 because the request
 * body crossed a BYTE ceiling enforced by another component, and nothing folded
 * the history.
 *
 * The reporter's diagnosis was correct on both halves, and both are pinned here
 * separately because they fail independently:
 *
 *   1. THE TRIGGER. `isContextOverflow` from pi-ai recognises TOKEN overflow
 *      only. A body-size refusal matched no pattern, so the rescue never ran and
 *      every retry re-sent the identical oversized body.
 *
 *   2. THE TARGET. Even calling the rescue would have folded NOTHING. The fold
 *      target was `window * 0.6` — with a 1,000,000-token declared window that
 *      is 600,000 tokens — while the byte ceiling was measured as crossed around
 *      150,000 tokens. So `totalTokens (150k) <= target (600k)` held on the very
 *      first measurement and the loop returned having done nothing. A rescue
 *      that reports success while shrinking nothing is worse than one that
 *      reports failure, which is why the second half has its own test rather
 *      than riding on the first.
 *
 * The measured numbers below are the reporter's, from a real 8,388,608-byte
 * (8 MiB) ceiling: 6,954,570 B → 7,936,254 B → 8,401,132 B refused.
 */

import { describe, expect, it } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createContextRescue, rescueTargetOf } from '../src/context-rescue.ts'
import { rescueCauseOf } from '../src/adapter.ts'
import type { ContextRescueDeps, RescueMeasurement } from '../src/context-rescue.ts'
import { isBodyOversizeRefusal } from '../src/upstream.ts'

/** Tokens a folded chunk costs once the host replaces it with its summary. */
const SUMMARY_TOKENS = 20

interface FakeNode {
  seq: number
  tokens: number
}

/** The fake host from `context-rescue.spec.ts`, kept in step with it by behaviour. */
class FakeHost {
  readonly sessionId: string
  nodes: FakeNode[]
  readonly calls: { start: number; end: number; coveredTokens: number }[] = []

  constructor(sessionId: string, nodes: FakeNode[]) {
    this.sessionId = sessionId
    this.nodes = nodes
  }

  private measure(): RescueMeasurement {
    return {
      totalTokens: this.nodes.reduce((total, node) => total + node.tokens, 0),
      nodes: this.nodes.map(node => ({ seq: node.seq, tokens: node.tokens })),
    }
  }

  deps(): ContextRescueDeps {
    return {
      meter: { measure: () => this.measure() },
      agents: { get: id => id === this.sessionId ? { session: { id } } : undefined },
      compaction: {
        compactRegion: async (start, end) => {
          const covered = this.nodes.findIndex(node => node.seq === end)
          if (covered < 0) throw new Error(`missing range ${start}..${end}`)
          this.calls.push({
            start,
            end,
            coveredTokens: this.nodes.slice(0, covered + 1).reduce((total, node) => total + node.tokens, 0),
          })
          this.nodes.splice(0, covered + 1, { seq: -1, tokens: SUMMARY_TOKENS })
          return { kind: 'folded' }
        },
      },
      log: () => {},
    }
  }

  total(): number {
    return this.nodes.reduce((total, node) => total + node.tokens, 0)
  }
}

/**
 * A long session: 1,500 nodes of 100 tokens = 150,000 tokens. That is the
 * reporter's crossing point — far below the 600k a 1M window would target, which
 * is exactly the trap.
 */
function longSession(): FakeHost {
  return new FakeHost('session-long', Array.from({ length: 1_500 }, (_, index) => ({
    seq: index + 1,
    tokens: 100,
  })))
}

describe('issue #258 — recognising a body-size refusal', () => {
  it('recognises the measured refusals, whatever component produced them', () => {
    // The byte-comparison shape is the strongest evidence and the one every
    // real refusal carried.
    expect(isBodyOversizeRefusal('local request refused: 8,401,132 B > 8,388,608 B')).toBe(true)
    expect(isBodyOversizeRefusal('unattributed oversized model request refused locally with a 422')).toBe(true)
    expect(isBodyOversizeRefusal('request-body limit exceeded')).toBe(true)
    expect(isBodyOversizeRefusal('BODY exceeded the local byte limit')).toBe(true)
  })

  it('is matched by MEANING, not by any component name', () => {
    // The whole point of the general reader: a different component with
    // different wording, saying the same thing, is covered; and this build
    // carries no dependency on any particular one.
    expect(isBodyOversizeRefusal('proxy says: payload too big, 9,000,000 B > 8,000,000 B')).toBe(true)
    expect(isBodyOversizeRefusal('oversize request rejected by the local gateway (byte limit)')).toBe(true)
  })

  it('does NOT claim TOKEN overflow, which the host already recovers from', () => {
    // Treating these here would make two authorities compete over one failure.
    expect(isBodyOversizeRefusal('prompt is too long (upstream code 11115)')).toBe(false)
    expect(isBodyOversizeRefusal('context length exceeded: 200000 tokens')).toBe(false)
    expect(isBodyOversizeRefusal('too many tokens')).toBe(false)
    expect(isBodyOversizeRefusal('the request parameters were rejected by the model provider')).toBe(false)
    expect(isBodyOversizeRefusal('')).toBe(false)
  })

  it('does not fold history for an "oversized" that is not about the body', () => {
    // An upstream saying an IMAGE is oversized is not a history problem and
    // folding would delete the user's conversation for nothing.
    expect(isBodyOversizeRefusal('oversized image attachment rejected')).toBe(false)
  })
})

describe('issue #258 — the fold target must not be trivially satisfied', () => {
  it('derives the body-size target from the MEASUREMENT, not the window', () => {
    // This is the defect in one assertion: with the reporter's numbers, a
    // window-derived target sits ABOVE the measurement, so nothing folds.
    const measured = 150_000
    const window = 1_000_000
    expect(rescueTargetOf('window', window, measured)).toBe(600_000) // above 150k → no fold
    expect(rescueTargetOf('window', window, measured)).toBeGreaterThan(measured)
    expect(rescueTargetOf('body-bytes', window, measured)).toBe(135_000) // below → folds
    expect(rescueTargetOf('body-bytes', window, measured)).toBeLessThan(measured)
  })

  it('keeps the target strictly below the measurement at every scale that can fold', () => {
    // The property, not one number: whatever the session size, a body-size
    // rescue must always have something to do on its first pass.
    //
    // Sessions of 10 tokens or fewer are excluded BY ARITHMETIC, not by
    // convenience: `floor(n * 0.9)` is `n - 1` only from 10 upward, and below
    // that the `max(1, …)` floor is what the next test pins.
    for (const measured of [10, 100, 150_000, 900_000, 10_000_000]) {
      expect(rescueTargetOf('body-bytes', 1_000_000, measured)).toBeLessThan(measured)
    }
  })

  it('never derives a target of zero, which would ask for an empty history', () => {
    expect(rescueTargetOf('body-bytes', 1_000_000, 0)).toBeGreaterThanOrEqual(1)
    expect(rescueTargetOf('body-bytes', 1_000_000, 5)).toBeGreaterThanOrEqual(1)
  })
})

describe('issue #258 — the rescue actually folds for a body-size refusal', () => {
  it('folds a long session that the WINDOW target would have left untouched', async () => {
    // The regression, end to end: 150k tokens against a 1M window.
    const host = longSession()
    const rescue = createContextRescue(() => host.deps())

    // The old behaviour, reproduced: the window target is already satisfied.
    expect(await rescue.rescue(host.sessionId, 1_000_000, 'window')).toBe(false)
    expect(host.calls).toHaveLength(0)
    expect(host.total()).toBe(150_000)

    // The new behaviour: at least one fold happens.
    const folded = await rescue.rescue(host.sessionId, 1_000_000, 'body-bytes')
    expect(folded).toBe(true)
    expect(host.calls.length).toBeGreaterThan(0)
    expect(host.total()).toBeLessThan(150_000)
  })

  it('shrinks by roughly 10% per round, not to a fixed fraction of the window', async () => {
    const host = longSession()
    const rescue = createContextRescue(() => host.deps())
    await rescue.rescue(host.sessionId, 1_000_000, 'body-bytes')

    // Each round targets 90% of what is there, so one round removes at least
    // 10% — the loop must not stop after a single token of progress, and it
    // must not fold the whole history for a body that overshot by a few percent.
    expect(host.total()).toBeLessThan(150_000 * 0.95)
    expect(host.total()).toBeGreaterThan(0)
    // Bounded by MAX_ROUNDS: 8 rounds of 10% leaves well over half the history.
    expect(host.total()).toBeGreaterThan(150_000 * 0.4)
  })

  it('leaves the ORIGINAL token-overflow path byte-identical', async () => {
    // Issue #59's behaviour must not move: same window target, same folds.
    const saturated = new FakeHost('session-a', Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      tokens: 100,
    })))
    const rescue = createContextRescue(() => saturated.deps())
    expect(await rescue.rescue(saturated.sessionId, 1_000)).toBe(true)
    expect(saturated.total()).toBeLessThanOrEqual(600 + SUMMARY_TOKENS)
    expect(saturated.total()).toBeLessThan(2_000)
  })

  it('defaults to the window cause when none is given', async () => {
    // Existing callers pass two arguments; that must keep meaning "window".
    const host = longSession()
    const rescue = createContextRescue(() => host.deps())
    expect(await rescue.rescue(host.sessionId, 1_000_000)).toBe(false)
  })
})

/**
 * The TRIGGER half, tested separately from the target half.
 *
 * These two fail independently, which is why issue #258 needed two fixes: a
 * correct target that is never reached folds nothing, and a correct trigger
 * feeding the old window target folds nothing either. Measured mutation: with
 * only the trigger restored and the target left on the window, the session was
 * still stuck.
 */
describe('issue #258 — the adapter must ASK for the rescue', () => {
  /** A minimal assistant message carrying one error string. */
  const message = (errorMessage: string): AssistantMessage => ({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage,
  }) as unknown as AssistantMessage

  it('recognises a body-size refusal as its own cause', () => {
    expect(rescueCauseOf(message('refused locally: 8,401,132 B > 8,388,608 B'))).toBe('body-bytes')
    expect(rescueCauseOf(message('the body exceeds the local request-body limit'))).toBe('body-bytes')
  })

  it('keeps the token overflow on the window cause', () => {
    expect(rescueCauseOf(message('prompt is too long'))).toBe('window')
  })

  it('asks for nothing when the failure is unrelated', () => {
    expect(rescueCauseOf(message('the request parameters were rejected by the model provider'))).toBeUndefined()
    expect(rescueCauseOf(message(''))).toBeUndefined()
  })

  it('finds the text in the other shapes a provider may use', () => {
    // `errorMessage` is the normal carrier, but a provider that fills only
    // `content` must not silently skip the rescue.
    const viaContent = {
      role: 'assistant',
      content: [{ type: 'text', text: 'refused locally: 8,401,132 B > 8,388,608 B' }],
      stopReason: 'error',
    } as unknown as AssistantMessage
    expect(rescueCauseOf(viaContent)).toBe('body-bytes')

    const viaString = {
      role: 'assistant',
      content: 'refused locally: 8,401,132 B > 8,388,608 B',
      stopReason: 'error',
    } as unknown as AssistantMessage
    expect(rescueCauseOf(viaString)).toBe('body-bytes')
  })
})

/**
 * The target is derived ONCE, from the first measurement.
 *
 * What the fix needs is only that the first target sits BELOW the first
 * measurement — that is what turns the old "already fits, do nothing" into a
 * real fold. Whether it is then re-derived each round is not observable in any
 * way that matters, so the code does not carry that complexity (see the comment
 * at the derivation site).
 */
describe('issue #258 — one fold is guaranteed, and the loop still terminates', () => {
  it('performs at least one fold for a session the window target leaves alone', async () => {
    const host = longSession()
    const rescue = createContextRescue(() => host.deps())
    await rescue.rescue(host.sessionId, 1_000_000, 'body-bytes')
    expect(host.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('bounded by MAX_ROUNDS: a fold that shrinks nothing does not loop forever', async () => {
    // The host accepts folds that replace a span with an equally expensive
    // summary. The `totalTokens >= previous` guard is what stops that, and this
    // pins it for the body-size cause too (it was only covered for the window
    // cause before).
    const flat = new FakeHost('session-flat', Array.from({ length: 100 }, (_, index) => ({
      seq: index + 1,
      tokens: 100,
    })))
    // Every fold "succeeds" but leaves the surface exactly as it was.
    let attempts = 0
    const deps = flat.deps()
    const rescue = createContextRescue(() => ({
      ...deps,
      compaction: {
        compactRegion: async () => {
          attempts += 1
          return { kind: 'no-op' }
        },
      },
    }))
    const folded = await rescue.rescue(flat.sessionId, 1_000_000, 'body-bytes')
    // The FIRST fold does run (the target was below the measurement), and the
    // `totalTokens >= previous` guard stops the loop as soon as it observes no
    // progress. One attempt, not MAX_ROUNDS of them — that is the property: a
    // no-op summarizer cannot burn the whole round budget.
    expect(attempts).toBe(1)
    expect(folded).toBe(true)
  })
})
