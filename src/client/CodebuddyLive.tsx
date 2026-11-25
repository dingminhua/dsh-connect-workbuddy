/**
 * The composer pill that says what the CodeBuddy CLI route is doing RIGHT NOW.
 *
 * WHY THIS EXISTS. A bridged turn is a spawned agent: minutes of reading files
 * and running commands, then one answer. The Host tool contract has no progress
 * channel — `execute()` returns when it returns — so without this pill the user
 * watches a spinner with no way to tell "still working" from "hung". The pill is
 * fed by the plugin's own read-only route (`WORKBUDDY_CLI_LIVE_PATH`), which
 * serializes the host-side live board (see `../cli-bridge/live.ts`).
 *
 * WHY IT RENDERS NOTHING WHEN IDLE. This is the ambient dock under the composer,
 * a row the shell already fills with round/token pills. A permanent "no turn
 * running" line would be a claim about a feature most users never switch on
 * (`cliBridge.enabled` defaults to false), so the empty state is `null`: the row
 * is untouched until there is something true to say.
 *
 * WHY IT ONLY DESCRIBES THIS SESSION'S TURN. The board is host-wide: one route
 * answers for every session in the process, so an unfiltered pill would show the
 * turn another tab started — a line about a directory the user is not looking at,
 * sitting under the composer they are typing in. The seat is declared
 * `scope: 'session'` (`conversation.composer.dock`), so the framework hands the
 * registration its `sessionId`; the pill keeps the rows that belong to it.
 *
 * WHY NOT THE PROVIDER GATE THE CREDIT READOUT USES. `ComposerCredits` renders
 * only while the session's model is a WorkBuddy provider, because it reports that
 * provider's quota. This pill reports a spawned CLI process, and the CLI route is
 * deliberately model-independent: the whole point is that it works from any
 * session, including one running DeepSeek. Gating it on the provider would hide
 * the readout exactly when the feature is being used the way it was designed.
 * `cliBridge.enabled` needs no gate either — with the bridge off no turn can
 * begin, so the board is empty and the pill renders nothing.
 *
 * WHY POLLING, AND WHY THE INTERVAL IS 5s. The Host has no push channel to a
 * session component, so a poll is the only option. Five seconds is the slowest
 * cadence at which a turn that just started still feels immediate; the elapsed
 * counter between polls is advanced locally from `startedAt` (a 1s tick that
 * costs no request), so the number moves every second without the network
 * traffic moving with it. Concurrent sessions share ONE in-flight request per
 * interval (see {@link readLive}), which is what keeps N open tabs from becoming
 * N polls per tick.
 *
 * WHY THE CLOCK OFFSET IS APPLIED. `startedAt` is the HOST's clock. A browser
 * whose clock is a minute behind would compute a negative age and the pill would
 * print nonsense. The document ships `serverTime`, so the offset is measured at
 * each successful read and applied to the local clock instead of trusting the
 * two machines to agree.
 *
 * @module dsh-connect-workbuddy/client/CodebuddyLive
 */
import { resolveRequestUrl } from './request-url.ts'
import { useEffect, useRef, useState } from 'react'
import { WORKBUDDY_CLI_LIVE_PATH } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'
import { WORKBUDDY_COMPOSER_CSS } from './styles.ts'

/**
 * Inject the dock stylesheet on module load, once.
 *
 * `ComposerCredits` injects the same sheet for its own classes, and in the
 * shipped bundle both modules are static imports of the client entry, so in
 * practice the sheet is already there. This block is not redundant: it makes the
 * pill independent of whether the credit readout is mounted at all (the gate can
 * hide it for a non-WorkBuddy model), and the `data-plugin-css` guard means the
 * two never produce a second tag.
 */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-workbuddy/composer-credits.css'
  if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-workbuddy'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = WORKBUDDY_COMPOSER_CSS
    document.head.appendChild(styleTag)
  }
}

/** How often the route is asked. See the module comment for why 5s. */
export const CLI_LIVE_POLL_MS = 5000

/** How often the elapsed counter is advanced locally between polls. */
export const CLI_LIVE_TICK_MS = 1000

/**
 * One live turn, as the route ships it.
 *
 * Declared here rather than imported from `../cli-bridge/live.ts` on purpose:
 * the client entry must not pull host code into the browser bundle, and this is
 * the wire shape — the same reason `status-paths.ts` declares its own types
 * instead of importing the host modules that produce them.
 */
export interface LiveTurnView {
  id: string
  startedAt: number
  elapsedMs: number
  entrance: 'tool' | 'command'
  workingDir: string
  unattended: boolean
  permissionMode: string
  model: string
  sessionId: string
  phase: 'starting' | 'running' | 'finishing'
  toolCalls: number
  lastTool: string
  chars: number
}

