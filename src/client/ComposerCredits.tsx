/**
 * Credit readout for the composer tool row (`conversation.input.left`).
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 `client/ComposerPoints.tsx`：读数形态（`<区域> · <余额>`）、
 *     点击弹出锚定面板、面板内是**账号表格**（点行即切换账号）、刷新按钮
 *     放在面板里而不是读数上、每账号读数**只在面板打开时抓**、5 分钟定时器、
 *     失败保留上次数值。本文件把「只有国内版」扩成「两个区域都支持」：那边
 *     的国际版是订阅制、没有可比数字，本插件的国际版有真实余额，所以按当前
 *     选中模型所属的区域显示，并在读数上标明是 WB CN 还是 WB AI。
 *
 * Shows the selected region's general credit balance, but ONLY while the
 * session's selected model belongs to this plugin (the gate decides that).
 *
 * The row itself is a bare clickable readout — `WB CN · 1,072` — with NO
 * refresh control: the manual refresh lives in the panel, because the row is
 * shared with the shell's own permission/agent/model controls and every extra
 * control there costs space that is not ours. Clicking it opens an anchored
 * panel: a TABLE with one row per account in that region and its balance, where
 * a row click switches to it.
 *
 * Two deliberate choices in that panel:
 *
 *  - Per-account figures are fetched ONLY while the panel is open. The 5-minute
 *    readout must not multiply its upstream reads by the account count — a
 *    healthy balance should not pay for a table nobody is looking at.
 *  - A row whose balance could not be read shows `—`, never `0`. The endpoint
 *    omits the field in that case precisely so this component cannot render a
 *    wrong claim about the account.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismissOnOutsidePointer } from './popover.ts'
import { applyManualOrder, readOrderAccountIds } from './manual-order'
import {
  availabilityLine,
  availabilityMark,
  stateTone,
  testRowOf,
  withTestRow,
} from './account-state.ts'
import type { AccountStateInput } from './account-state.ts'
import {
  WORKBUDDY_ACCOUNT_CREDITS_PATH,
  WORKBUDDY_POOL_PATH,
  WORKBUDDY_USAGE_PATH,
  withWorkBuddyRegion,
  withWorkBuddyRegionAndAction,
} from '../status-paths.ts'
import { readNdjson } from './ndjson.ts'
import { normalizeNewModelIds } from './new-model-ids.ts'
import { poolFailureText } from './pool-state.ts'
import { writeAccountSlot } from './account-selection.ts'
import { formatCredits } from './credit-format.ts'
import { WORKBUDDY_COMPOSER_CSS } from './styles.ts'
import type { WorkBuddyWebAccountCredit, WorkBuddyWebModel, WorkBuddyWebRegion, WorkBuddyWebUsage } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'
import type { WorkBuddyCardInjected } from './WorkBuddyCard.tsx'

/**
 * Inject the readout's styles into the document head, once, on module load.
 *
 * Same idempotent pattern as the card's injection, and for the same reason: the
 * classes are attached to DOM this component owns, and `WORKBUDDY_CARD_CSS` only
 * loads when the settings card does — which is not guaranteed on a host where
 * the card is never rendered. The referring project shipped exactly that bug
 * (the trigger rendered as a default button box and the panel, without
 * `position: fixed`, had its measured left/top ignored and appeared nowhere).
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

/**
 * Automatic refresh period for the READOUT. Five minutes, matching a credit
 * balance's actual rate of change: it moves on the scale of model calls, not
 * seconds, and each read is a read-only upstream call.
 */
export const COMPOSER_CREDITS_REFRESH_INTERVAL_MS = 300_000

/**
 * Refresh period for the panel's per-account table, while it stays open.
 *
 * Deliberately NOT the readout's five minutes. The table carries two things,
 * and the faster-moving one decides the cadence:
 *
 *  - the balance, which barely moves, and
 *  - each account's `excludedBy` ("被限流" / "模型繁忙"), which is derived from
 *    the pool's own cooldowns — and the SHORTEST of those is the model-scoped
 *    two-minute throttle (`MODEL_BUSY_COOLDOWN_MS`).
 *
 * At five minutes the table could state an account is 模型繁忙 long after the
 * upstream let it serve again, and the pool card — which polls every 60 s
 * (`POLL_INTERVAL_MS` in `WorkBuddyCard.tsx`) — would say it is fine at the same
 * moment. Two surfaces disagreeing about one account is exactly the complaint
 * this constant answers, so the table now converges on the card's cadence
 * instead of its own.
 *
 * The cost is bounded and paid only while the panel is open: one `fetchCredits`
 * per account per minute, the same read the card already makes when it is open.
 */
export const COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS = 60_000

/** Localized copy injected by the browser-plugin registration. */
export interface ComposerCreditsInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
}

