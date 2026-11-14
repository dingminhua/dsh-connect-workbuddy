/**
 * Context-overflow rescue.
 *
 * #59's deadlock, stated as the harness sees it: once a session's history is
 * larger than the window of the model it is routed to, the host's own overflow
 * recovery cannot break the cycle. It selects the entire compactable range and
 * replays that range inside a summarization request **on the same small-window
 * route**, so the rescue request overflows exactly like the request it is trying
 * to rescue (harness discussion #9814, point B). The session then fails every
 * subsequent attempt identically.
 *
 * This plugin sits on the only seam that observes that overflow while it still
 * holds the session id, so it can fold history in chunks that each fit. It does
 * not implement summarization itself: it calls the host's own compaction service,
 * driving the same `compaction/start` … `compaction/end` transaction the host
 * would run — with a range chosen to fit instead of "everything".
 *
 * Two invariants keep this from becoming a second, competing compaction policy:
 *
 * - It only runs on a provider-confirmed overflow, never on a size estimate, so
 *   a session the host can still recover on its own is never touched.
 * - It stops as soon as one more fold is unnecessary, leaving the remainder to
 *   the host's own recovery, which now has a range it can actually summarize.
 *
 * The host services are reached through the duck-typed views below rather than
 * imported types: `dsh-compaction`, `dsh-session` and `dsh-token-meter` are not
 * peer dependencies of this plugin, and the rescue must be inert on a host that
 * does not have them loaded.
 */

/** One token-priced surface node, as `tokenMeter.measure()` reports it. */
export interface RescueSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: number
  /** Request-pressure tokens for this node's projected message. */
  readonly tokens: number
}

/** The slice of `TokenMeasurement` the rescue reads. */
export interface RescueMeasurement {
  readonly totalTokens: number
  readonly nodes: readonly RescueSurfaceNode[]
}

/** The slice of `Session` the rescue reads. */
export interface RescueSession {
  readonly id?: unknown
}

/** The slice of `Agent` the rescue hands back to the compaction service. */
export interface RescueAgent {
  readonly session: RescueSession
}

/** The slice of the `tokenMeter` service the rescue reads. */
export interface RescueTokenMeter {
  measure(session: RescueSession): RescueMeasurement
}