export interface LiveSnapshot {
  turns: LiveTurnView[]
  serverTime: number
}

/**
 * The last document any component in this page saw, shared across sessions.
 *
 * A module-level cache is safe here because the document is host state, not
 * component state: every session polls the same board, so one request serves
 * them all. `inflight` collapses the case where several components mount in the
 * same tick — without it, opening three sessions at once would fire three
 * requests and each would overwrite the others' result.
 */
let cached: { at: number; document: LiveSnapshot } | undefined
let inflight: Promise<LiveSnapshot | undefined> | undefined

/** Test seam: forget the cache so a test starts from a known state. */
export function resetLiveCache(): void {
  cached = undefined
  inflight = undefined
}

/**
 * Accept a document only if every number the pill does arithmetic on is a real
 * number.
 *
 * The route is our own, so this is not defence against an attacker — it is
 * defence against a HALF-AGREED wire: a field renamed on the host side, an
 * `undefined` that `JSON.stringify` drops, or a future route that answers a
 * different shape. Without the check `serverTime` becomes `NaN`, the clock
 * offset becomes `NaN`, and the pill renders `NaNs` — a number that is wrong in
 * the one place a user is looking for reassurance. Dropping the whole document
 * degrades to "no turn", which is the honest answer when the wire is unreadable.
 */
function acceptDocument(value: unknown): LiveSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { turns?: unknown; serverTime?: unknown }
  if (!Array.isArray(candidate.turns)) return undefined
  if (typeof candidate.serverTime !== 'number' || !Number.isFinite(candidate.serverTime)) return undefined
  // Per-turn: `startedAt` and the counters are what the label arithmetic reads.
  // A turn missing them is dropped rather than rendered as `NaN`; the rest of
  // the document stays usable.
  const turns = candidate.turns.filter((turn): turn is LiveTurnView => {
    if (typeof turn !== 'object' || turn === null) return false
    const row = turn as Partial<LiveTurnView>
    return (
      typeof row.startedAt === 'number' &&
      Number.isFinite(row.startedAt) &&
      typeof row.toolCalls === 'number' &&
      Number.isFinite(row.toolCalls)
    )
  })
  return { turns, serverTime: candidate.serverTime }
}

