/**
 * WorkBuddy credits & models card contributed to Harness Plugin configuration.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 卡片的整体结构（折叠外壳 / 账号状态行 / 账号下拉 / 积分区 / 模型表 /
 *     操作按钮行）、模块加载时注入一次 `<style>` 的写法、
 *     草稿态（draftModels/draftEnabledIds）与 dirty 标记的保存流程、
 *     60 秒轮询与 AbortController 清理、以及
 *     `IconChevronDownOutline14` 的使用，均来自该项目的 TraeUsageCard。
 *   折叠卡片外壳与 `settings.plugin.item` 槽位形态来自
 *     dingminhua/dsh-subagent-default-model（MIT）。
 * 改动：
 *   1. 积分区改为「合计 + 按套餐名聚合的进度条」，因为实测单个账号下
 *      同名套餐可达 19 个，逐条渲染会淹没卡片（原项目按上游条目直出）；
 *   2. 模型行补上 WorkBuddy 上游给出的积分倍率、多模态与推理档位；
 *   3. 移除与 WorkBuddy 上游无关的 1M 变体勾选。
 *
 * @module dsh-connect-workbuddy/client/WorkBuddyCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_USAGE_PATH,
} from '../status-paths.ts'
import type { WorkBuddyWebModel, WorkBuddyWebUsage } from '../status-paths.ts'
import { WORKBUDDY_PLUGIN_ICON } from './icon.ts'
import { WORKBUDDY_CARD_CSS } from './styles.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyCardInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  settingsScope: {
    getSnapshot(): { status: string; value?: unknown; writable: boolean }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<void>
  }
}

/** Props delivered by the Plugin configuration item slot. */
export type WorkBuddyCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<WorkBuddyCardInjected>