export interface ComposerCreditsProps extends Partial<ComposerCreditsInjected> {
  /**
   * Provider route of the session's selected model, or undefined while the
   * projection has not landed. The readout renders nothing unless this is one
   * of {@link WORKBUDDY_COMPOSER_PROVIDERS}.
   */
  provider?: string
  /** Which region's credits to read when the provider is this plugin's. */
  region?: WorkBuddyWebRegion
  /**
   * Settings scope from the configForms mirror. Present whenever a row click
   * should switch accounts; without it the table still renders but the rows are
   * inert, because a panel that switches nothing must not pretend to.
   */
  settingsScope?: WorkBuddyCardInjected['settingsScope']
}

/**
 * Provider routes whose credit balance this readout can show, mapped to the
 * region to read it from.
 *
 * BOTH regions, unlike the referring project: its international side is
 * subscription-based and has no comparable balance, while WorkBuddy's
 * international accounts do carry one, so there is a real number to show on
 * either side. Mirrors `WORKBUDDY_PROVIDERS` on the host side; duplicated here
 * because the client bundle must not import the host entry.
 */
export const WORKBUDDY_COMPOSER_PROVIDERS: Readonly<Record<string, WorkBuddyWebRegion>> = {
  'workbuddy': 'cn',
  'workbuddy-global': 'global',
}

/** The credit total out of one usage document, or undefined. */
function creditsOf(usage: WorkBuddyWebUsage): number | undefined {
  if (usage.status !== 'signed-in') return undefined
  return usage.credits?.total
}

/**
 * The "· N 新模型" ids out of one usage document, in first-sighted order.
 *
 * The filters live in `normalizeNewModelIds`, shared with the host picker's row
 * marker, so the two surfaces cannot disagree about which models are new.
 *
 * Three filters, none of them optional:
 * 1. Not a signed-in document answers `[]` rather than throwing — a Host that
 *    predates the feature, or a degraded document, must cost the pill its
 *    credits readout, and it must not cost it a crash.
 * 2. A non-string, or an id that is only whitespace, is dropped.
 * 3. Duplicates are dropped. The Host already dedupes, but the client must not
 *    trust a peer: a duplicated id would turn "2 新模型" into two rows naming
 *    the same model and stop the count meaning anything.
 */
function newModelIdsOf(usage: WorkBuddyWebUsage | undefined): string[] {
  if (usage === undefined || usage.status !== 'signed-in') return []
  return normalizeNewModelIds(usage.newModelIds)
}

/**
 * The display name for a first-seen id, or the id itself when the catalog does
 * not list it — a model that left the roster can still be inside the new
 * window, and showing its id is a lie-free answer to "which model".
 */
function modelNameOf(models: readonly WorkBuddyWebModel[], id: string): string {
  const found = models.find(model => model.id === id)
  return found === undefined || found.name.trim() === '' ? id : found.name
}

/**
 * The Host's per-region readout switch off a usage document, when it carries one.
 *
 * The `error` variant has no data at all, so it can only ever answer `undefined`
 * — "the Host did not say", which leaves the settings scope in charge.
 */