/** Read the board, reusing a recent document or a request already in flight. */
export async function readLive(
  fetchImpl: typeof fetch,
  now: number = Date.now(),
  cacheMs: number = CLI_LIVE_POLL_MS,
): Promise<LiveSnapshot | undefined> {
  if (cached !== undefined && now - cached.at < cacheMs) return cached.document
  if (inflight !== undefined) return inflight
  inflight = (async (): Promise<LiveSnapshot | undefined> => {
    try {
      const response = await fetchImpl(resolveRequestUrl(WORKBUDDY_CLI_LIVE_PATH), { headers: { accept: 'application/json' } })
      if (!response.ok) return undefined
      const document = acceptDocument(await response.json())
      if (document === undefined) return undefined
      cached = { at: Date.now(), document }
      return document
    } catch {
      // A failed poll is not an error worth surfacing: the route is local, and
      // the pill simply keeps showing the last document until the next tick.
      return undefined
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

/**
 * How many consecutive failed polls before the pill stops claiming a turn.
 *
 * The comment above says the pill "keeps showing the last document until the
 * next tick", which is right for one dropped request and wrong for a route that
 * has started answering 500: the pill would then describe a turn forever, with
 * an elapsed counter that keeps growing. Three intervals (15s) is long enough to
 * ride out a reload and short enough that a dead route does not leave a ghost on
 * the composer.
 */
export const CLI_LIVE_FAILURE_LIMIT = 3

/**
 * The text of one pill.
 *
 * Split out so the format is testable without a DOM, and so the same function
 * produces the visible label and the accessible one.
 */
export function liveLabel(
  turn: LiveTurnView,
  elapsedMs: number,
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string,
): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  const parts = [t('cliLive.running'), t('cliLive.toolCalls', { count: turn.toolCalls })]
  if (turn.phase === 'starting') parts.push(t('cliLive.starting'))
  else if (turn.phase === 'finishing') parts.push(t('cliLive.finishing'))
  else parts.push(t('cliLive.elapsed', { seconds }))
  if (turn.lastTool !== '') parts.push(t('cliLive.lastTool', { tool: turn.lastTool }))
  return parts.join(' · ')
}

export interface CodebuddyLiveProps {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  /**
   * The session this pill sits in, injected by the session-scoped seat.
   *
   * `undefined` (a host that does not pass it, or a test that mounts the
   * component directly) disables the filter rather than blanking the pill: the
   * readout is diagnostic, and losing it entirely is worse than showing a turn
   * from a neighbouring tab.
   */
  sessionId?: string
  /** Test seams; the slot injects neither. */
  fetchImpl?: typeof fetch
  pollMs?: number
  tickMs?: number
}

/**
 * Keep the rows this pill is allowed to describe.
 *
 * A row with an empty `sessionId` is one the host could not attribute (the tool
 * ran without an agent on the execution object). Hiding those would make the pill
 * silently useless on such a host, so they are kept: an unattributed row is
 * evidence of real work, and the alternative is a readout that never appears.
 */
export function turnsForSession(turns: LiveTurnView[], sessionId: string | undefined): LiveTurnView[] {
  if (sessionId === undefined || sessionId === '') return turns
  return turns.filter(turn => turn.sessionId === '' || turn.sessionId === sessionId)
}

/**
 * The pill itself.
 *
 * Shows the NEWEST turn (the one the last click started) and appends `+N` when
 * several are live, because the dock is a single line and a queue listing would
 * wrap. The count is the whole point of the `+N`: it tells the user there is
 * more work running than the line describes.
 */
export function CodebuddyLive(props: CodebuddyLiveProps) {
  const { t } = props
  const fetchImpl = props.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  const pollMs = props.pollMs ?? CLI_LIVE_POLL_MS
  const tickMs = props.tickMs ?? CLI_LIVE_TICK_MS
  const [document, setDocument] = useState<LiveSnapshot | undefined>(undefined)
  // Bumped by the local tick so the elapsed counter re-renders without a fetch.
  const [, setTick] = useState(0)
  // Host clock minus local clock. Measured only when a FRESH document arrives:
  // `readLive` serves a cached one for up to a poll interval, and that document
  // still carries the old `serverTime`. Re-measuring on every cached return
  // would subtract the elapsed time from the offset on each poll and pin the
  // counter at whatever age the document had when it was fetched.
  const offsetRef = useRef(0)
  const offsetForRef = useRef<number | undefined>(undefined)
  // Consecutive failed polls. Reset by any document that arrives; once it passes
  // CLI_LIVE_FAILURE_LIMIT the pill stops describing a turn it can no longer
  // confirm is still running.
  const failuresRef = useRef(0)

  useEffect(() => {
    if (fetchImpl === undefined) return undefined
    let live = true
    const read = (): void => {
      // The cache window follows the component's own interval, not the module
      // default: a caller that polls every 20ms (the tests) must not be served a
      // five-second-old document, and a caller that polls slowly must not re-ask
      // on every tick.
      void readLive(fetchImpl, Date.now(), pollMs).then(next => {
        if (!live) return
        if (next === undefined) {
          failuresRef.current += 1
          if (failuresRef.current >= CLI_LIVE_FAILURE_LIMIT) setDocument(undefined)
          return
        }
        failuresRef.current = 0
        if (next.serverTime !== offsetForRef.current) {
          offsetForRef.current = next.serverTime
          offsetRef.current = next.serverTime - Date.now()
        }
        setDocument(next)
      })
    }
    read()
    const timer = setInterval(read, pollMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [fetchImpl, pollMs])

  const turns = turnsForSession(document?.turns ?? [], props.sessionId)
  const active = turns.length > 0

  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => { setTick(value => value + 1) }, tickMs)
    return () => { clearInterval(timer) }
  }, [active, tickMs])

  if (!active) return null

  // Newest last in the document (the board appends), so the newest is the tail.
  const turn = turns[turns.length - 1] as LiveTurnView
  const elapsedMs = Math.max(0, Date.now() + offsetRef.current - turn.startedAt)
  const label = liveLabel(turn, elapsedMs, t)
  const extra = turns.length > 1 ? ` +${String(turns.length - 1)}` : ''
  // Several turns can be live in ONE session (the model may call the tool twice,
  // or a command and a tool overlap), and the pill names the newest. The
  // directory's last segment goes in the tooltip so a user running two workspaces
  // from one session can tell which project the line is about without widening
  // the pill.
  const dirTail = turn.workingDir.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? ''
  const title = dirTail === '' ? `${label}${extra}` : `${label}${extra} · ${dirTail}`

  return (
    <span
      // `status` and not `alert`: a running turn is ambient information, and an
      // assertive announcement every time a tool is called would interrupt a
      // screen-reader user mid-sentence.
      role="status"
      aria-label={t('cliLive.aria', { detail: label })}
      title={title}
      // Styled from the sheet, not inline: the dock row is shared with the
      // credit readout and the shell's ContextMeter, and matching their 12px /
      // label-tertiary metrics is what makes this read as one of them.
      className="dsm-workbuddy-cli-live"
    >
      <span aria-hidden="true" className="dsm-workbuddy-cli-live-dot" />
      {label}{extra}
    </span>
  )
}
