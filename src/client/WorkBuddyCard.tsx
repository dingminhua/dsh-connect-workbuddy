/**
 * WorkBuddy credits & models card contributed to Harness Plugin configuration.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 卡片的整体结构（折叠外壳 / 账号状态行 / 账号下拉 / 积分区 / 模型表 /
 *     操作按钮行）、模块加载时注入一次 `<style>` 的写法、
 *     草稿态（draftModels/draftEnabledIds）与 dirty 标记的保存流程、
 *     60 秒轮询与 AbortController 清理，均来自该项目的 TraeUsageCard。
 *   折叠卡片外壳与 `settings.plugin.item` 槽位形态来自
 *   dingminhua/dsh-subagent-default-model（MIT）。
 * 改动：
 *   0. 折叠箭头改用纯 CSS caret（理由见 styles.ts）：两版宿主的图标命名族
 *      不同，静态导入必挂一边。此前沿用的 `IconChevronDownOutline14` 已
 *      随该改动移除，故不再计入上方参考项。
 *   1. 积分区改为「合计 + 按套餐名聚合的进度条」，因为实测单个账号下
 *      同名套餐可达 19 个，逐条渲染会淹没卡片（原项目按上游条目直出）；
 *   2. 模型行补上 WorkBuddy 上游给出的积分倍率、多模态与推理档位；
 *   3. 移除与 WorkBuddy 上游无关的 1M 变体勾选；
 *   4. 双 provider 化后卡片顶部为「国内版 / 国际版」tab 栏 —— 每个 tab
 *      是一个独立供应商（workbuddy / workbuddy-global），账号、积分、
 *      模型目录与草稿完全按区域隔离，切 tab 不丢另一侧未保存的草稿。
 *
 * @module dsh-connect-workbuddy/client/WorkBuddyCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  nextRegionEnabled,
  regionEnabledOf,
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_REGIONS,
  WORKBUDDY_USAGE_PATH,
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
} from '../status-paths.ts'
import type {
  WorkBuddyWebModel,
  WorkBuddyWebProbeResult,
  WorkBuddyWebRegion,
  WorkBuddyWebSearchPath,
  WorkBuddyWebUsage,
} from '../status-paths.ts'
import { writeAccountSlot, writeRegionEnabled, writeRegionModels } from './account-selection.ts'
import { AccountPool } from './AccountPool.tsx'
// `createLatestWins` is the same tested latest-wins factory the Host uses for
// rotation, imported rather than re-implemented: the rule has one definition
// and one set of tests.
import { createLatestWins } from '../account-pool.ts'
import { imageDefaultFor, nativeModalityOf } from '../native-modality.ts'
import { WORKBUDDY_PLUGIN_ICON } from './icon.ts'
import { WORKBUDDY_CARD_CSS } from './styles.ts'
import { searchReasonLabel, searchedView, signedOutNotice, signedOutText } from './searched-paths.ts'
import type { Translate } from './searched-paths.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyCardInjected {
  t: Translate
  /**
   * Optional by design: a host line that provides neither settings surface
   * (or a probe before the mirror populates) leaves this undefined, and the
   * card renders read-only — saving is the only capability that needs it.
   */
  settingsScope?: {
    getSnapshot(): { status: string; value?: unknown; writable: boolean }
    subscribe(listener: () => void): () => void
    /** Whether the Host accepted the write (0.1.7); `void` on the 0.1.5 line. */
    set(field: string, value: unknown): Promise<boolean | void>
  }
}

/**
 * Props delivered by the Plugin configuration slot.
 *
 * The slot keys this card registers against (`plugins.bundle.config` /
 * `plugins.row.config`) are not enumerated in the 0.1.7 `SlotMap` types —
 * they exist at runtime, but the shipped type table does not list them — so
 * the props are typed from the injected surface rather than
 * `PropsRuntime<'…'>`. The card also receives the host's `view`
 * ('summary' | 'page').
 */
export type WorkBuddyCardProps =
  Partial<WorkBuddyCardInjected>
  & { view?: string }

const POLL_INTERVAL_MS = 60_000
const WORKBUDDY_GITHUB_URL = 'https://github.com/dingminhua/dsh-connect-workbuddy'

/**
 * Tooltip for one model's image checkbox. The box is pre-checked only for
 * models the vendored vendor table documents as natively multimodal, so the
 * two other outcomes need to say WHY they are off — otherwise a documented
 * text-only model and an unverified one look identically broken next to their
 * checked siblings.
 */
function imageCheckboxHint(model: { id: string }, t: Translate): string {
  switch (nativeModalityOf(model.id)) {
    case 'multimodal': return t('row.modelImage')
    case 'text': return t('row.modelImageText')
    default: return t('row.modelImageUnverified')
  }
}

/** One region's unsaved model edits; switching tabs never drops these. */
interface WorkBuddyDraft {
  models: WorkBuddyWebModel[]
  enabledIds: Set<string>
  imageIds: Set<string>
  contextBudgets: Record<string, number>
}

/** Inject or refresh the shared card CSS for the current client bundle. */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-workbuddy/client.css'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    existing.textContent = WORKBUDDY_CARD_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-workbuddy'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = WORKBUDDY_CARD_CSS
    document.head.appendChild(styleTag)
  }
}

/**
 * One probed path, with its cause. The presentation rules — which entries are
 * worth showing up front, and how a reason is labelled — live in
 * `./searched-paths.ts` so they are unit-testable without a DOM.
 */
function renderSearchedItem(
  item: WorkBuddyWebSearchPath,
  t: Translate,
): ReactElement {
  return (
    <li key={`${item.source}:${item.path}`}>
      <code>{item.path}</code>
      <span className={`dsm-workbuddy-searched-reason${item.reason === 'encrypted' ? ' dsm-workbuddy-searched-reason-encrypted' : item.reason === 'wrong-region' ? ' dsm-workbuddy-searched-reason-wrong-region' : ''}`}>
        {searchReasonLabel(item, t)}
        {item.message === undefined ? null : ` · ${item.message}`}
      </span>
    </li>
  )
}

/**
 * The probed-path list behind a signed-out card.
 *
 * Collapsed by default because it is a diagnostic, not a headline. The
 * interesting failures (encrypted / invalid / unreadable) are listed up front;
 * the merely-absent candidates — most of them, on any normal machine — sit
 * behind a second toggle, so the one entry that explains the failure is not
 * buried under a dozen "not found" lines. When nothing interesting was found
 * the absent list IS the explanation, so it opens directly.
 *
 * An `encrypted` failure deliberately adds NO notice of its own. It used to,
 * because the paragraph above still said "sign in once in the desktop app" —
 * the one action that cannot work when the credential exists but is encrypted.
 * `signedOutNotice` now answers that cause in the paragraph itself, so a second
 * copy here would restate it: the paragraph states the situation, this list
 * supplies the detail, and the per-entry label already says what each path is.
 */
