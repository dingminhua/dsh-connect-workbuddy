/**
 * WorkBuddy credits & models card contributed to Harness Plugin configuration.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 卡片的整体结构（折叠外壳 / 账号状态行 / 账号下拉 / 积分区 / 模型表 /
 *     操作按钮行）、模块加载时注入一次 `<style>` 的写法、
 *     草稿态（draftModels/draftEnabledIds）与 dirty 标记的保存流程、
 *     60 秒轮询与 AbortController 清理、以及
 *     折叠箭头的交互，均来自该项目的 TraeUsageCard。
 *   折叠卡片外壳与 `settings.plugin.item` 槽位形态来自
 *   dingminhua/dsh-subagent-default-model（MIT）。
 * 改动：
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
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  regionEnabledOf,
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_REGIONS,
  WORKBUDDY_USAGE_PATH,
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
} from '../status-paths.ts'
import type { WorkBuddyWebModel, WorkBuddyWebRegion, WorkBuddyWebSearchPath, WorkBuddyWebUsage } from '../status-paths.ts'
import { writeAccountSlot, writeRegionEnabled, writeRegionModels } from './account-selection.ts'
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

/** Props delivered by the Plugin configuration item slot. */
export type WorkBuddyCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<WorkBuddyCardInjected>

const POLL_INTERVAL_MS = 60_000
const WORKBUDDY_GITHUB_URL = 'https://github.com/dingminhua/dsh-connect-workbuddy'

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
  }).format(new Date(value))
}

