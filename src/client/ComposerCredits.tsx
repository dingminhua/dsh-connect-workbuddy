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
import {
  WORKBUDDY_ACCOUNT_CREDITS_PATH,
  WORKBUDDY_USAGE_PATH,
  withWorkBuddyRegion,
} from '../status-paths.ts'
import { writeAccountSlot } from './account-selection.ts'
import { exclusionText } from './exclusion-text.ts'
import { WORKBUDDY_COMPOSER_CSS } from './styles.ts'
import type { WorkBuddyWebAccountCredit, WorkBuddyWebRegion, WorkBuddyWebUsage } from '../status-paths.ts'
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
 * Automatic refresh period. Five minutes, matching a credit balance's actual
 * rate of change: it moves on the scale of model calls, not seconds, and each
 * read is a read-only upstream call.
 */
export const COMPOSER_CREDITS_REFRESH_INTERVAL_MS = 300_000

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

/** Group the digits so a four-figure balance stays readable in a narrow row. */
function formatCredits(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function formatClock(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function ComposerCredits(props: ComposerCreditsProps) {
  const { t, provider, region, settingsScope } = props
  if (t === undefined) throw new Error('Composer credits readout requires its translation function')
  const owned = provider === undefined ? undefined : WORKBUDDY_COMPOSER_PROVIDERS[provider]
  const activeRegion = region ?? owned

  const [usage, setUsage] = useState<WorkBuddyWebUsage | undefined>(undefined)
  const [accountCredits, setAccountCredits] = useState<WorkBuddyWebAccountCredit[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

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
   */
  const fetchAccountCredits = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (activeRegion === undefined) return
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_ACCOUNT_CREDITS_PATH, activeRegion), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as { accounts?: unknown }
      if (!mounted.current || signal?.aborted === true) return
      if (Array.isArray(data.accounts)) setAccountCredits(data.accounts as WorkBuddyWebAccountCredit[])
    } catch {
      // Keep the previous rows; see above.
    }
  }, [activeRegion])

  // Fetch usage on mount and whenever the region changes, then keep it fresh.
  // The timer starts only after the first fetch settles, so a slow upstream
  // cannot stack overlapping reads.
  useEffect(() => {
    if (owned === undefined) return undefined
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
  }, [owned, fetchUsage])

  // Per-account figures are read on OPEN, not on the 5-minute cycle.
  useEffect(() => {
    if (!open || activeRegion === undefined) return undefined
    const controller = new AbortController()
    void fetchAccountCredits(controller.signal)
    return () => { controller.abort() }
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
      await fetchAccountCredits()
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) setSwitchingId(undefined)
    }
  }

  // Not this plugin's model: render nothing at all, so the composer row is
  // untouched while another provider is in use.
  //
  // The gate already filters, so in the shipped wiring this branch never fires.
  // It stays because this is a public component: a caller that forgets to check
  // must not get a WorkBuddy balance rendered next to another provider's model.
  if (owned === undefined) return null

  const signedIn = usage?.status === 'signed-in' ? usage : undefined
  const total = signedIn === undefined ? undefined : creditsOf(signedIn)
  const signedOut = usage !== undefined && usage.status === 'signed-out'
  const valueText = total === undefined ? '—' : formatCredits(total)
  const label = t(activeRegion === 'cn' ? 'composer.pointsCn' : 'composer.pointsGlobal')

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
              disabled={busy || switchingId !== undefined}
              onClick={() => { void fetchUsage() }}
            >
              {busy ? t('composer.refreshing') : t('composer.refresh')}
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
                    {rows.map(row => {
                      const current = row.id === selectedId
                      // Why this account cannot serve right now, in the same
                      // words the pool table uses. Shown so the user can see,
                      // BEFORE switching, that a row is rate-limited — a table
                      // that presents an exhausted account as an equally good
                      // choice is worse than no table.
                      const excluded = exclusionText(t, row.excludedBy)
                      return (
                        <tr
                          key={row.id}
                          className={current ? 'dsm-workbuddy-composer-panel-row-current' : undefined}
                        >
                          <th scope="row">
                            <button
                              type="button"
                              className="dsm-workbuddy-composer-panel-switch"
                              disabled={!canSwitch || switchingId !== undefined || current}
                              aria-label={t('composer.switchTo', { account: row.accountName })}
                              onClick={() => { void switchTo(row.id) }}
                            >
                              <span className="dsm-workbuddy-composer-panel-dot" aria-hidden="true" />
                              {/* The name and the optional mark share one
                                  column so the mark sits ON ITS OWN LINE under
                                  the name rather than widening the row: the
                                  number column must stay purely numeric, and a
                                  long name beside a label would push it out. */}
                              <span className="dsm-workbuddy-composer-panel-who">
                                <span className="dsm-workbuddy-composer-panel-name">{row.accountName}</span>
                                {excluded === undefined
                                  ? null
                                  : <span className="dsm-workbuddy-composer-panel-mark">{excluded}</span>}
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
          {failed ? <p className="dsm-workbuddy-composer-panel-error" role="status">{t('composer.refreshFailed')}</p> : null}
        </div>,
        document.body,
      )}
    </span>
  )
}