const POLL_INTERVAL_MS = 60_000
const WORKBUDDY_GITHUB_URL = 'https://github.com/dingminhua/dsh-connect-workbuddy'

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
export function WorkBuddyCard({ t, settingsScope }: WorkBuddyCardProps) {
  if (t === undefined) throw new Error('WorkBuddy plugin card requires its translation function')
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<WorkBuddyWebUsage>({ status: 'signed-out', accounts: [] })
  const [busy, setBusy] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [draftModels, setDraftModels] = useState<WorkBuddyWebModel[] | undefined>(undefined)
  const [draftEnabledIds, setDraftEnabledIds] = useState<Set<string> | undefined>(undefined)
  const [draftImageIds, setDraftImageIds] = useState<Set<string> | undefined>(undefined)
  const [draftContextBudgets, setDraftContextBudgets] = useState<Record<string, number> | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [switchingAccount, setSwitchingAccount] = useState(false)
  const [checkingIn, setCheckingIn] = useState(false)
  const [checkinActionError, setCheckinActionError] = useState<string | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => settingsScope?.subscribe(() => { setSettingsRevision(value => value + 1) }), [settingsScope])

  const refreshUsage = useCallback(async (signal?: AbortSignal): Promise<WorkBuddyWebUsage | undefined> => {
    try {
      const response = await fetch(WORKBUDDY_USAGE_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (mounted.current && signal?.aborted !== true) setStatus(value as WorkBuddyWebUsage)
      return value as WorkBuddyWebUsage
    } catch (error: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        setStatus({ status: 'error', message: error instanceof Error ? error.message : t('row.requestFailed') })
      }
      return undefined
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refreshUsage(controller.signal)
    return () => { controller.abort() }
  }, [open, refreshUsage])

  useEffect(() => {
    if (!open || status.status !== 'signed-in') return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refreshUsage(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refreshUsage, status.status])

  const rescanAccounts = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(WORKBUDDY_ACCOUNTS_REFRESH_PATH, {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      const body = await response.json() as { accounts?: { id: string; selected: boolean }[] }
      if (!response.ok || !Array.isArray(body.accounts)) throw new Error(`HTTP ${response.status}`)
      const selected = body.accounts.find(account => account.selected)?.id
      const configured = settingsScope?.getSnapshot().value
      const configuredId = typeof configured === 'object' && configured !== null && typeof (configured as { accountId?: unknown }).accountId === 'string'
        ? (configured as { accountId: string }).accountId
        : undefined
      if (selected !== undefined && selected !== configuredId && settingsScope?.getSnapshot().writable === true) {
        await settingsScope.set('accountId', selected)
      }
      await refreshUsage()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const switchAccount = async (accountId: string): Promise<void> => {
    if (settingsScope === undefined) return
    setSwitchingAccount(true)
    try {
      await settingsScope.set('accountId', accountId)
      await refreshUsage()
    } finally {
      if (mounted.current) setSwitchingAccount(false)
    }
  }

  const claimDailyCheckin = async (): Promise<void> => {
    setCheckingIn(true)
    setCheckinActionError(undefined)
    try {
      const response = await fetch(WORKBUDDY_CHECKIN_PATH, {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined) as { error?: string } | undefined
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      await refreshUsage()
    } catch (error: unknown) {
      if (mounted.current) setCheckinActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setCheckingIn(false)
    }
  }

  const refreshModels = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(WORKBUDDY_MODELS_REFRESH_PATH, {
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
      setDraftModels(fresh)
      setDraftEnabledIds(new Set(stillEnabled))
      setDraftImageIds(new Set(stillImages))
      setDraftContextBudgets(stillBudgets)
    } catch (error: unknown) {
      if (mounted.current) setStatus({ status: 'error', message: error instanceof Error ? error.message : t('row.requestFailed') })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  void settingsRevision
  // The card renders the last-refreshed directory (`status.models`), never a
  // stale saved snapshot. Enabled flags come from the user's stored selection,
  // re-mapped onto the current catalog by model id.
  const visibleModels = draftModels ?? (status.status === 'signed-in' ? status.models : [])
  const savedEnabledIds = status.status === 'signed-in' ? new Set(status.enabledModelIds) : new Set<string>()
  const activeEnabledIds = draftEnabledIds ?? savedEnabledIds
  const savedImageIds = status.status === 'signed-in' ? new Set(status.imageModelIds) : new Set<string>()
  const activeImageIds = draftImageIds ?? savedImageIds
  const configured = settingsScope?.getSnapshot().value
  const savedContextBudgets = typeof configured === 'object' && configured !== null && typeof (configured as { contextBudgets?: unknown }).contextBudgets === 'object'
    ? (configured as { contextBudgets: Record<string, number> }).contextBudgets
    : {}
  const activeContextBudgets = draftContextBudgets ?? savedContextBudgets
  const dirty = draftModels !== undefined || draftEnabledIds !== undefined || draftImageIds !== undefined || draftContextBudgets !== undefined

  const toggleModel = (modelId: string): void => {
    const next = new Set(activeEnabledIds)
    if (!next.delete(modelId)) next.add(modelId)
    setDraftEnabledIds(next)
    setDraftModels([...visibleModels])
  }

  const toggleImage = (modelId: string): void => {
    const next = new Set(activeImageIds)
    if (!next.delete(modelId)) next.add(modelId)
    setDraftImageIds(next)
    setDraftModels([...visibleModels])
  }

  const setContextBudget = (modelId: string, budget: number): void => {
    setDraftContextBudgets({ ...activeContextBudgets, [modelId]: budget })
    setDraftModels([...visibleModels])
  }

  const discardModels = (): void => {
    setDraftModels(undefined)
    setDraftEnabledIds(undefined)
    setDraftImageIds(undefined)
    setDraftContextBudgets(undefined)
  }

  const saveModels = async (): Promise<void> => {
    if (settingsScope === undefined) return
    setSaving(true)
    try {
      // Save the raw directory plus the pure selection. The Host derives the
      // runtime catalog from these two on save/restart, so re-opening the card
      // re-reads WorkBuddy's current catalog instead of a stale snapshot.
      await settingsScope.set('lastCatalog', visibleModels.map(model => ({
        ...model,
        contextWindow: model.nativeContextWindow,
        nativeContextWindow: undefined,
        multimodal: undefined,
      })))
      await settingsScope.set('enabledModelIds', [...activeEnabledIds])
      await settingsScope.set('imageModelIds', [...activeImageIds])
      await settingsScope.set('contextBudgets', activeContextBudgets)
      discardModels()
      await refreshUsage()
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const title = t('row.title')
  const label = status.status === 'signed-in'
    ? t('row.signedIn', { accountName: status.accountName })
    : status.status === 'error'
      ? t('row.requestFailed')
      : t('row.signedOut')

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
        <span
          aria-hidden="true"
          className={`dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}`}
        >
          {h(IconChevronDownOutline14, { size: 14 })}
        </span>
      </button>
      <div className="dsm-plugin-card-body" hidden={!open}>
        {open
          ? <div className="dsm-workbuddy-usage">
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
                        value={status.status === 'signed-in' ? status.accountId : ''}
                        disabled={switchingAccount || settingsScope?.getSnapshot().writable !== true}
                        onChange={event => { void switchAccount(event.currentTarget.value) }}
                      >
                        {status.accounts.map(account => (
                          <option key={account.id} value={account.id}>
                            {account.accountName}{account.domain === '' ? '' : ` · ${account.domain}`}
                          </option>
                        ))}
                      </select>
                    </div>
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
                                  disabled={settingsScope?.getSnapshot().writable !== true || saving}
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
                                  disabled={settingsScope?.getSnapshot().writable !== true || saving}
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
                                        disabled={settingsScope?.getSnapshot().writable !== true || saving}
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
                                    disabled={model.nativeContextWindow <= 200_000 || settingsScope?.getSnapshot().writable !== true || saving}
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
              {status.status === 'signed-out' ? <p className="dsm-workbuddy-usage-text">{status.message ?? t('row.signedOutHint')}</p> : null}
              {status.status === 'error' ? <p className="dsm-workbuddy-usage-error">{status.message}</p> : null}
            </div>
          : null}
      </div>
    </li>
  )
}