/** Compact package-date rendering with time, e.g. 08/25 14:44. */
function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
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
  /** A refused account write (silently unpersisted settings on a locked file). */
  const [accountError, setAccountError] = useState<string | undefined>(undefined)
  const [checkingIn, setCheckingIn] = useState(false)
  const [checkinActionError, setCheckinActionError] = useState<string | undefined>(undefined)
  /** Region whose on/off checkbox write is in flight, so its box can't race. */
  const [togglingRegion, setTogglingRegion] = useState<WorkBuddyWebRegion | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => settingsScope?.subscribe(() => { setSettingsRevision(value => value + 1) }), [settingsScope])

  const refreshUsage = useCallback(async (
    region: WorkBuddyWebRegion,
    signal?: AbortSignal,
  ): Promise<WorkBuddyWebUsage | undefined> => {
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_USAGE_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const usage = value as WorkBuddyWebUsage
      if (mounted.current && signal?.aborted !== true) {
        setStatusByRegion(prev => ({ ...prev, [region]: usage }))
      }
      return usage
    } catch (error: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        setStatusByRegion(prev => ({
          ...prev,
          [region]: { status: 'error', message: error instanceof Error ? error.message : t('row.requestFailed') },
        }))
      }
      return undefined
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refreshUsage(activeRegion, controller.signal)
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
   * Whether one region's provider is switched on, read off the SAME committed
   * settings document the Host reads (`regionEnabledOf` mirrors the Host's
   * `regionStateOf` opt-out rule: only an explicit `false` disables). Reading
   * the stored value rather than echoing local state means a rejected write,
   * another window's change, or a restart all converge on the truth.
   *
   * The whole settings section is passed deliberately: `regionEnabledOf`
   * accepts either it or the bare `regions` map, because passing the section
   * where the map was expected was a shipped bug (the lookup read
   * `section['cn']`, found nothing, and reported `true` forever — the checkbox
   * stayed checked and clicking it appeared dead while the write succeeded).
   */
  const regionOn = (item: WorkBuddyWebRegion): boolean => {
    const live = statusByRegion[item]
    if (live !== undefined && live.status !== 'error' && live.enabled !== undefined) return live.enabled
    return regionEnabledOf(settingsScope?.getSnapshot().value, item)
  }
  const activeRegionOn = regionOn(activeRegion)

  /**
   * Switch one region's provider off or on. The write carries the region's
   * whole slot through untouched — only `enabled` changes — so the user's
   * directory, model picks, image opt-ins and budgets survive a round trip.
   * The Host withdraws or restores the provider route on the next `onChange`,
   * which is what actually removes it from DSH's model picker.
   */
  const toggleRegion = async (item: WorkBuddyWebRegion, enabled: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    setTogglingRegion(item)
    try {
      await writeRegionEnabled(settingsScope, item, enabled)
      await refreshUsage(item)
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
      // Re-map the user's CURRENT selections (draft first, then saved) onto the
      // fresh catalog by model id, so renames and additions never silently lose
      // enabled choices, image opt-ins, or context budgets.
      const stillEnabled = [...activeEnabledIds].filter(id => freshIds.has(id))
      const stillImages = [...activeImageIds].filter(id => freshIds.has(id))
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
          imageIds: new Set(stillImages),
          contextBudgets: stillBudgets,
        },
      }))
    } catch (error: unknown) {
      if (mounted.current) setStatusByRegion(prev => ({
        ...prev,
        [activeRegion]: { status: 'error', message: error instanceof Error ? error.message : t('row.requestFailed') },
      }))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  // The card renders the last-refreshed directory (`status.models`), never a
  // stale saved snapshot. Enabled flags come from the user's stored selection,
  // re-mapped onto the current catalog by model id.
  const draft = drafts[activeRegion]
  const visibleModels = draft?.models ?? (status.status === 'signed-in' ? status.models : [])
  const savedEnabledIds = status.status === 'signed-in' ? new Set(status.enabledModelIds) : new Set<string>()
  const activeEnabledIds = draft?.enabledIds ?? savedEnabledIds
  const savedImageIds = status.status === 'signed-in' ? new Set(status.imageModelIds) : new Set<string>()
  const activeImageIds = draft?.imageIds ?? savedImageIds
  // Context budgets come from the Host's own answer, NOT from the browser
  // settings mirror. On the affected 0.1.7 deployment that mirror never picks
  // up this plugin's writes (a save made through the Host endpoint leaves it
  // stale), so reading it here made a successful save look like it reverted —
  // the "save did nothing" report.
  const savedContextBudgets = status.status === 'signed-in' ? (status.contextBudgets ?? {}) : {}
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
   * depend on that flag: the write helpers try the scope and fall back to the
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
      // be unrecoverable — the draft is the only copy. `enabled` rides along
      // too: `writeRegionModels` replaces the whole region slot, so omitting it
      // would silently re-open a provider the user had switched off.
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
                          disabled={togglingRegion === region || !canWrite}
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
                        disabled={switchingAccount || !canWrite}
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
                        absent from the document (a locked settings.yaml on
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
                    <section className="dsm-workbuddy-models" aria-label={t('row.modelsTitle')}>
                      <div className="dsm-workbuddy-models-head">
                        <div>
                          <h3 className="dsm-workbuddy-models-title">{t('row.modelsTitle')}</h3>
                          <p className="dsm-workbuddy-models-summary">{t('row.modelsSummary', { count: activeEnabledIds.size })}</p>
                        </div>
                        <button
                          type="button"
                          className="dsm-btn dsm-btn-outline"
                          disabled={busy}
                          onClick={() => { void refreshModels() }}
                        >
                          {busy ? t('row.modelsRefreshing') : t('row.modelsRefresh')}
                        </button>
                      </div>
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
                              <label className="dsm-workbuddy-model-image" title={t('row.modelImage')}>
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
                            </div>
                            <div className="dsm-workbuddy-model-details">
                              <div className="dsm-workbuddy-model-meta">
                                <span>{t('row.modelContext', { context: formatCapacity(model.nativeContextWindow, t('row.modelUnknown')) })}</span>
                                <span>{t('row.modelOutput', { output: formatCapacity(model.maxTokens, t('row.modelUnknown')) })}</span>
                                {model.reasoning === undefined || model.reasoning.supportedEfforts === undefined ? null
                                  : <span>{t('row.modelReasoning', { efforts: model.reasoning.supportedEfforts.join(' / ') })}</span>}
                              </div>
                            </div>
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
                          <button type="button" className="dsm-btn dsm-btn-outline" disabled={!dirty || saving} onClick={discardModels}>
                            {t('row.discard')}
                          </button>
                          <button type="button" className="dsm-btn dsm-btn-primary" disabled={!dirty || saving || activeEnabledIds.size === 0} onClick={() => { void saveModels() }}>
                            {saving ? t('row.saving') : t('row.save')}
                          </button>
                        </div>
                      </div>
                    </section>
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