function SearchedPaths(
  { items, t }: { items: readonly WorkBuddyWebSearchPath[], t: Translate },
): ReactElement {
  const view = searchedView(items)
  // Only an explicit click is remembered. Initializing state from the derived
  // value instead would freeze the first answer: this card re-probes every 60
  // seconds, so a machine that first reported only absent paths and later
  // reported an encrypted file would keep the findings hidden.
  const [explicitOpen, setExplicitOpen] = useState<boolean | undefined>(undefined)
  const showMissing = explicitOpen ?? view.missingOpen
  return (
    <details className="dsm-workbuddy-searched">
      <summary>{t('row.searchedTitle')} ({view.total})</summary>
      <p className="dsm-workbuddy-searched-hint">{t('row.searchedHint')}</p>
      <ul className="dsm-workbuddy-searched-list">
        {view.interesting.map(item => renderSearchedItem(item, t))}
        {showMissing ? view.missing.map(item => renderSearchedItem(item, t)) : null}
      </ul>
      {showMissing || view.missing.length === 0
        ? null
        : <button
          type="button"
          className="dsm-workbuddy-searched-more"
          onClick={() => { setExplicitOpen(true) }}
        >
          {t('row.searchedMore', { count: view.missing.length })}
        </button>}
    </details>
  )
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

/**
 * Compact package-date rendering with time, e.g. `08/25 14:44`.
 *
 * `hourCycle: 'h23'` is what makes that example TRUE. Without it `Intl` defers
 * to the browser locale, and en-US produced `08/25, 02:44 PM` — 12-hour, with a
 * comma the template never asked for. `h23` (not `hour12: false`) keeps midnight
 * at `00:00` instead of `24:00`, and matches DSH's own clock cycle.
 */
function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

function formatCapacity(value: number | undefined, unknown: string): string {
  if (value === undefined) return unknown
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return formatNumber(value)
}

function dotStyle(status: WorkBuddyWebUsage['status']): Record<string, string> {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { background: color }
}

/**
 * The sentence a probe result gets, and how it should be coloured.
 *
 * The cooldown wording is the part that had to be got right. The upstream names
 * a "use again" time in three situations: a `Retry-After` header, the reset
 * sentence it writes into its own failure BODY (where this service actually
 * puts it — its 429s carry no rate-limit header at all), or an exhausted
 * monthly quota whose refresh point it declares. So a limited result WITHOUT
 * any stated time must say that plainly. Substituting a locally invented
 * countdown would be the single most misleading thing this feature could do: it
 * would look like an upstream answer while being a guess, and the user would
 * wait for a moment that means nothing.
 */
function probeResultView(
  result: WorkBuddyWebProbeResult,
  t: Translate,
): { text: string, tone: 'ok' | 'warn' | 'bad' } {
  switch (result.outcome) {
    case 'ok': {
      const elapsed = result.elapsedMs === undefined ? undefined : `${String(result.elapsedMs / 1000)}s`
      return {
        text: elapsed === undefined ? t('row.probeOk') : t('row.probeOkMs', { ms: elapsed }),
        tone: 'ok',
      }
    }
    case 'rate-limited':
      return {
        text: result.retryAtMs === undefined
          ? t('row.probeRateLimitedUnknown')
          : t('row.probeRateLimitedAt', { at: formatDate(result.retryAtMs) }),
        tone: 'warn',
      }
    case 'out-of-credit':
      // Only a quota-reset answer is a real time; without one, the honest text
      // is the same "no time given" the rate-limit branch uses.
      return {
        text: result.retryAtMs === undefined
          ? t('row.probeOutOfCreditUnknown')
          : t('row.probeOutOfCreditAt', { at: formatDate(result.retryAtMs) }),
        tone: 'bad',
      }
    case 'credential-rejected': return { text: t('row.probeCredentialRejected'), tone: 'bad' }
    case 'not-found': return { text: t('row.probeNotFound'), tone: 'bad' }
    case 'unavailable': return { text: t('row.probeUnavailable'), tone: 'bad' }
    default:
      return {
        text: result.status === undefined
          ? t('row.probeFailed')
          : t('row.probeFailedStatus', { status: String(result.status) }),
        tone: 'bad',
      }
  }
}

/** Render WorkBuddy sign-in state, credits, and model selection as one card. */
export function WorkBuddyCard({ t, settingsScope, view }: WorkBuddyCardProps & { view?: string }) {
  if (t === undefined) throw new Error('WorkBuddy plugin card requires its translation function')
  const [open, setOpen] = useState(view === 'page')
  /** The region whose tab is on screen; each tab is its own provider stack. */
  const [activeRegion, setActiveRegion] = useState<WorkBuddyWebRegion>('cn')
  /**
   * Last-known usage per region, so tab dots survive tab switches.
   *
   * The placeholder carries `selectionExplicit: false` because that is the
   * state the plugin documents as the default before any choice is saved. It
   * is never rendered: the account picker and its state line only appear once
   * a real fetch has populated `accounts`.
   */
  const [statusByRegion, setStatusByRegion] = useState<Partial<Record<WorkBuddyWebRegion, WorkBuddyWebUsage>>>({
    cn: { status: 'signed-out', accounts: [], selectionExplicit: false },
    global: { status: 'signed-out', accounts: [], selectionExplicit: false },
  })
  const [busy, setBusy] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  /** Per-region unsaved model edits; a draft on one tab is never dropped by
   * switching to the other tab, only by that tab's discard/save. */
  const [drafts, setDrafts] = useState<Partial<Record<WorkBuddyWebRegion, WorkBuddyDraft>>>({})
  const [saving, setSaving] = useState(false)
  /** Save failure surfaced next to the buttons; cleared by the next attempt. */
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [switchingAccount, setSwitchingAccount] = useState(false)
  /**
   * Whether the account pool's rotation currently owns this region's choice.
   *
   * Reported up by the pool section. While true, the manual account dropdown is
   * disabled: both would write the same slot, and letting them disagree is how
   * the card ends up showing one account while another is billed. The pool
   * shows the reason and an inline way to switch rotation off.
   */
  const [poolRotationLocked, setPoolRotationLocked] = useState(false)
  /**
   * Whether the account pool's save is in flight. Both sections write into one
   * region slot and the Host merges per-region, so two concurrent saves can
   * interleave on a stale base and revert each other while both report success
   * — the two save buttons are serialized to make that impossible.
   */
  const [poolBusy, setPoolBusy] = useState(false)
  /** A refused account write (silently unpersisted settings on a locked file). */
  const [accountError, setAccountError] = useState<string | undefined>(undefined)
  const [checkingIn, setCheckingIn] = useState(false)
  const [checkinActionError, setCheckinActionError] = useState<string | undefined>(undefined)
  /** Region whose on/off checkbox write is in flight, so its box can't race. */
  const [togglingRegion, setTogglingRegion] = useState<WorkBuddyWebRegion | undefined>(undefined)
  /**
   * Probe results, keyed by region then model id.
   *
   * Kept per region for the same reason drafts are: the two tabs are separate
   * provider stacks, so a test run on one tab must not be clobbered — or shown —
   * as the other tab's answer.
   */
  const [probes, setProbes] = useState<Partial<Record<WorkBuddyWebRegion, Record<string, WorkBuddyWebProbeResult>>>>({})
  /** Model ids with a probe in flight, so each row's button can disable itself. */
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  /** Probe failure that is not attributable to one model (a dead route, say). */
  const [probeError, setProbeError] = useState<string | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => settingsScope?.subscribe(() => { setSettingsRevision(value => value + 1) }), [settingsScope])

  /**
   * Per-region latest-wins guard for the usage fetch.
   *
   * Two refreshes can overlap — the 60s poll, a save, a batch action, the
   * account re-scan — and they are plain `fetch`es with no ordering guarantee.
   * Without a guard the SLOWER response wins, so a snapshot taken before a
   * check-in could land after one taken after it and overwrite the newer
   * credits. The guard makes "the last request started" the one that is applied,
   * whatever order the responses arrive in.
   *
   * Keyed by region, not global: the card deliberately fetches BOTH regions at
   * once (`for (const region of WORKBUDDY_REGIONS)` below), so a single shared
   * counter would make each of those two calls cancel the other and leave one
   * tab permanently stale.
   *
   * The rule itself is the tested `createLatestWins` factory, not a second
   * implementation written here.
   *
   * `begin()` returns a probe that reports **stale**: `true` once a newer call
   * has claimed the same region (see `src/account-pool.ts`). So the variable is
   * named `stale` and the bail-out is `if (stale())` — the same polarity as the
   * Host's rotation guard in `src/index.ts`. Naming it `fresh` and writing
   * `if (!fresh())` inverts the poll: every response that is NOT superseded —
   * i.e. every response in the single-fetch case — gets discarded, and the card
   * renders its placeholder forever. That defect shipped once; the polarity is
   * now pinned by a rendered assertion rather than by the spelling of the
   * identifier.
   */
  const usageGuard = useRef(createLatestWins<WorkBuddyWebRegion>())

  const refreshUsage = useCallback(async (
    region: WorkBuddyWebRegion,
    signal?: AbortSignal,
  ): Promise<WorkBuddyWebUsage | undefined> => {
    // Claimed BEFORE the fetch: any request that starts later supersedes this
    // one, even if this one's response arrives after it.
    const stale = usageGuard.current.begin(region)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_USAGE_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const usage = value as WorkBuddyWebUsage
      // Superseded while in flight: applying now would clobber a newer snapshot.
      if (stale()) return undefined
      if (mounted.current && signal?.aborted !== true) {
        setStatusByRegion(prev => ({ ...prev, [region]: usage }))
      }
      return usage
    } catch (error: unknown) {
      // The error path is guarded too: a stale failure would otherwise replace
      // a newer successful snapshot with an error banner.
      if (stale()) return undefined
      if (mounted.current && signal?.aborted !== true) {
        const message = error instanceof Error ? error.message : t('row.requestFailed')
        // Do NOT collapse the region into the union's `{ status: 'error' }`
        // variant when we already have data. That variant carries NO fields —
        // no `accounts`, `pool`, `credits` or `models` — and the whole panel
        // body is gated on `status === 'signed-in'`, so replacing a healthy
        // snapshot with it blanks the account picker, the credits panel, the
        // model directory AND the account pool because one refresh failed. A
        // user midway through editing pool settings would watch their panel
        // vanish after pressing Save, which reads as data loss.
        //
        // Keeping the last good snapshot with a `refreshError` overlay shows
        // the same information the failure would have hidden, plus the reason —
        // the pattern `creditsError` and `checkinError` already use per section.
        setStatusByRegion(prev => {
          const previous = prev[region]
          if (previous !== undefined && previous.status === 'signed-in') {
            return { ...prev, [region]: { ...previous, refreshError: message } }
          }
          // Nothing to preserve: this region never loaded, so the bare error
          // state is the honest answer (it drives the sign-in guidance).
          return { ...prev, [region]: { status: 'error', message } }
        })
      }
      return undefined
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    // BOTH regions, not just the active tab: both switches are always rendered
    // in the tab bar, and the Host is where `regionOn` reads their state from.
    // Fetching only the active region left the other switch on the mirror
    // fallback until its tab was clicked — which is exactly the stale source
    // this card is trying to stop trusting.
    for (const region of WORKBUDDY_REGIONS) {
      void refreshUsage(region, controller.signal)
    }
    return () => { controller.abort() }
  }, [open, activeRegion, refreshUsage])

  const status: WorkBuddyWebUsage = statusByRegion[activeRegion]
    ?? { status: 'signed-out', accounts: [], selectionExplicit: false }

  useEffect(() => {
    if (!open || status.status !== 'signed-in') return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refreshUsage(activeRegion, controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, activeRegion, refreshUsage, status.status])

  /**
   * Re-detect the local sign-ins and refresh the panel.
   *
   * This deliberately writes NO account selection. It used to persist whatever
   * row the store reported as "selected" whenever that differed from the saved
   * value, which had two harmful effects: with no explicit choice it turned the
   * documented default (follow the app's current sign-in) into a permanent
   * explicit binding — so a later sign-in in the app was no longer followed —
   * and with an orphaned saved id it silently re-bound the region to a
   * different account, which is the silent switch that the strict
   * no-fallback rule exists to prevent. Re-detecting and re-picking are
   * separate actions now; the picker and Clear button own the selection.
   */
  const rescanAccounts = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_ACCOUNTS_REFRESH_PATH, activeRegion), {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      const body = await response.json() as { accounts?: { id: string }[] }
      if (!response.ok || !Array.isArray(body.accounts)) throw new Error(`HTTP ${response.status}`)
      await refreshUsage(activeRegion)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const switchAccount = async (accountId: string): Promise<void> => {
    if (settingsScope === undefined) return
    setSwitchingAccount(true)
    setAccountError(undefined)
    try {
      // Verified write: `set()` resolving does not prove the value was stored
      // (see `writeAccountSlot`), and a silently dropped switch would leave the
      // picker showing one account while another one serves.
      await writeAccountSlot(settingsScope, activeRegion, accountId)
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setSwitchingAccount(false)
    }
  }

  /**
   * Whether one region's provider is switched on.
   *
   * The HOST's answer wins, because on this deployment it is the only writer
   * that lands: the switch goes through the plugin's Host save endpoint (that
   * endpoint is the only writer that cannot drop the sibling region), and a
   * write made there does NOT update the browser settings mirror. Reading the
   * mirror therefore left the checkbox stuck ON after a successful disable —
   * "不能正确取消国际版/国内版" — even though `enabled: false` was already in
   * the profile configuration. The Host sends the committed value it derives
   * from its own config (`status.enabled`, see `deps.regionEnabled`), so the
   * card renders that.
   *
   * The mirror stays as the FALLBACK: a host that predates the field, or a
   * status that has not loaded yet, still renders from the stored document
   * rather than guessing. Both rules are the same opt-out rule (only an
   * explicit `false` disables), so the two sources cannot disagree — only one
   * of them can be stale.
   */
  const regionOn = (item: WorkBuddyWebRegion): boolean => {
    // The `error` arm of the union carries no `enabled` in its TYPE (the Host
    // still fills it at runtime), so the field is read through a narrow probe
    // rather than widening the union for one consumer.
    const usage = statusByRegion[item] as { enabled?: unknown } | undefined
    const fromHost = usage?.enabled
    if (typeof fromHost === 'boolean') return fromHost
    return regionEnabledOf(settingsScope?.getSnapshot().value, item)
  }
  const activeRegionOn = regionOn(activeRegion)

  /**
   * Switch one region's provider off or on. The write carries the region's
   * whole slot through untouched — only `enabled` changes — so the user's
   * directory, model picks, image opt-ins and budgets survive a round trip.
   * The Host withdraws or restores the provider route on the next `onChange`,
   * which is what actually removes it from DSH's model picker.
   *
   * Goes through `writeRegionEnabled` rather than calling `scope.set()`
   * directly: on the affected 0.1.7 deployments that scope settles without
   * storing anything, so a direct write appeared to succeed and then silently
   * reverted. The helper adds the landed-check and the Host-endpoint fallback
   * that every other settings write already had.
   */
  const toggleRegion = async (item: WorkBuddyWebRegion, enabled: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    setTogglingRegion(item)
    try {
      // `nextRegionEnabled` unwraps the settings section itself and returns the
      // bare `regions` map, which is the whole-slot merge this write starts from.
      // The mirror is only a merge base for the SLOT; the write itself lands in
      // the Host (see `writeField`), which preserves the sibling region.
      const regions = nextRegionEnabled(settingsScope.getSnapshot().value, item, enabled) as Record<string, unknown>
      const slot = regions[item]
      await writeRegionEnabled(
        settingsScope,
        item,
        enabled,
        typeof slot === 'object' && slot !== null ? slot as Record<string, unknown> : {},
      )
      // Re-read the Host so the switch renders the value that was just
      // committed. The write does not touch the browser mirror, and the Host is
      // what `regionOn` now reads, so without this refresh the checkbox keeps
      // showing its previous state and the toggle looks dead even though it
      // landed — the "不能正确取消" report.
      await refreshUsage(item)
    } catch (error: unknown) {
      // Surface the reason instead of leaving the switch silently unmoved.
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setTogglingRegion(undefined)
    }
  }

  /**
   * Claim the daily check-in reward for the active region. The action endpoint
   * is region-scoped; the response only refreshes this tab's check-in state.
   */
  const claimDailyCheckin = async (): Promise<void> => {
    setCheckingIn(true)
    setCheckinActionError(undefined)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_CHECKIN_PATH, activeRegion), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined) as { error?: string } | undefined
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setCheckinActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setCheckingIn(false)
    }
  }

  const refreshModels = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_MODELS_REFRESH_PATH, activeRegion), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json() as { models?: WorkBuddyWebModel[] }
      if (!response.ok || !Array.isArray(body.models)) throw new Error(`HTTP ${response.status}`)
      const fresh = body.models
      const freshIds = new Set(fresh.map(model => model.id))
      // Re-map the user's CURRENT enabled choices and context budgets onto the
      // fresh catalog by model id, so renames and additions never silently lose
      // them. The IMAGE checkboxes are deliberately OVERWRITTEN with the
      // VENDOR-VERIFIED default: only models documented natively multimodal are
      // pre-checked (`imageDefaultFor`). NOT the platform's `supportsImages`
      // flag — that one is true for nearly the whole roster, including
      // text-only models, so it is not a capability answer. The user can still
      // adjust the boxes before saving; only another refresh re-syncs.
      const stillEnabled = [...activeEnabledIds].filter(id => freshIds.has(id))
      const upstreamImages = fresh
        .filter(model => imageDefaultFor(model))
        .map(model => model.id)
      const stillBudgets: Record<string, number> = {}
      for (const id of freshIds) {
        const budget = activeContextBudgets[id]
        if (typeof budget === 'number') stillBudgets[id] = budget
      }
      setDrafts(prev => ({
        ...prev,
        [activeRegion]: {
          models: fresh,
          enabledIds: new Set(stillEnabled),
          imageIds: new Set(upstreamImages),
          contextBudgets: stillBudgets,
        },
      }))
    } catch (error: unknown) {
      // Same merge-not-replace rule as the usage fetch above: a failed model
      // refresh must not wipe the pool, credits and account list.
      if (mounted.current) setStatusByRegion(prev => ({
        ...prev,
        [activeRegion]: {
          ...prev[activeRegion],
          status: 'error',
          message: error instanceof Error ? error.message : t('row.requestFailed'),
        } as WorkBuddyWebUsage,
      }))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  void settingsRevision
  // The card renders the last-refreshed directory (`status.models`), never a
  // stale saved snapshot. Enabled flags come from the user's stored selection,
  // re-mapped onto the current catalog by model id.
  const draft = drafts[activeRegion]
  const visibleModels = draft?.models ?? (status.status === 'signed-in' ? status.models : [])
  const savedEnabledIds = status.status === 'signed-in' ? new Set(status.enabledModelIds) : new Set<string>()
  const activeEnabledIds = draft?.enabledIds ?? savedEnabledIds
  const savedImageIds = status.status === 'signed-in' ? new Set(status.imageModelIds) : new Set<string>()
  const activeImageIds = draft?.imageIds ?? savedImageIds
  const configured = settingsScope?.getSnapshot().value
  // Context budgets come from the Host's own answer, NOT from the browser
  // settings mirror. On the affected 0.1.7 deployment that mirror never picks
  // up this plugin's writes (a save made through the Host endpoint leaves it
  // stale), so reading it here made a successful save look like it reverted —
  // the "save did nothing" report.
  const savedContextBudgets = status.status === 'signed-in' ? (status.contextBudgets ?? {}) : {}
  void configured
  void settingsRevision
  const activeContextBudgets = draft?.contextBudgets ?? savedContextBudgets
  const dirty = draft !== undefined
  /**
   * Whether the card's inputs accept edits.
   *
   * Deliberately NOT the settings scope's own `writable` flag: on the affected
   * DSH 0.1.7 deployment that flag stays false (the scope initialises it false
   * and only raises it once its mirror loads as a Host-backed form), which left
   * every input `disabled` — clicking them did nothing at all. Writes no longer
   * depend on that flag: `writeField` tries the scope and falls back to the
   * plugin's own Host endpoint, which performs the mutate in the Host process.
   * A bound scope is therefore all that is required to accept an edit.
   */
  const canWrite = settingsScope !== undefined

  const editDraft = (edit: (current: WorkBuddyDraft) => WorkBuddyDraft): void => {
    setDrafts(prev => ({
      ...prev,
      [activeRegion]: edit(prev[activeRegion] ?? {
        models: [...visibleModels],
        enabledIds: new Set(activeEnabledIds),
        imageIds: new Set(activeImageIds),
        contextBudgets: { ...activeContextBudgets },
      }),
    }))
  }

  const toggleModel = (modelId: string): void => {
    editDraft(current => {
      const next = new Set(current.enabledIds)
      if (!next.delete(modelId)) next.add(modelId)
      return { ...current, enabledIds: next }
    })
  }

  const toggleImage = (modelId: string): void => {
    editDraft(current => {
      const next = new Set(current.imageIds)
      if (!next.delete(modelId)) next.add(modelId)
      return { ...current, imageIds: next }
    })
  }

  const setContextBudget = (modelId: string, budget: number): void => {
    editDraft(current => ({
      ...current,
      contextBudgets: { ...current.contextBudgets, [modelId]: budget },
    }))
  }

  const discardModels = (): void => {
    setDrafts(prev => {
      const next = { ...prev }
      delete next[activeRegion]
      return next
    })
  }

  /**
   * Probe one or more models with a single minimal request each.
   *
   * The Host owns the request: the browser half sends only model ids and gets
   * outcomes back, because the credential must never cross to the page. The
   * route runs the batch sequentially and this waits for the whole answer, which
   * is what lets the card report every row at once — a per-row response would
   * race the shared `probing` map and make the batch button's state unknowable.
   *
   * Probing is deliberately independent of `dirty`: a test answers "does this
   * model work right now", which is true of the SAVED selection and the draft
   * alike, and blocking it on unsaved edits would make the button dead exactly
   * when the user is deciding what to keep.
   */
  const probeModels = async (modelIds: readonly string[]): Promise<void> => {
    if (modelIds.length === 0) return
    setProbeError(undefined)
    setProbing(previous => {
      const next = { ...previous }
      for (const id of modelIds) next[id] = true
      return next
    })
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_PROBE_PATH, activeRegion), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ modelIds }),
      })
      const body = await response.json().catch(() => undefined) as
        | { results?: WorkBuddyWebProbeResult[]; error?: string }
        | undefined
      if (!response.ok || !Array.isArray(body?.results)) {
        throw new Error(body?.error ?? `HTTP ${String(response.status)}`)
      }
      if (!mounted.current) return
      setProbes(previous => {
        const regionResults = { ...(previous[activeRegion] ?? {}) }
        for (const result of body.results as WorkBuddyWebProbeResult[]) {
          regionResults[result.modelId] = result
        }
        return { ...previous, [activeRegion]: regionResults }
      })
    } catch (error: unknown) {
      if (mounted.current) setProbeError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) {
        // Clear the in-flight markers for exactly the rows this run touched, so
        // a concurrent single-row test on another model keeps its spinner.
        setProbing(previous => {
          const next = { ...previous }
          for (const id of modelIds) delete next[id]
          return next
        })
      }
    }
  }

  const saveModels = async (): Promise<void> => {
    if (settingsScope === undefined) return
    if (status.status !== 'signed-in') return
    setSaving(true)
    setSaveError(undefined)
    try {
      // Save this region's raw directory plus the pure selection. The Host
      // derives the runtime catalog from these on save/restart, so re-opening
      // the card re-reads WorkBuddy's current catalog instead of a stale
      // snapshot. The CN app and the international app expose different
      // rosters, so the write targets the slot keyed by the signed-in account's
      // region: the other region's picks are never touched.
      // toPersistedWorkBuddyModel strips the card-only fields BY KEY: explicit
      // `undefined` values are rejected by the settings write's strict JSON
      // codec, which used to fail the whole save silently.
      //
      // Verified write, because a save DISCARDS the draft: if the write did not
      // persist, throwing the user's edits away while reporting success would
      // be unrecoverable — the draft is the only copy. `writeRegionModels`
      // MERGES onto the existing region slot, so this save cannot delete the
      // pool preferences living in that same slot; `enabled` is still passed
      // explicitly because it is the committed value the card renders, and the
      // merge keeps whatever the slot already had for any field left absent.
      await writeRegionModels(settingsScope, status.region, {
        enabled: activeRegionOn,
        lastCatalog: visibleModels.map(toPersistedWorkBuddyModel),
        enabledModelIds: [...activeEnabledIds],
        imageModelIds: [...activeImageIds],
        contextBudgets: activeContextBudgets,
      })
      discardModels()
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      // Drafts stay dirty on failure, so the button remains pressable for a
      // retry; the reason is shown instead of a silent unhandled rejection.
      if (mounted.current) setSaveError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const title = t('row.title')
  /**
   * Show a name, or a placeholder when the desktop app recorded none.
   *
   * The Host sends `''` rather than an identifier, because a `uin`/`uid` shown
   * where a name belongs reads as "the plugin does not know who this is" — the
   * placeholder says the honest thing instead.
   */
  const nameOf = (value: string): string => value === '' ? t('row.accountUnnamed') : value
  const label = status.status === 'signed-in'
    ? t('row.signedIn', { accountName: nameOf(status.accountName) })
    : status.status === 'error'
      ? t('row.requestFailed')
      : t('row.signedOut')
  /** The saved choice no longer matches a local sign-in (tokens are fine). */
  const selectionLost = status.status === 'signed-out' && status.selectionLost === true
  /**
   * The paths the Host probed, on the branch where nothing was found at all.
   * Absent on the legacy card payload (an older Host), so it defaults empty
   * rather than rendering an empty diagnostic.
   */
  const searched: readonly WorkBuddyWebSearchPath[]
    = status.status === 'signed-out' ? status.searched ?? [] : []
  /**
   * What the signed-out paragraph says, and whether to append the Host's raw
   * error. The rule lives in `./searched-paths.ts` because it is the fix for a
   * real duplication: `resolve()`'s message already enumerated every path, and
   * the list below enumerates them again with better reasons.
   */
  const notice = signedOutNotice({
    selectionLost,
    message: status.status === 'signed-out' ? status.message : undefined,
    searched,
  })
  /**
   * Whether this region runs a saved choice, per the Host. `undefined` only on
   * the error branch, which renders no picker and therefore no state line.
   */
  const selectionExplicit = status.status === 'error' ? undefined : status.selectionExplicit

  return (
    <li className={`dsm-plugin-card${open ? ' dsm-plugin-card-open' : ''}`}>
      <button
        type="button"
        className="dsm-plugin-card-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'row.collapse' : 'row.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <img className="dsm-plugin-card-icon" src={WORKBUDDY_PLUGIN_ICON} alt="" />
        <span className="dsm-plugin-card-head">
          <span className="dsm-plugin-card-title">{title}</span>
          <span className="dsm-plugin-card-description">{t('row.desc')}</span>
        </span>
        <span aria-hidden="true" className={`dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}`} />
      </button>
      <div className="dsm-plugin-card-body" hidden={!open}>
        {open
          ? <div className="dsm-workbuddy-usage">
              <div className="dsm-workbuddy-tabs" role="tablist" aria-label={title}>
                {WORKBUDDY_REGIONS.map(region => {
                  const regionStatus = statusByRegion[region]
                  const regionOnState = regionOn(region)
                  return (
                    <div key={region} className="dsm-workbuddy-tab-cell">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={region === activeRegion}
                        className={`dsm-workbuddy-tab${region === activeRegion ? ' dsm-workbuddy-tab-active' : ''}${regionOnState ? '' : ' dsm-workbuddy-tab-off'}`}
                        onClick={() => { setActiveRegion(region); setAccountError(undefined) }}
                      >
                        {regionStatus === undefined
                          ? null
                          : <span aria-hidden="true" className="dsm-workbuddy-tab-dot" style={dotStyle(regionStatus.status)} />}
                        {region === 'cn' ? t('row.tabCn') : t('row.tabGlobal')}
                      </button>
                      <label className="dsm-workbuddy-tab-switch" title={t('row.tabSwitchHint')}>
                        <input
                          type="checkbox"
                          checked={regionOnState}
                          /* Serialized with the two SAVE writers. All three
                             write the SAME region slot, and the Host's
                             `__save` merges PER REGION (`{ ...current,
                             ...incoming }`), so a toggle carrying a stale
                             snapshot can roll back a concurrent save — and vice
                             versa. Gating only two of the three left exactly
                             that window open. */
                          disabled={togglingRegion === region || !canWrite || saving || poolBusy}
                          aria-label={t('row.tabSwitchAria', { region: region === 'cn' ? t('row.tabCn') : t('row.tabGlobal') })}
                          onChange={(event) => { void toggleRegion(region, event.target.checked) }}
                        />
                      </label>
                    </div>
                  )
                })}
              </div>
              <p className="dsm-workbuddy-models-summary">{t('row.tabHint')}</p>
              {!activeRegionOn
                ? <p className="dsm-workbuddy-tab-off-notice">{t('row.tabOffNotice')}</p>
                : null}
              <div className="dsm-workbuddy-usage-account">
                <div className="dsm-workbuddy-usage-account-copy" role="status">
                  <div className="dsm-workbuddy-usage-status">
                    <span aria-hidden="true" className="dsm-workbuddy-usage-dot" style={dotStyle(status.status)} />
                    <span>{label}</span>
                  </div>
                  {status.status === 'signed-in'
                    ? <span className="dsm-workbuddy-usage-expiry">
                        {t('row.tokenExpiry', { expiresAt: formatDateTime(status.tokenExpiresAtMs) })}
                      </span>
                    : null}
                  {status.status === 'error'
                    || (status.status === 'signed-in' && status.creditsError !== undefined)
                    // A refusal gets its own, specific advice in the panel below;
                    // the generic "sign in again" would contradict it.
                    ? status.status === 'signed-in' && status.credentialRejected === true
                      ? null
                      : <span className="dsm-workbuddy-usage-hint">{t('row.reloginHint')}</span>
                    : null}
                  {selectionLost
                    ? <span className="dsm-workbuddy-usage-hint">{t('row.selectionLostHint')}</span>
                    : null}
                </div>
                <button
                  type="button"
                  className="dsm-btn dsm-btn-outline"
                  disabled={busy}
                  onClick={() => { void rescanAccounts() }}
                >
                  {busy ? t('row.accountsScanning') : t('row.accountsRescan')}
                </button>
              </div>
              {status.status !== 'error' && status.accounts.length > 0
                ? <section className="dsm-workbuddy-account-picker" aria-label={t('row.accountsTitle')}>
                    <div className="dsm-workbuddy-usage-select-wrap">
                      <select
                        className="dsm-workbuddy-usage-select"
                        /* Read the selection from the account list rather than
                           from the status branch. `accountId` only exists on
                           the signed-in document, so deriving the value from
                           it blanked the control both when the saved id was
                           orphaned AND when a perfectly intact choice merely
                           failed to resolve (expired token, refresh error) —
                           the user's own choice looked like it had vanished.
                           The list is the one source that distinguishes "no
                           account in effect" from "signed in". */
                        value={status.accounts.find(account => account.selected)?.id ?? ''}
                        disabled={switchingAccount || !canWrite || poolRotationLocked}
                        onChange={event => { void switchAccount(event.currentTarget.value) }}
                      >
                        {/* Shown while no row is in effect — an orphaned saved
                            id, a failed refresh, or no explicit choice yet.
                            Without it the control would have no matching
                            option and silently display the first account,
                            which is exactly the "looks fine, but is not what
                            runs" confusion this fixes. Disabled so it can
                            never be picked as a value. */}
                        {status.accounts.some(account => account.selected)
                          ? null
                          : <option value="" disabled>{t('row.accountNoneInEffect')}</option>}
                        {status.accounts.map(account => (
                          <option key={account.id} value={account.id}>
                            {nameOf(account.accountName)}{account.domain === '' ? '' : ` · ${account.domain}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    {/* State, not a hint: whether this region is running a saved
                        choice. The "follow the app's sign-in" mode has been
                        removed from this card — accounts are picked explicitly. */}
                    <span className="dsm-workbuddy-account-state" role="status">
                      {selectionExplicit === true
                        ? t('row.accountsSavedChoice')
                        : ''}
                    </span>
                    {/* A write that did not persist is stated, never swallowed.
                        Reaching this means `set()` resolved while the value is
                        absent from the document (a locked profile configuration on
                        Windows), so the choice shown above is NOT the one in
                        effect and saying nothing would leave the user with a
                        picker that lies. */}
                    {accountError === undefined
                      ? null
                      : <span className="dsm-workbuddy-account-error" role="alert">
                          {t('row.accountsWriteFailed', { message: accountError })}
                        </span>}
                  </section>
                : null}
              {status.status === 'signed-in'
                ? <>
                    {status.credits === undefined ? null : (() => {
                      // The monthly resource (CapacityType 4, never expires,
                      // refreshes every cycle) leads the panel as a distinctive
                      // row — its "remaining" is the current-cycle quota, so 0
                      // still means "used up this month, resets at the shown
                      // refresh time". Below it, "nearest expiry" lists only the
                      // one-off gifts expiring within 3 days; exhausted gifts
                      // (remain 0) are dropped even though the upstream already
                      // filters them.
                      const monthly = [...status.credits.packages]
                        .filter(pack => pack.monthly)
                        .sort((left, right) => right.remain - left.remain)
                      const SOON_MS = 3 * 24 * 60 * 60 * 1000
                      const now = Date.now()
                      const expiring = [...status.credits.packages]
                        .filter(pack => !pack.monthly && pack.remain > 0
                          && (pack.expiresAtMs ?? Number.MAX_SAFE_INTEGER) - now <= SOON_MS)
                        .sort((left, right) =>
                          (left.expiresAtMs ?? Number.MAX_SAFE_INTEGER) -
                          (right.expiresAtMs ?? Number.MAX_SAFE_INTEGER))
                      return (
                        <div className="dsm-workbuddy-credits-panels">
                          <section className="dsm-workbuddy-credit-panel dsm-workbuddy-credit-panel-activities">
                            {monthly.map((pack, index) => (
                              <div className="dsm-workbuddy-credit-monthly-row" key={`monthly-${pack.packageName}-${String(index)}`}>
                                <span className="dsm-workbuddy-credit-monthly-name">{pack.packageName}</span>
                                <span className="dsm-workbuddy-credit-monthly-meta">
                                  {t('row.creditsMonthlyRemain', {
                                    remain: formatNumber(pack.remain),
                                    size: formatNumber(pack.size),
                                    at: pack.cycleRefreshMs === undefined ? '' : formatDate(pack.cycleRefreshMs),
                                  })}
                                </span>
                              </div>
                            ))}
                            {expiring.length === 0
                              ? <span className="dsm-workbuddy-credit-panel-empty">{t('row.creditsNoSoon')}</span>
                              : <ul className="dsm-workbuddy-credit-packages">
                                  {expiring.map((pack, index) => {
                                    const at = pack.expiresAtMs
                                    return (
                                      <li key={`${pack.packageName}-${String(index)}`}>
                                        <span>{pack.packageName}</span>
                                        <span>
                                          {formatNumber(pack.remain)}
                                          {at === undefined ? '' : ` · ${formatDate(at)}`}
                                        </span>
                                      </li>
                                    )
                                  })}
                                </ul>}
                            <div className="dsm-workbuddy-credit-soon">
                              <span>{t('row.creditsExpiringSoon')}</span>
                              <strong>{formatNumber(status.credits.expiringSoon)}</strong>
                            </div>
                          </section>
                          <section className="dsm-workbuddy-credit-panel dsm-workbuddy-credit-panel-total">
                            <div className="dsm-workbuddy-credit-total-body">
                              <span className="dsm-workbuddy-credit-panel-title">{t('row.creditsTotalLabel')}</span>
                              <strong className="dsm-workbuddy-credit-total-value">{formatNumber(status.credits.total)}</strong>
                            </div>
                            {status.checkin === undefined ? null
                              : <div className="dsm-workbuddy-checkin">
                                  <button
                                    type="button"
                                    className="dsm-btn dsm-btn-primary dsm-workbuddy-checkin-button"
                                    disabled={!status.checkin.active || status.checkin.todayCheckedIn || checkingIn}
                                    onClick={() => { void claimDailyCheckin() }}
                                  >
                                    {checkingIn
                                      ? t('row.checkinClaiming')
                                      : status.checkin.todayCheckedIn ? t('row.checkinClaimed') : (status.checkin.claimButtonText ?? t('row.checkinClaim'))}
                                  </button>
                                </div>}
                            {status.checkinError === undefined && checkinActionError === undefined ? null
                              : <span className="dsm-workbuddy-checkin-error">
                                  {t('row.checkinError', { message: checkinActionError ?? status.checkinError ?? '' })}
                                </span>}
                          </section>
                        </div>
                      )
                    })()}
                    {status.credentialRejected === true
                      ? <section className="dsm-workbuddy-usage-error" role="alert">
                          <strong>{t('row.credentialRejectedTitle')}</strong>
                          <p>{t('row.credentialRejectedIntro', { accountName: nameOf(status.accountName) })}</p>
                          {status.recovery?.usableAccount !== undefined
                            ? <p>{t('row.credentialRejectedSwitch', { accountName: nameOf(status.recovery.usableAccount.accountName) })}</p>
                            : status.recovery?.reloginRequired === true
                              ? <p>{t('row.credentialRejectedRelogin')}</p>
                              : <p>{t('row.credentialRejectedChoose')}</p>}
                          {status.recovery?.usableAccount === undefined
                            ? null
                            : <button
                                type="button"
                                className="dsm-btn dsm-btn-outline"
                                disabled={switchingAccount || !canWrite}
                                onClick={() => {
                                  const target = status.recovery?.usableAccount
                                  if (target !== undefined) void switchAccount(target.accountId)
                                }}
                              >
                                {switchingAccount
                                  ? t('row.accountsScanning')
                                  : t('row.credentialRejectedSwitchAction', { accountName: nameOf(status.recovery.usableAccount.accountName) })}
                              </button>}
                        </section>
                      : null}
                    {status.creditsError === undefined ? null
                      : <p className="dsm-workbuddy-usage-error">{t('row.creditsError', { message: status.creditsError })}</p>}
                    {status.refreshError === undefined ? null
                      : <p className="dsm-workbuddy-usage-error" role="alert">{t('row.requestFailedHint', { message: status.refreshError })}</p>}
                    <section className="dsm-workbuddy-models" aria-label={t('row.modelsTitle')}>
                      <div className="dsm-workbuddy-models-head">
                        <div>
                          <h3 className="dsm-workbuddy-models-title">{t('row.modelsTitle')}</h3>
                          <p className="dsm-workbuddy-models-summary">{t('row.modelsSummary', { count: activeEnabledIds.size })}</p>
                        </div>
                        <div className="dsm-workbuddy-models-head-actions">
                          {/* No "test selected" batch: every probe now sends a
                              real-volume request and therefore costs real
                              credits, so a whole-roster sweep would be a large
                              spend from one click. Testing is per model only. */}
                          <button
                            type="button"
                            className="dsm-btn dsm-btn-outline"
                            disabled={busy}
                            onClick={() => { void refreshModels() }}
                          >
                            {busy ? t('row.modelsRefreshing') : t('row.modelsRefresh')}
                          </button>
                        </div>
                      </div>
                      {probeError === undefined ? null
                        : <p className="dsm-workbuddy-model-probe-result dsm-workbuddy-model-probe-result-bad" role="alert">
                            {t('row.probeError', { message: probeError })}
                          </p>}
                      <div className="dsm-workbuddy-model-list">
                        {visibleModels.map(model => (
                          <div className={`dsm-workbuddy-model${activeEnabledIds.has(model.id) ? '' : ' dsm-workbuddy-model-disabled'}`} key={model.id}>
                            <div className="dsm-workbuddy-model-head">
                              <label className="dsm-workbuddy-model-enabled">
                                <input
                                  type="checkbox"
                                  checked={activeEnabledIds.has(model.id)}
                                  disabled={!canWrite || saving}
                                  onChange={() => { toggleModel(model.id) }}
                                />
                                <span className="dsm-workbuddy-model-copy">
                                  <span className="dsm-workbuddy-model-name">
                                    {model.name}
                                    {model.creditMultiplier === undefined ? null
                                      : <span className="dsm-workbuddy-model-name-rate">({model.creditMultiplier.toFixed(2)}x)</span>}
                                  </span>
                                </span>
                              </label>
                              <label
                                className="dsm-workbuddy-model-image"
                                title={imageCheckboxHint(model, t)}
                              >
                                <input
                                  type="checkbox"
                                  checked={activeImageIds.has(model.id)}
                                  disabled={!canWrite || saving}
                                  onChange={() => { toggleImage(model.id) }}
                                />
                                <span>{t('row.modelImage')}</span>
                              </label>
                              <fieldset className="dsm-workbuddy-context-budget" aria-label={t('row.contextBudget')}>
                                {model.nativeContextWindow > 200_000
                                  ? <label>
                                      <input
                                        type="radio"
                                        name={`context-${model.id}`}
                                        checked={(activeContextBudgets[model.id] ?? 200_000) === 200_000}
                                        disabled={!canWrite || saving}
                                        onChange={() => { setContextBudget(model.id, 200_000) }}
                                      />
                                      <span>200K</span>
                                    </label>
                                  : null}
                                <label>
                                  <input
                                    type="radio"
                                    name={`context-${model.id}`}
                                    checked={model.nativeContextWindow <= 200_000 || activeContextBudgets[model.id] === model.nativeContextWindow}
                                    disabled={model.nativeContextWindow <= 200_000 || !canWrite || saving}
                                    onChange={() => { setContextBudget(model.id, model.nativeContextWindow) }}
                                  />
                                  <span>{formatCapacity(model.nativeContextWindow, t('row.modelUnknown'))}</span>
                                </label>
                              </fieldset>
                                <div className="dsm-workbuddy-model-actions-buttons">
                                {/* Test button. Deliberately NOT gated on `canWrite`
                                    or `saving`: a probe writes no settings, so it
                                    works on a read-only card and while a save is
                                    in flight. It IS gated on being signed in,
                                    because without a credential the only possible
                                    answer is "rejected".

                                    It sends a REAL-VOLUME request (see
                                    PROBE_INPUT_TOKENS in src/probe.ts), because
                                    the upstream's 6004 throttle fires on request
                                    size: a tiny probe would report "usable" while
                                    every real request in a long conversation is
                                    refused. That also means it costs real
                                    credits, so it is per-model and manual only —
                                    there is deliberately no batch button. */}
                                <button
                                  type="button"
                                  className="dsm-btn dsm-btn-outline dsm-workbuddy-model-probe"
                                  disabled={probing[model.id] === true || status.status !== 'signed-in'}
                                  title={t('row.probeHint')}
                                  onClick={() => { void probeModels([model.id]) }}
                                >
                                  {probing[model.id] === true ? t('row.probing') : t('row.probe')}
                                </button>
                                </div>
                              </div>
                              <div className="dsm-workbuddy-model-details">
                                <div className="dsm-workbuddy-model-meta">
                                  <span>{t('row.modelContext', { context: formatCapacity(model.nativeContextWindow, t('row.modelUnknown')) })}</span>
                                  <span>{t('row.modelOutput', { output: formatCapacity(model.maxTokens, t('row.modelUnknown')) })}</span>
                                  {model.reasoning === undefined || model.reasoning.supportedEfforts === undefined ? null
                                    : <span>{t('row.modelReasoning', { efforts: model.reasoning.supportedEfforts.join(' / ') })}</span>}
                                </div>
                              </div>
                              {(() => {
                                const result = probes[activeRegion]?.[model.id]
                                if (result === undefined) return null
                                const view = probeResultView(result, t)
                                return (
                                  <p
                                    className={`dsm-workbuddy-model-probe-result dsm-workbuddy-model-probe-result-${view.tone}`}
                                    role="status"
                                  >
                                    {view.text}
                                    {result.message === undefined ? null : ' · ' + result.message}
                                  </p>
                                )
                              })()}
                          </div>
                        ))}
                      </div>
                      <p className="dsm-workbuddy-model-capability-note">{t('row.modelCapabilityPending')}</p>
                      <div className="dsm-workbuddy-model-actions">
                        <a
                          className="dsm-workbuddy-usage-cheer"
                          href={WORKBUDDY_GITHUB_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('row.cheer')}
                          <span className="dsm-workbuddy-usage-cheer-star" aria-hidden="true">★</span>
                        </a>
                        {saveError === undefined ? null
                          : <span className="dsm-workbuddy-model-save-error">{t('row.saveError', { message: saveError })}</span>}
                        <div className="dsm-workbuddy-model-actions-buttons">
                          <button type="button" className="dsm-btn dsm-btn-outline" disabled={!dirty || saving || poolBusy || togglingRegion !== undefined} onClick={discardModels}>
                            {t('row.discard')}
                          </button>
                          <button type="button" className="dsm-btn dsm-btn-primary" disabled={!dirty || saving || poolBusy || togglingRegion !== undefined || activeEnabledIds.size === 0} onClick={() => { void saveModels() }}>
                            {saving ? t('row.saving') : t('row.save')}
                          </button>
                        </div>
                      </div>
                    </section>
                    {/* The account pool. Rendered only when the Host reports
                        pool state, so an older Host shows an unmodified card.
                        It owns the rotation-vs-manual conflict: while rotation
                        is on it reports `locked` and the account picker above
                        is disabled, because two writers deciding the same slot
                        is how "shows A, bills B" happens. The two sections'
                        save buttons are also serialized (`siblingBusy` /
                        `onBusyChange`): both write into ONE region slot and the
                        Host merges per-region, so concurrent saves could revert
                        each other. */}
                    <AccountPool
                      t={t}
                      region={activeRegion}
                      {...status.pool === undefined ? {} : { pool: status.pool }}
                      {...settingsScope === undefined ? {} : { settingsScope }}
                      siblingBusy={saving || togglingRegion !== undefined}
                      onBusyChange={setPoolBusy}
                      // Returns the promise so the pool section can AWAIT the
                      // fresh props before discarding its draft (A-8). With
                      // `void` here the await resolved immediately and the
                      // window stayed open.
                      //
                      // And it answers with a BOOLEAN: `refreshUsage` reports a
                      // failed fetch by RESOLVING (undefined) rather than
                      // throwing, so the section cannot infer "the fresh props
                      // arrived" from "it did not throw". `true` only when the
                      // snapshot was actually applied; a superseded or failed
                      // re-read resolves `false` and the draft is kept.
                      onSaved={async () => (await refreshUsage(activeRegion)) !== undefined}
                      onRefresh={() => { void refreshUsage(activeRegion) }}
                      onRotationChange={setPoolRotationLocked}
                    />
                  </>
                : null}
              {status.status === 'signed-out'
                ? <>
                    <p className="dsm-workbuddy-usage-text">
                      {/* An orphaned saved id is NOT a signed-out machine: the
                          tokens are fine and re-signing in would not repair the
                          id. Say what actually helps (re-pick, or follow the app
                          again) instead of echoing the resolve() error, which
                          tells the user to sign in — the one action that cannot
                          fix this. The same goes for a wrong-region sign-in.
                          When a probed-path list follows, its paths ARE the
                          enumeration the resolve() error repeats, so the
                          paragraph states the situation and the list supplies
                          the detail. */}
                      {signedOutText(notice, t)}
                    </p>
                    {searched.length > 0 ? <SearchedPaths items={searched} t={t} /> : null}
                  </>
                : null}
              {status.status === 'error' ? <p className="dsm-workbuddy-usage-error">{status.message}</p> : null}
            </div>
          : null}
      </div>
    </li>
  )
}