export function hostCreditsShownOf(usage: WorkBuddyWebUsage | undefined): boolean | undefined {
  if (usage === undefined || usage.status === 'error') return undefined
  const value = usage.showCreditsInMainUi
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The Host's per-region capsule switch off a usage document, when it carries one.
 *
 * Sibling of {@link hostCreditsShownOf}: the master switch hides the whole
 * readout family, while `showComposerCredits` hides only THIS capsule. Both are
 * re-applied against the Host's answer as soon as the document lands, because
 * the browser settings mirror is stale for this namespace on the affected
 * deployments — the same reason the sibling exists.
 *
 * The `error` variant carries no data, so it can only answer `undefined`; a Host
 * that predates the field answers `undefined` too, which leaves the settings
 * scope in charge.
 */
export function hostComposerCreditsShownOf(usage: WorkBuddyWebUsage | undefined): boolean | undefined {
  if (usage === undefined || usage.status === 'error') return undefined
  const value = usage.showComposerCredits
  return typeof value === 'boolean' ? value : undefined
}

function formatClock(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * The dot's classes, one per tone.
 *
 * Written out in full instead of `\`…-dot-${tone}\`` on purpose: the panel's
 * CSS-contract test harvests class names from this file with
 * /dsm-workbuddy-composer-[a-z-]+/ and a template literal would contribute a
 * dangling "…-dot-" prefix that no rule defines.
 */
const DOT_CLASS = {
  ok: 'dsm-workbuddy-composer-panel-dot dsm-workbuddy-composer-panel-dot-ok',
  error: 'dsm-workbuddy-composer-panel-dot dsm-workbuddy-composer-panel-dot-error',
  unknown: 'dsm-workbuddy-composer-panel-dot dsm-workbuddy-composer-panel-dot-unknown',
} as const

/**
 * The dot class for one row: green when the account can serve, red when it cannot.
 *
 * The rule the owner settled on, after three rounds of this: colour answers
 * "can it be used", and the row's second line answers "is it the one I am
 * using". Those two questions used to share one channel — an earlier revision
 * painted green only on the selected account, which made every usable row grey
 * and the list read as one live row among dead ones ("这样无法知道当前用的是什么"):
 * true about selection, false about usability, and the panel is opened mainly to
 * ask the second question.
 *
 * So green is now the ordinary state of a usable account, selected or not, and
 * "当前选用" is printed under the name of the selected one. Red carries the
 * refusal — including a stated rate limit, which used to be amber; amber read as
 * "mostly fine", and an account that cannot answer this message is not fine.
 *
 * Grey is reserved for an account nobody has measured yet. Painting it green
 * would assert a health nobody checked, and red would assert a failure nobody
 * saw; the absence of a reading is its own state.
 */
function dotClass(account: AccountStateInput): string {
  const tone = stateTone(account)
  if (tone === 'ok') return DOT_CLASS.ok
  if (tone === 'warn' || tone === 'error') return DOT_CLASS.error
  return DOT_CLASS.unknown
}

/**
 * The row's second line, from the facts that belong in it.
 *
 * Two independent ones: whether this is the account serving the tab, and — when
 * it cannot serve — why, with the wait but never the absolute instant. Joined
 * with the same separator the rest of this panel uses, and dropped entirely when
 * there is nothing to say, so a plain usable row stays one line tall.
 */
function detailLine(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part !== '')
  return kept.length === 0 ? undefined : kept.join(' · ')
}

export function ComposerCredits(props: ComposerCreditsProps) {
  const { t, provider, region, settingsScope } = props
  if (t === undefined) throw new Error('Composer credits readout requires its translation function')
  const owned = provider === undefined ? undefined : WORKBUDDY_COMPOSER_PROVIDERS[provider]
  const activeRegion = region ?? owned

  const [usage, setUsage] = useState<WorkBuddyWebUsage | undefined>(undefined)
  const [accountCredits, setAccountCredits] = useState<WorkBuddyWebAccountCredit[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /**
   * A test batch is running.
   *
   * Separate from `busy`, which tracks a credits READ: the two take wildly
   * different times (one round trip against one probe per account, serial with
   * a gap), and sharing a flag would either freeze the readout for a minute or
   * let a press be swallowed as "already refreshing".
   */
  const [testing, setTesting] = useState(false)
  /** The batch's failure, in the user's language; `failed` is for reads. */
  const [testError, setTestError] = useState<string | undefined>(undefined)
  const [switchingId, setSwitchingId] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const inFlight = useRef(false)
  /** A batch is running; guards a second press that lands before `setTesting`. */
  const testingRef = useRef(false)
  /** Account-table reads in flight; see `fetchAccountCredits`. */
  const accountsInFlight = useRef(0)
  /** Which account-table read is the newest; see `fetchAccountCredits`. */
  const accountsReadGeneration = useRef(0)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** Whether the panel was opened BY the "· N 新模型" button (so it answers the
   *  question the reader just asked, instead of just opening on the table). */
  const [revealed, setRevealed] = useState(false)
  const newRowRef = useRef<HTMLParagraphElement | null>(null)

  /**
   * The "· N 新模型" button is an affordance for the reader who wants to know
   * WHICH models: it opens the panel and brings the new-model row into view.
   *
   * The Host owns the model picker and offers this plugin no API to open it or
   * steer its selection, so the honest answer is the panel's own row — the one
   * surface in the pill that names them. The rows themselves are marked "新" in
   * the picker by `WorkBuddyModelLabel`, reading the same ids.
   *
   * The row is focused (not just scrolled) because that is what a screen reader
   * needs to keep its place; it is pulled out of the tab order so Tab does not
   * stop on it.
   */
  useEffect(() => {
    if (!open) {
      if (revealed) setRevealed(false)
      return
    }
    if (!revealed) return
    const row = newRowRef.current
    if (row === null) return
    try {
      row.scrollIntoView({ block: 'nearest' })
    } catch {
      // Scrolling is the enhancement; the focus below is the contract. A test
      // environment (jsdom) does not implement `scrollIntoView`, and the row
      // must still be reachable there.
    }
    row.focus()
  }, [open, revealed])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const position = useAnchoredPosition({
    open: open && activeRegion !== undefined,
    anchorRef: rootRef,
    panelRef,
    // Above the trigger: the composer sits at the bottom of the window, so a
    // downward panel would open off-screen.
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  const fetchUsage = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (inFlight.current || activeRegion === undefined) return
    inFlight.current = true
    if (mounted.current) setBusy(true)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_USAGE_PATH, activeRegion), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as WorkBuddyWebUsage
      if (!mounted.current || signal?.aborted === true) return
      setUsage(value)
      setLastRefresh(Date.now())
      setFailed(false)
    } catch {
      // Keep the previous value: a stale number is better than a blank row for
      // a balance that almost certainly did not change.
      if (mounted.current && signal?.aborted !== true) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }, [activeRegion])

  /**
   * Every account's balance in the region — one upstream read per account.
   *
   * Paid only while the panel is open (see the note at the top of this file).
   * A failure keeps whatever we already have rather than clearing it: the table
   * falls back to the usage document's account list, so a failed figure must not
   * remove the switch.
   *
   * `force` distinguishes the TWO callers, and the distinction is the point:
   *
   *  - the panel's timer passes nothing, so a tick that arrives while a read is
   *    still in flight is SKIPPED. The panel is asking "has anything changed?",
   *    and a read already on its way answers that.
   *  - a deliberate action (the refresh button, or `switchTo` re-reading after a
   *    write) passes `force: true`, because it must actually happen. Skipping it
   *    would be the same defect this file is fixing: a control that reports "the
   *    table is current" without having asked. It also claims the newest
   *    generation, so its answer is the one that lands.
   *
   * Latest-wins rather than a queue: responses can resolve out of order, and a
   * slow tick started earlier must not overwrite the press that superseded it —
   * which would silently re-draw a mark the press had just cleared.
   */
  const fetchAccountCredits = useCallback(async (signal?: AbortSignal, force?: boolean): Promise<void> => {
    if (activeRegion === undefined) return
    if (!force && accountsInFlight.current > 0) return
    const generation = ++accountsReadGeneration.current
    accountsInFlight.current += 1
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_ACCOUNT_CREDITS_PATH, activeRegion), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as { accounts?: unknown }
      if (!mounted.current || signal?.aborted === true) return
      // Superseded while in flight: applying now would restore rows a newer read
      // has already replaced.
      if (generation !== accountsReadGeneration.current) return
      if (Array.isArray(data.accounts)) {
        setAccountCredits(data.accounts as WorkBuddyWebAccountCredit[])
        // The footer's clock moves for THIS read too. It answers "when did the
        // panel last ask the upstream about credits?", and this route is a
        // credits read — reporting only the usage read's time would let a table
        // that just refreshed sit under a timestamp that never changes, which is
        // the same "is this stale?" question the frozen marks raised.
        setLastRefresh(Date.now())
      }
    } catch {
      // Keep the previous rows; see above.
    } finally {
      accountsInFlight.current -= 1
    }
  }, [activeRegion])

  // Fetch usage on mount and whenever the region changes, then keep it fresh.
  // The timer starts only after the first fetch settles, so a slow upstream
  // cannot stack overlapping reads.
  //
  // A region the HOST reports as hidden gets exactly one read and no timer: the
  // read is what tells us it is hidden, and re-reading a readout that must not
  // render would be a background poll for nothing. Should the Host flip the flag
  // back on, the scope subscription (or a remount) brings us back.
  const hostHidden = hostCreditsShownOf(usage) === false || hostComposerCreditsShownOf(usage) === false
  useEffect(() => {
    if (owned === undefined || hostHidden) return undefined
    let cancelled = false
    let timer: number | undefined
    const controller = new AbortController()
    void fetchUsage(controller.signal).finally(() => {
      if (cancelled) return
      timer = window.setInterval(() => { void fetchUsage(controller.signal) }, COMPOSER_CREDITS_REFRESH_INTERVAL_MS)
    })
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      controller.abort()
    }
  }, [owned, hostHidden, fetchUsage])

  /**
   * Per-account figures are read on OPEN, then kept fresh while the panel stays
   * open.
   *
   * The on-open read is what makes the table useful immediately. The TIMER is
   * the fix for the complaint that started this: with an open-only read, a panel
   * left open showed a frozen snapshot of every account's `excludedBy`, while
   * the pool card behind it re-ranked every 60 s. The two then disagreed about
   * the same account — the panel drawing no mark where the card said 模型繁忙 —
   * and neither surface was wrong on its own data, which is what made it so hard
   * to read.
   *
   * The timer starts only AFTER the first read settles, so a slow upstream
   * cannot stack overlapping reads (the same shape the readout's own effect
   * uses). Aborted on close: the panel pays one read per minute only while it is
   * actually on screen.
   */
  useEffect(() => {
    if (!open || activeRegion === undefined) return undefined
    let cancelled = false
    let timer: number | undefined
    const controller = new AbortController()
    void fetchAccountCredits(controller.signal).finally(() => {
      if (cancelled) return
      timer = window.setInterval(
        () => { void fetchAccountCredits(controller.signal) },
        COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS,
      )
    })
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      controller.abort()
    }
  }, [open, activeRegion, fetchAccountCredits])

  // Escape closes the panel, matching the neighbouring popovers.
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  /**
   * Switch to another account, then re-read both the usage document and the
   * table so the marker, the readout and the panel all move together.
   *
   * Goes through the shared `writeAccountSlot`, which is read-back checked and
   * carries the host-endpoint-first path: `set()` resolving is not proof the
   * write landed, and a refused write must report failure instead of showing a
   * marker on an account that was never selected.
   */
  const switchTo = async (accountId: string): Promise<void> => {
    if (settingsScope === undefined || settingsScope.getSnapshot().writable !== true) return
    if (activeRegion === undefined || switchingId !== undefined) return
    const currentId = accountCredits?.find(account => account.selected)?.id
      ?? (usage?.status === 'signed-in' ? usage.accountId : undefined)
    if (accountId === currentId) return
    setSwitchingId(accountId)
    setFailed(false)
    try {
      await writeAccountSlot(settingsScope, activeRegion, accountId)
      await fetchUsage()
      // `true`: the row this user clicked must come back re-read. Skipping this
      // because a tick was in flight would leave the marker (and the balance)
      // describing the account the panel was showing BEFORE the switch.
      await fetchAccountCredits(undefined, true)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) setSwitchingId(undefined)
    }
  }

  /**
   * The header button: test EVERY account in this region, then re-read what the
   * batch changed.
   *
   * It used to be a plain refresh. The owner asked for the other thing this
   * panel's readers actually want — the same "一键测试所有账号" the pool card
   * runs (`src/account-pool-run.ts testAllAccounts`, one account at a time with
   * a gap, because hitting the whole pool at once is how the upstream's volume
   * limit gets tripped).
   *
   * Two reasons the batch, not a read, is the right control HERE. A mark in this
   * table is a MEASUREMENT (`被限流 · 约 6 小时后` is a probe result), and
   * re-reading the usage document cannot improve a stale measurement — only
   * running it again can. And the rows are the pool's members, so the question
   * "which of these can serve?" is answered by testing them, not by asking the
   * credits endpoint again.
   *
   * The re-read afterwards is not a courtesy: the probes live in the USAGE
   * document (`usage.pool.accounts[].probe`), so the dots and marks only move
   * once that document is fetched again. Without it the button would leave the
   * table showing the state it just measured away.
   *
   * The batch answers NDJSON (one line per account, streamed) on a current Host
   * and one document on an older one, so both shapes are read; the stream is
   * drained even after unmount, because dropping the reader leaves the Host
   * writing into a socket nobody reads.
   */
  const testEveryAccount = useCallback(async (): Promise<void> => {
    if (activeRegion === undefined || testingRef.current) return
    testingRef.current = true
    if (mounted.current) {
      setTesting(true)
      setTestError(undefined)
      setFailed(false)
    }
    try {
      const response = await fetch(withWorkBuddyRegionAndAction(WORKBUDDY_POOL_PATH, activeRegion, 'test'), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      let failure: string | undefined
      // Same content-type test the card uses: the streamed shape commits its
      // status on the first line, so a mid-batch failure arrives as a LINE, not
      // as a non-2xx response.
      if ((response.headers.get('content-type') ?? '').includes('ndjson')) {
        if (!response.ok) {
          failure = poolFailureText(t, { status: response.status })
        } else {
          await readNdjson(response.body, line => {
            // Land each measurement the moment it exists. The batch is serial,
            // so waiting for the whole stream leaves the row the user is watching
            // wrong for as long as the SLOWEST account takes — the dead-looking
            // panel the streamed batch was built to avoid. The re-read in
            // `finally` then confirms the same facts from the Host's own store,
            // so a fold is a shortcut, never the record.
            const row = testRowOf(line)
            if (row !== undefined) {
              if (mounted.current) {
                setUsage(previous => (previous === undefined ? previous : withTestRow(previous, row, Date.now())))
              }
              return
            }
            const reason = line['reason']
            if (typeof reason !== 'string') return
            failure = poolFailureText(t, {
              status: 200,
              reason,
              error: typeof line['error'] === 'string' ? line['error'] : undefined,
            })
          })
        }
      } else {
        const body = await response.json().catch(() => undefined) as
          | { error?: string, reason?: string }
          | undefined
        if (!response.ok) {
          failure = poolFailureText(t, { status: response.status, reason: body?.reason, error: body?.error })
        }
      }
      if (mounted.current && failure !== undefined) setTestError(failure)
    } catch {
      // A transport failure. The rows keep their previous measurements rather
      // than being blanked: nothing was learned about them.
      if (mounted.current) setTestError(t('composer.testFailed'))
    } finally {
      testingRef.current = false
      if (mounted.current) setTesting(false)
      // `true`: a press must reach the upstream even if a timer tick is in
      // flight, and it claims the newest generation so its answer lands.
      await Promise.all([fetchUsage(), fetchAccountCredits(undefined, true)])
    }
  }, [activeRegion, fetchUsage, fetchAccountCredits, t])

  // Not this plugin's model: render nothing at all, so the composer row is
  // untouched while another provider is in use.
  //
  // The gate already filters, so in the shipped wiring this branch never fires.
  // It stays because this is a public component: a caller that forgets to check
  // must not get a WorkBuddy balance rendered next to another provider's model.
  if (owned === undefined) return null

  /**
   * The Host's own answer for this region, when the document carries one.
   *
   * The Host is the AUTHORITY on whether this readout is wanted, exactly as the
   * card's `creditsShownOn` treats it — and here it is also the fix for a defect
   * shipped in 4.3.0 (issue #46): the gate's decision rests on the settings
   * scope, which on a host whose describe mirror lands late was bound to a
   * namespace nothing serves. Every read of that scope is then `undefined`, and
   * the opt-out rule (`!== false`) reads "shown" forever — so unticking the
   * checkbox wrote correctly and changed nothing on screen.
   *
   * Checked AFTER the fetch rather than before it because the answer only
   * arrives with the document. The cost is one usage read for a readout the user
   * may have hidden, against a persistent wrong number on screen.
   */
  if (hostCreditsShownOf(usage) === false) return null
  // The capsule's own switch, re-applied against the Host's answer for the same
  // stale-mirror reason documented above. `undefined` (no field / error
  // document) leaves the gate's scope-based decision in charge.
  if (hostComposerCreditsShownOf(usage) === false) return null

  const signedIn = usage?.status === 'signed-in' ? usage : undefined
  const total = signedIn === undefined ? undefined : creditsOf(signedIn)
  const signedOut = usage !== undefined && usage.status === 'signed-out'
  const valueText = total === undefined ? '—' : formatCredits(total)
  const label = t(activeRegion === 'cn' ? 'composer.pointsCn' : 'composer.pointsGlobal')

  // The "· N 新模型" segment: which ids of this region's roster THIS machine
  // first saw inside the new-model window, as names. Rendered ONLY when
  // non-empty — a permanently-on "0 新模型" is background noise, and the value
  // is entirely in the rounds where there is something to say.
  const newModelIds = newModelIdsOf(usage)
  const newModelNames = newModelIds.map(id => modelNameOf(signedIn?.models ?? [], id))
  // The trigger's hover answer: the first few names, then an ellipsis. Names,
  // not ids, because the count in the pill is a number and this is the one place
  // a reader can learn WHICH.
  const newModelTooltip = newModelNames.length === 0
    ? undefined
    : `${t('composer.newModelsTitle')}${newModelNames.slice(0, 3).join(t('composer.newModelsSep'))}${newModelNames.length > 3 ? '…' : ''}`
  // Present only when the on-disk first-sighting history is in a version this
  // build cannot read, so "no new models" is never the story for a file that was
  // simply not read.
  const rosterSeenNote = signedIn?.rosterSeenVersionNote

  /**
   * The table's rows: every account in this region, with its balance.
   *
   * The endpoint's answer is authoritative (it carries the figures). Before it
   * lands — or if it fails — fall back to the usage document's account list so
   * the switches are reachable immediately, showing `—` for the figure rather
   * than a spinner the user has to wait on.
   */
  const selectedId = accountCredits?.find(account => account.selected)?.id
    ?? (signedIn === undefined ? undefined : signedIn.accountId)
  const sourceRows: WorkBuddyWebAccountCredit[] = accountCredits
    ?? (signedIn === undefined
      ? []
      : signedIn.accounts.map(account => ({
          id: account.id,
          accountName: account.accountName,
          selected: account.selected,
        })))
  const rows: WorkBuddyWebAccountCredit[] = sourceRows.map(row => {
    // The selected account's balance is already in the usage document the
    // readout rendered, so fall back to it when the table request carried no
    // figure. Without this the row could show "—" while the trigger on the same
    // screen shows the number for the very same account — two answers to one
    // question.
    if (row.id !== selectedId || row.credits !== undefined || total === undefined) return row
    return { ...row, credits: total }
  })
  const canSwitch = settingsScope !== undefined && settingsScope.getSnapshot().writable === true
  // Follow the same manual priority order the pool card shows. Read straight
  // from the settings snapshot rather than through a new prop: the order is
  // already persisted there, and threading it through the slot registration
  // would give the two surfaces independent sources — which is exactly how they
  // drifted apart. `getSnapshot()` is called at render time so a save made in
  // the pool card is picked up the next time this panel renders.
  //
  // The pool DOCUMENT wins when it carries an order, because that is the very
  // field the card sorts by. Reading the settings snapshot alone would let the
  // two lists disagree during the window where a save has reached the Host but
  // not the settings scope (and forever, on a Host that never reports it).
  // The settings scope stays as the fallback: it is all an older Host provides.
  const poolOrder = usage?.status === 'signed-in' ? usage.pool?.orderAccountIds : undefined
  const manualOrder = poolOrder !== undefined && poolOrder.length > 0
    ? poolOrder
    : settingsScope === undefined
      ? []
      : readOrderAccountIds(settingsScope.getSnapshot().value, activeRegion)
  const orderedRows = applyManualOrder(rows, manualOrder)
  // Keyed by account id, from the SAME document the pool card renders. Absent
  // when this Host has no pool support, in which case the credits row's own
  // `excludedBy` is all there is to go on.
  const poolById = new Map(
    (usage?.status === 'signed-in' ? usage.pool?.accounts ?? [] : []).map(account => [account.accountId, account]),
  )

  return (
    <span ref={rootRef} className="dsm-workbuddy-composer-credits">
      <button
        type="button"
        className="dsm-workbuddy-composer-credits-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        {label} · {valueText}
      </button>
      {newModelNames.length === 0
        ? null
        : (
          <button
            type="button"
            className="dsm-workbuddy-composer-credits-new"
            aria-haspopup="dialog"
            aria-expanded={open}
            title={newModelTooltip}
            onClick={() => { setRevealed(true); setOpen(true) }}
          >
            · {newModelNames.length} {t('composer.newModels')}
          </button>
        )}
      {open && createPortal(
        <div
          ref={panelRef}
          className="dsm-workbuddy-composer-panel"
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('composer.panelTitle')}
        >
          <div className="dsm-workbuddy-composer-panel-head">
            <span className="dsm-workbuddy-composer-panel-title">
              {t(activeRegion === 'cn' ? 'composer.panelTitleCn' : 'composer.panelTitleGlobal')}
            </span>
            <button
              type="button"
              className="dsm-workbuddy-composer-panel-refresh"
              // Testing is what this button does now, so a running batch is its
              // own disabled state; a credits read still blocks it too, because
              // the two write the same table.
              disabled={busy || testing || switchingId !== undefined}
              title={t('composer.testAllHint')}
              onClick={() => { void testEveryAccount() }}
            >
              {testing ? t('composer.testing') : t('composer.testAll')}
            </button>
          </div>
          {signedOut
            ? <p className="dsm-workbuddy-composer-panel-empty">{t('composer.signedOut')}</p>
            : rows.length === 0
              ? <p className="dsm-workbuddy-composer-panel-empty">{t('composer.noAccounts')}</p>
              : (
                <table className="dsm-workbuddy-composer-panel-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('composer.account')}</th>
                      <th scope="col" className="dsm-workbuddy-composer-panel-num">{t('composer.credits')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderedRows.map(row => {
                      const current = row.id === selectedId
                      // Availability comes from the POOL document, when this
                      // session has one. That is the same array the pool card
                      // renders, so the dot and the wording below are derived
                      // from one object rather than two readings of one fact.
                      // The credits endpoint's own `excludedBy` is the fallback
                      // for a Host without pool support.
                      const poolRow = poolById.get(row.id)
                      // "Which row is live?" comes from the SAME document as the
                      // state, when that document exists: the pool card marks its
                      // current row from `pool.accounts[].current`, and reading the
                      // credits endpoint's `selected` flag instead would let the
                      // green dot and the highlighted card row point at two
                      // different accounts. `current` (the selected-id form) stays
                      // for the switch button, which must agree with what the
                      // credits endpoint reports it can switch from.
                      //
                      // PREFERRED, not merged: when the two disagree the pool
                      // document wins, because it is the object the state beside
                      // the dot came from. OR-ing them would mark two rows live at
                      // once — which is how a "which one is in use?" question gets
                      // a wrong answer at exactly the moment it matters.
                      //
                      // AND `live` IS WHAT PAINTS THE ROW. The row highlight and
                      // the switch button used `current` while the text used
                      // `live`, so the two could visibly disagree: with the pool
                      // rotating, the highlight sat on the serving account and
                      // 「当前选用」 on the saved one (reported). One question, one
                      // answer — everything on this row reads `live`; `current`
                      // survives only where it is genuinely about the OTHER
                      // question (which account this endpoint reports it can
                      // switch FROM), i.e. the button's disabled state.
                      const live = poolRow === undefined ? current : poolRow.current
                      const availability = poolRow ?? {
                        excludedBy: row.excludedBy,
                        probe: undefined,
                      }
                      // Why this account cannot serve right now, in the same
                      // WHAT the row prints, and what it only whispers.
                      //
                      // Printed: the reason and the wait — "被限流 · 约 6 小时后".
                      // The absolute instant used to be printed here too, between
                      // the two, and the owner asked for it to go: at that width
                      // the line read as a log entry ("被限流 · 10/19, 01:32 之后
                      // 可再用 · 约 6 小时后") next to a column that is only trying
                      // to show a balance, and the date was the part nobody needed
                      // to act on.
                      //
                      // Kept, not deleted: the row's `title` still carries the
                      // full sentence from `availabilityLine` — absolute instant
                      // included — so hovering still answers "when exactly". The
                      // dot alone could not: it is aria-hidden, and a colour is
                      // not a reason.
                      const usable = stateTone(availability) === 'ok'
                      // Printed: "当前选用" for the selected row, and/or the reason
                      // it cannot serve, in the short form ("被限流 · 约 6 小时后").
                      //
                      // TWO spans, not one line: these two facts are different
                      // kinds of message and the owner asked for the selection to
                      // be green. In one span both inherited the mark's amber, so
                      // "当前选用" — a statement of fact, not a problem — was
                      // painted in the problem colour. Each gets its own class
                      // and its own tone; the separator is drawn in CSS so the
                      // plain-text reading of the line is unchanged.
                      const currentMark = live ? t('composer.current') : undefined
                      const reasonMark = usable ? undefined : availabilityMark(t, availability)
                      // Whispered: the same facts with the absolute instant, so
                      // hovering still answers "when exactly" and a screen reader
                      // on the row header hears the whole sentence.
                      const spoken = detailLine(
                        live ? t('composer.current') : undefined,
                        usable ? undefined : availabilityLine(t, availability),
                      )
                      const whoLabel = spoken === undefined
                        ? row.accountName
                        : `${row.accountName} — ${spoken}`
                      return (
                        <tr
                          key={row.id}
                          className={live ? 'dsm-workbuddy-composer-panel-row-current' : undefined}
                          title={spoken}
                        >
                          <th scope="row" aria-label={whoLabel}>
                            <button
                              type="button"
                              className="dsm-workbuddy-composer-panel-switch"
                              disabled={!canSwitch || switchingId !== undefined || live}
                              aria-label={t('composer.switchTo', { account: row.accountName })}
                              onClick={() => { void switchTo(row.id) }}
                            >
                              <span className={dotClass(availability)} aria-hidden="true" />
                              <span className="dsm-workbuddy-composer-panel-who">
                                <span className="dsm-workbuddy-composer-panel-name">{row.accountName}</span>
                                {currentMark === undefined && reasonMark === undefined
                                  ? null
                                  : (
                                      <span className="dsm-workbuddy-composer-panel-mark">
                                        {currentMark === undefined
                                          ? null
                                          : <span className="dsm-workbuddy-composer-panel-mark-current">{currentMark}</span>}
                                        {reasonMark === undefined
                                          ? null
                                          : <span className="dsm-workbuddy-composer-panel-mark-reason">{reasonMark}</span>}
                                      </span>
                                    )}
                              </span>
                            </button>
                          </th>
                          <td className="dsm-workbuddy-composer-panel-num">
                            {row.credits === undefined ? '—' : formatCredits(row.credits)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
          <div className="dsm-workbuddy-composer-panel-foot">
            <span>
              {t('composer.lastRefresh')} {lastRefresh === undefined ? '—' : formatClock(lastRefresh)}
            </span>
          </div>
          {newModelNames.length === 0 && rosterSeenNote === undefined
            ? null
            : (
                <div className="dsm-workbuddy-composer-panel-new">
                  {newModelNames.length === 0
                    ? null
                    : (
                        <>
                          <p
                            ref={newRowRef}
                            tabIndex={-1}
                            aria-label={`${t('composer.newModelsTitle')}${newModelNames.join(t('composer.newModelsSep'))}`}
                            className={revealed
                              ? 'dsm-workbuddy-composer-panel-new-row dsm-workbuddy-composer-panel-new-row-revealed'
                              : 'dsm-workbuddy-composer-panel-new-row'}
                          >
                            <span className="dsm-workbuddy-composer-panel-new-label">{t('composer.newModelsRow')}</span>
                            <span className="dsm-workbuddy-composer-panel-new-list">{newModelNames.join(t('composer.newModelsSep'))}</span>
                          </p>
                          <p className="dsm-workbuddy-composer-panel-note">{t('composer.newModelsNote')}</p>
                        </>
                      )}
                  {rosterSeenNote === undefined ? null : <p className="dsm-workbuddy-composer-panel-note">{rosterSeenNote}</p>}
                </div>
              )}
          {failed ? <p className="dsm-workbuddy-composer-panel-error" role="status">{t('composer.refreshFailed')}</p> : null}
          {testError === undefined
            ? null
            : <p className="dsm-workbuddy-composer-panel-error" role="status">{testError}</p>}
        </div>,
        document.body,
      )}
    </span>
  )
}