/** The slice of the `compaction` service the rescue drives. */
export interface RescueCompaction {
  compactRegion(
    start: number,
    end: number,
    agent: RescueAgent,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** The slice of the `agents` registry the rescue reads. */
export interface RescueAgents {
  get(id: string): RescueAgent | undefined
}

/** Host services, resolved per attempt because any of them may be absent. */
export interface ContextRescueDeps {
  readonly meter: RescueTokenMeter | undefined
  readonly compaction: RescueCompaction | undefined
  readonly agents: RescueAgents | undefined
  readonly log?: (message: string, error?: unknown) => void
}

export interface ContextRescue {
  /**
   * Fold history until the next request fits the given window.
   *
   * @param sessionId - session whose history should be folded.
   * @param window - context window of the route that just overflowed.
   * @param cause - what refused the request (issue #258).
   *
   *   `'window'` (the default) is the token overflow this rescue was written
   *   for: the target is a fraction of the model's declared window.
   *
   *   `'body-bytes'` is a request refused because its SERIALIZED BODY exceeded
   *   a byte ceiling some component enforces. The target is then a fraction of
   *   the CURRENT measurement, never of the window — see
   *   {@link BODY_OVERSIZE_TARGET_FRACTION} for why the window target would
   *   silently fold nothing.
   *
   * @returns whether any history was folded.
   */
  rescue(sessionId: string, window: number, cause?: RescueCause): Promise<boolean>
}

/**
 * What refused the request.
 *
 * Only two values, and the distinction is not cosmetic: it decides which number
 * the fold target is derived from, and getting it wrong makes the rescue a
 * no-op rather than a wrong-but-visible action (see the fraction constant).
 */
export type RescueCause = 'window' | 'body-bytes'

/** Share of the window one fold chunk may consume, leaving room for the prompt. */
const CHUNK_FRACTION = 0.35

/** Post-fold measurement target: comfortably below the window the route allows. */
const TARGET_FRACTION = 0.6

/**
 * Post-fold target for a BYTE refusal, as a fraction of the CURRENT measurement
 * (issue #258).
 *
 * WHY NOT THE WINDOW. The ceiling that refuses these requests is in BYTES; the
 * measurement this rescue reads is in TOKENS. A reporter measured the crossing
 * point at roughly 150k tokens for an 8 MiB ceiling — while the model declares a
 * 1,000,000-token window, so `window * 0.6` is 600,000. The first measurement
 * then already satisfies `totalTokens <= target`, the loop returns on its first
 * pass, and the identical oversized body is re-sent: a rescue that reports
 * success while doing nothing is worse than one that reports failure.
 *
 * Deriving the target from the measurement itself avoids needing to know the
 * ceiling at all: one fold always removes at least 10% of what is there, so the
 * loop cannot be trivially satisfied, and repeated rounds converge on whatever
 * the ceiling happens to be.
 *
 * 0.9 rather than something smaller on purpose: the ceiling is unknown, so
 * folding aggressively would throw away far more history than necessary on a
 * request that only just crossed it. 10% per round, up to {@link MAX_ROUNDS},
 * covers a 57% reduction — enough for a body that overshot by a few percent,
 * which is the measured shape (8,401,132 B against a 8,388,608 B ceiling).
 */
const BODY_OVERSIZE_TARGET_FRACTION = 0.9

/** A session is never folded more than this many times by one rescue. */
const MAX_ROUNDS = 8

/** How many times one chunk may shrink its tail edge before giving up. */
const MAX_SHRINK = 24

/** A single fold is abandoned after this long. */
const FOLD_TIMEOUT_MS = 180_000

/**
 * Create the rescue bound to a live host.
 *
 * @param resolve - resolves host services at call time.
 * @returns the rescue handle the adapter calls on a provider overflow.
 */
export function createContextRescue(resolve: () => ContextRescueDeps): ContextRescue {
  // Sessions with a fold in flight. The summarization request issued by the
  // host's compaction transaction re-enters the same adapter, so without this
  // guard an overflow inside that request would start a nested rescue.
  const inflight = new Set<string>()

  return {
    async rescue(sessionId: string, window: number, cause: RescueCause = 'window'): Promise<boolean> {
      if (inflight.has(sessionId)) return false
      inflight.add(sessionId)
      try {
        return await foldUntilFits(resolve(), sessionId, window, cause)
      } catch (error: unknown) {
        resolve().log?.('dsh-connect-workbuddy: context rescue failed', error)
        return false
      } finally {
        inflight.delete(sessionId)
      }
    },
  }
}

/**
 * The fold target for one rescue, in the MEASUREMENT's own unit (tokens).
 *
 * Split out and pure so the unit mismatch that caused issue #258 is testable
 * without a host: the two causes derive the same number from two different
 * quantities, and only one of them can be trivially satisfied by the first
 * measurement.
 */
export function rescueTargetOf(cause: RescueCause, window: number, measuredTokens: number): number {
  if (cause === 'body-bytes') {
    // Derived from what is ACTUALLY there: always strictly below it, so the
    // first comparison cannot pass and the loop cannot return unfollded.
    return Math.max(1, Math.floor(measuredTokens * BODY_OVERSIZE_TARGET_FRACTION))
  }
  return Math.max(1, Math.floor(window * TARGET_FRACTION))
}

async function foldUntilFits(
  deps: ContextRescueDeps,
  sessionId: string,
  window: number,
  cause: RescueCause,
): Promise<boolean> {
  const { meter, compaction, agents } = deps
  if (meter === undefined || compaction === undefined || agents === undefined) return false
  const agent = agents.get(sessionId)
  if (agent === undefined) return false

  let target = Number.NaN
  let foldedAny = false
  let previous = Number.POSITIVE_INFINITY
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const measurement = meter.measure(agent.session)
    // Derived once, from the FIRST measurement, for a body-size refusal too.
    //
    // Re-deriving it every round would be untestable AND unnecessary: the loop
    // already stops at the target, and the host re-enters with a fresh rescue on
    // the next attempt if the body is still over the ceiling. A target that
    // chases the measurement inside one call was covered by no test that a
    // single-round target could not also pass — the summary node left behind
    // each round already keeps the loop shrinking — so it is not kept. What
    // matters is only that the first target is BELOW the first measurement,
    // which is what makes one fold happen at all.
    if (round === 0) {
      target = rescueTargetOf(cause, window, measurement.totalTokens)
    }
    if (measurement.totalTokens <= target) return foldedAny
    // A fold whose summary costs as much as the span it replaced is accepted by
    // the host but shrinks nothing. Once that happens the remaining excess is
    // structural — a single message larger than the window — and repeating the
    // attempt would only burn the retry budget.
    if (measurement.totalTokens >= previous) return foldedAny
    previous = measurement.totalTokens
    if (!await foldOnce(deps, agent, measurement, window, target)) return foldedAny
    foldedAny = true
  }
  return foldedAny
}

/**
 * Fold the oldest chunk that fits, shrinking its tail edge when the host
 * refuses the range.
 *
 * The host rejects a range whose edges split a tool call from its result, and
 * it rejects an active or missing range before appending anything — so a
 * refused attempt costs no durable state and the edge can simply move inward.
 *
 * @returns whether one chunk was folded.
 */
async function foldOnce(
  deps: ContextRescueDeps,
  agent: RescueAgent,
  measurement: RescueMeasurement,
  window: number,
  target: number,
): Promise<boolean> {
  const nodes = measurement.nodes
  // The final node is the message this very request carries; it must survive.
  if (nodes.length < 2) return false

  const budget = Math.floor(window * CHUNK_FRACTION)
  const excess = measurement.totalTokens - target
  const chunk = Math.max(1, Math.min(budget, excess))

  const head = nodes[0]
  const compaction = deps.compaction
  if (head === undefined || compaction === undefined) return false

  let end = -1
  let accumulated = 0
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const node = nodes[index]
    if (node === undefined) break
    accumulated += node.tokens
    end = index
    if (accumulated >= chunk) break
  }
  if (end < 0) return false

  const signal = AbortSignal.timeout(FOLD_TIMEOUT_MS)
  const floor = Math.max(0, end - MAX_SHRINK)
  for (; end >= floor; end -= 1) {
    const tail = nodes[end]
    if (tail === undefined) break
    try {
      await compaction.compactRegion(head.seq, tail.seq, agent, signal)
      return true
    } catch (error: unknown) {
      if (signal.aborted) {
        deps.log?.('dsh-connect-workbuddy: context rescue timed out', error)
        return false
      }
      // Expected refusal (unbalanced pairing, active compaction, changed span):
      // move the tail edge inward and try again.
    }
  }
  deps.log?.('dsh-connect-workbuddy: context rescue found no foldable range')
  return false
}
