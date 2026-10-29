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

import { Component, useCallback, useEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ErrorInfo, ReactElement, ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  nextRegionCreditPosition,
  nextRegionCreditsShown,
  nextRegionEnabled,
  nextRegionImageToolEnabled,
  nextRegionPreferredVideoModels,
  nextRegionVideoToolEnabled,
  regionCreditsShownOf,
  regionEnabledOf,
  regionImageToolEnabledOf,
  regionPreferredVideoModelsOf,
  regionVideoToolEnabledOf,
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MEDIA_MODELS_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_GITHUB_URL,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_TPS_PATH,
  WORKBUDDY_REGIONS,
  WORKBUDDY_USAGE_PATH,
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
  withWorkBuddyRegionFastDetail,
} from '../status-paths.ts'
import type {
  WorkBuddyCreditPosition,
  WorkBuddyWebMediaModel,
  WorkBuddyWebModel,
  WorkBuddyWebProbeResult,
  WorkBuddyWebTpsResult,
  WorkBuddyWebRegion,
  WorkBuddyWebSearchPath,
  WorkBuddyWebUsage,
} from '../status-paths.ts'
import { channelRejectContinueOf, cliBridgeEffortOf, cliBridgeEnabledOf, cliBridgeModelOf, cliBridgeRegionOrderOf, extraInjectedPrefixesOf, isFileContentionWriteError, sessionTitleOf, upstreamSwitchOf, writeAccountSlot, writeCliBridgeEnabled, writeCliBridgeEffort, writeCliBridgeModel, writeCliBridgeRegionOrder, writeRegionCreditPosition, writeRegionCreditsShown, writeRegionEnabled, writeRegionImageToolEnabled, writeRegionPreferredVideoModels, writeRegionVideoToolEnabled, writeRegionModels, writeUpstreamSwitch } from './account-selection.ts'
import { AccountPool } from './AccountPool.tsx'
import { OAuthSignIn } from './OAuthSignIn.tsx'
import { AccountTransfer } from './AccountTransfer.tsx'
// `createLatestWins` is the same tested latest-wins factory the Host uses for
// rotation, imported rather than re-implemented: the rule has one definition
// and one set of tests.
import { createLatestWins } from '../account-pool.ts'
import { imageDefaultFor, nativeModalityOf } from '../native-modality.ts'
import { selectPromoBadge, selectPromoMultiplier } from '../promo.ts'
import { busyIcon } from './busy-icon.tsx'
import { promoBadgeColor, promoBadgeLabel, promoBadgeTooltip, uiLanguage } from './promo-badge.ts'
import { inlineProbeReason } from './probe-reason.ts'
import { remainingText } from './remaining.ts'
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

/**
 * Retry cadence for a status read that FAILED.
 *
 * The failed read used to be terminal: `status.status === 'error'` made
 * `hasAccounts` false, which gated both the 60s poll and the open effect, so a
 * single transient failure (a WebView fetch rejected while the DSH web process
 * was restarting) left "Failed to fetch" on screen until the card was closed
 * and reopened. Backoff doubles from BASE up to MAX and resets on the first
 * read that lands; nothing is armed while the card is collapsed.
 */
const STATUS_RETRY_BASE_MS = 3_000
const STATUS_RETRY_MAX_MS = 30_000

/**
 * The reasoning tiers the local CodeBuddy CLI accepts for its `--effort` flag.
 *
 * Kept in sync with `EFFORT_LEVELS` in `src/cli-bridge/tool.ts` by hand: that
 * module imports the node runtime, so the client bundle cannot share the
 * constant — a drifted list here would offer a tier the CLI rejects.
 */
const CLI_BRIDGE_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The credential-region orders the quick-adjust picker offers for the CLI
 * route's `regionOrder`.
 *
 * The Host builds exactly two regions — `cn` and `global` (see
 * `REGION_KEYS` in `src/index.ts`), so every meaningful order of that pair
 * fits in these four presets: a preference, a reversed preference, or a
 * single-region lock. `''` (uncommitted) renders as the CLI's own default
 * order, CN first.
 */
const CLI_BRIDGE_REGION_ORDERS = ['cn,global', 'global,cn', 'cn', 'global'] as const

/**
 * Tooltip for one model's image checkbox. The box is pre-checked only for
 * models the vendored vendor table documents as natively multimodal, so the
 * two other outcomes need to say WHY they are off — otherwise a documented
 * text-only model and an unverified one look identically broken next to their
 * checked siblings.
 */
/**
 * The media roster from the Host's JSON, tolerantly.
 *
 * Anything that is not a row with a string id and a name is DROPPED, never
 * rendered: this is a read-only list, and a half-shaped entry is not worth an
 * exception that would take down the whole card. A Host older than the route
 * (or any other answer without `models`) yields an empty list, which the block
 * shows as "this tab publishes none" instead of as a failure.
 */
function readMediaRoster(value: unknown): readonly WorkBuddyWebMediaModel[] | undefined {
  const models = (value as { models?: unknown } | null | undefined)?.models
  if (!Array.isArray(models)) return undefined
  const rows: WorkBuddyWebMediaModel[] = []
  for (const entry of models as readonly unknown[]) {
    const record = entry as { id?: unknown, name?: unknown, tags?: unknown } | null
    if (record === null || typeof record !== 'object') continue
    if (typeof record.id !== 'string' || record.id === '') continue
    const tags = Array.isArray(record.tags)
      ? (record.tags as readonly unknown[]).filter((tag): tag is string => typeof tag === 'string')
      : []
    rows.push({ id: record.id, name: typeof record.name === 'string' ? record.name : record.id, tags })
  }
  return rows
}

function imageCheckboxHint(model: { id: string }, t: Translate): string {
  switch (nativeModalityOf(model.id)) {
    case 'multimodal': return t('row.modelImage')
    case 'text': return t('row.modelImageText')
    default: return t('row.modelImageUnverified')
  }
}

/**
 * The upstream's own promotion badge for one model, or nothing.
 *
 * Drawn from the model's UNRESOLVED promo list at RENDER time, because a badge
 * is a function of the clock: the upstream's promotions run on wall-clock
 * hours in a named zone, so a badge chosen when the document was read would
 * keep claiming the night after the night is over. The card re-renders at
 * least once a minute while it is open (it polls the usage route), so a
 * window edge is picked up within a minute without a second timer.
 *
 * The chip says what the UPSTREAM says — its label, its colour, its hover
 * copy — and adds nothing of its own: a badge the user cannot trace back to
 * the upstream's feed is worse than no badge.
 *
 * One badge per model: the upstream's `priority` orders the entries that name
 * a model, and a model row is one line wide — two badges would push the
 * model name out of the row.
 */
function promoChip(model: WorkBuddyWebModel): ReactElement | null {
  const promo = selectPromoBadge(model.promos, Date.now())
  if (promo === undefined) return null
  const language = uiLanguage()
  const color = promoBadgeColor(promo)
  const tooltip = promoBadgeTooltip(promo, language)
  // A custom property cannot be written as an object literal in React's
  // `CSSProperties` type, so the style is built as a plain record first.
  const style: Record<string, string> | undefined = color === undefined
    ? undefined
    : { '--dsm-workbuddy-promo-color': color }
  return (
    <span
      className="dsm-workbuddy-model-promo"
      title={tooltip === '' ? undefined : tooltip}
      style={style}
    >
      {promoBadgeLabel(promo, language)}
    </span>
  )
}

/**
 * The multiplier to DRAW for a model right now (issue #120).
 *
 * A "night discount" badge used to sit next to the full price: the badge was
 * resolved against the clock while the number beside it was the catalog's
 * static figure. The discount lives in the same upstream entry, so both are
 * answered against the same clock — a promotion that is running and carries a
 * readable `replace` discount wins; otherwise the catalog figure stands.
 */
function effectiveRate(model: WorkBuddyWebModel): number | undefined {
  return selectPromoMultiplier(model.promos, Date.now()) ?? model.creditMultiplier
}

/** One region's unsaved model edits; switching tabs never drops these. */
interface WorkBuddyDraft {
  models: WorkBuddyWebModel[]
  enabledIds: Set<string>
  imageIds: Set<string>
  /** Model ids whose `off` thinking level is offered (issue #34). */
  offIds: Set<string>
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
    maximumFractionDigits: 0,
  }).format(value)
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
/**
 * ` · 约 1 小时后` for a future instant, or `''` when there is none.
 *
 * Kept beside {@link probeResultView} rather than inlined three times so the
 * "append only when non-empty" rule cannot drift between the two limited
 * outcomes. The absolute instant stays the primary text: it is the upstream's
 * own answer, and the relative form is a convenience derived from it.
 */
function retrySuffix(t: Translate, untilMs: number | undefined, nowMs: number): string {
  if (untilMs === undefined) return ''
  const remaining = remainingText(t, untilMs, nowMs)
  return remaining === '' ? '' : ` · ${remaining}`
}

/**
 * Render one measured speed, or why there is none (issue #92).
 *
 * The timestamp is PART of the value, not decoration: speed changes with load,
 * and a number without its moment is indistinguishable from a fresh one. When the
 * measurement could not be timed the row says so and names the reason — never a
 * zero, and never a guess extrapolated from `elapsedMs`, which for some runs is
 * time-to-first-token and for others a whole-request duration.
 */
export function tpsResultView(
  result: WorkBuddyWebTpsResult,
  t: Translate,
  measuredAtMs: number | undefined,
): { text: string, tone: 'ok' | 'warn' | 'bad' } {
  const stamp = measuredAtMs === undefined ? '' : ` · ${t('row.tpsMeasuredAt', { at: formatDate(measuredAtMs) })}`
  if (result.tokensPerSecond === undefined) {
    const reason = result.reason === 'few-chunks'
      ? 'row.tpsNoSample'
      : result.reason === 'no-usage'
        ? 'row.tpsNoUsage'
        : 'row.tpsAllFailed'
    return {
      text: result.samples > 0 && result.reason !== undefined
        ? `${t(reason)}${stamp}`
        : `${t('row.tpsAllFailed')}${stamp}`,
      tone: 'bad',
    }
  }
  const speed = result.samples < TPS_EXPECTED_RUNS
    ? t('row.tpsPartial', { tps: String(result.tokensPerSecond), samples: String(result.samples) })
    : result.timeToFirstTokenMs === undefined
      ? t('row.tpsValue', { tps: String(result.tokensPerSecond) })
      : t('row.tpsValueTtft', {
        tps: String(result.tokensPerSecond),
        ttft: (result.timeToFirstTokenMs / 1000).toFixed(1),
      })
  const cost = result.credit === undefined ? '' : ` · ${t('row.tpsCredit', { credit: String(result.credit) })}`
  return { text: `${speed}${cost}${stamp}`, tone: result.samples < TPS_EXPECTED_RUNS ? 'warn' : 'ok' }
}

/** Runs a complete measurement takes; below this the row says "n runs". */
const TPS_EXPECTED_RUNS = 3

function probeResultView(
  result: WorkBuddyWebProbeResult,
  t: Translate,
  nowMs: number = Date.now(),
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
          : t('row.probeRateLimitedAt', { at: formatDate(result.retryAtMs) })
            + retrySuffix(t, result.retryAtMs, nowMs),
        tone: 'warn',
      }
    case 'model-busy':
      // Its own state, never "被限流": the account is fine and switching it
      // would not help. `retryAtMs` here comes from the upstream's stated
      // MAGNITUDE ("about a minute", `retrySource: 'upstream-tips'`) rather than
      // a timestamp, which is why the label says what the failure actually is
      // instead of implying the upstream printed a time it never printed.
      return {
        text: result.retryAtMs === undefined
          ? t('row.probeModelBusyUnknown')
          : t('row.probeModelBusyAt', { at: formatDate(result.retryAtMs) })
            + retrySuffix(t, result.retryAtMs, nowMs),
        tone: 'warn',
      }
    case 'out-of-credit':
      // Only a quota-reset answer is a real time; without one, the honest text
      // is the same "no time given" the rate-limit branch uses.
      return {
        text: result.retryAtMs === undefined
          ? t('row.probeOutOfCreditUnknown')
          : t('row.probeOutOfCreditAt', { at: formatDate(result.retryAtMs) })
            + retrySuffix(t, result.retryAtMs, nowMs),
        tone: 'bad',
      }
    case 'credential-rejected': return { text: t('row.probeCredentialRejected'), tone: 'bad' }
    case 'account-restricted': return { text: t('row.probeAccountRestricted'), tone: 'bad' }
    case 'policy-rejected': return { text: t('row.probePolicyRejected'), tone: 'bad' }
    // `warn`, not `bad`: nothing about the account is wrong, and the row's own
    // job is to keep the user from reading this as "this account is broken".
    // The label says the remedy lives in the prompt.
    case 'channel-rejected': return { text: t('row.probeChannelRejected'), tone: 'warn' }
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

/**
 * The configuration area's own crash face (issue #139).
 *
 * WHY THIS EXISTS. The host wraps every slot entry in its own
 * `SlotErrorBoundary`, and that boundary's failure face is an EMPTY
 * `<div data-slot-error>` (`dsh-client-ui-renderer`). So a render-time throw
 * anywhere inside this card does not look like an error — it looks like the
 * plugin never installed: the header stays, the whole configuration area
 * vanishes, and the only trace is one `console.error` line. That is precisely
 * how issue #139 was reported ("配置区整块消失"), and it is why the reporter
 * could not tell a real crash from a missing card.
 *
 * WHAT IT BUYS. The same catch, with a face that says what happened: the
 * message goes on screen, so a report can quote it without opening devtools.
 * It does NOT hide the error — `componentDidCatch` still logs it, so the
 * console keeps the full stack the host would have printed anyway.
 *
 * SCOPE: the BODY only, never the header. A user whose configuration crashed
 * must still be able to collapse and re-expand the card, and the header is
 * pure static markup — it cannot be the thing that threw.
 *
 * LIMITS, stated so nobody expects more than React gives: a boundary catches
 * errors thrown during RENDER, in lifecycle methods, and in constructors. It
 * does NOT catch throws from event handlers, timers, or promise callbacks —
 * so an async failure still surfaces the way it did before (inline error text
 * or the console), which is the correct behaviour for those paths.
 */
class CardBodyBoundary extends Component<
  { readonly t: Translate; readonly children: ReactNode },
  { readonly failed: boolean; readonly message: string | undefined }
> {
  state: { readonly failed: boolean; readonly message: string | undefined } = {
    failed: false,
    message: undefined,
  }

  static getDerivedStateFromError(error: unknown): { failed: boolean; message: string | undefined } {
    // A `SlotAssemblyError` means the SHELL is miswired (a missing provider),
    // and the host's own boundary deliberately rethrows it rather than
    // degrading. Swallowing it here would turn a loud wiring fault into a
    // quiet "configuration failed", so it is rethrown on purpose.
    if (error instanceof Error && error.name === 'SlotAssemblyError') throw error
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      console.error('[dsh-connect-workbuddy] configuration area failed to render:', error, info.componentStack)
    } catch { /* a host without console must still draw the face */ }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="dsm-workbuddy-usage">
        <p className="dsm-workbuddy-usage-error">
          {this.props.t('row.cardCrashed')}
        </p>
        {this.state.message === undefined
          ? null
          : <p className="dsm-workbuddy-usage-error dsm-workbuddy-diag-mono">{this.state.message}</p>}
        <p className="dsm-workbuddy-diag-hint">{this.props.t('row.cardCrashedHint')}</p>
      </div>
    )
  }
}

/**
 * Render WorkBuddy sign-in state, credits, and model selection as one card.
 *
 * The body is wrapped in {@link CardBodyBoundary} INSIDE the render, not here:
 * the header must keep working when the body throws (see that class).
 */
export function WorkBuddyCard(props: WorkBuddyCardProps & { view?: string }) {
  // The boundary needs a translation function to draw its face; the body
  // already refuses to render without one, so this throws the same error the
  // body would have thrown — just before the boundary could swallow it.
  if (props.t === undefined) throw new Error('WorkBuddy plugin card requires its translation function')
  return h(WorkBuddyCardBody, props)
}

function WorkBuddyCardBody({ t, settingsScope, view }: WorkBuddyCardProps & { view?: string }) {
  if (t === undefined) throw new Error('WorkBuddy plugin card requires its translation function')
  const [open, setOpen] = useState(view === 'page')
  /** The region whose tab is on screen; each tab is its own provider stack. */
  const [activeRegion, setActiveRegion] = useState<WorkBuddyWebRegion>('cn')
  /**
   * Last-known usage per region, so tab dots survive tab switches.
   *
   * EMPTY until a real document lands (issue #77). It used to be seeded with a
   * `signed-out` placeholder, which was then rendered: for as long as the usage
   * route took to answer — and that wait is exactly what #77 reports — a user
   * with several signed-in accounts was told they were not signed in, with a
   * "detect accounts" button as the only way out. An absent region now renders
   * the loading line instead, and the first paint itself arrives from the
   * `detail=fast` document (local state only, no upstream call), so the rows
   * appear before anything billing-side has answered.
   */
  const [statusByRegion, setStatusByRegion] = useState<Partial<Record<WorkBuddyWebRegion, WorkBuddyWebUsage>>>({})
  /**
   * Which of the card's three sections is on screen.
   *
   * The section tabs exist because the card grew into one 3,500 px column that
   * carried two unrelated jobs: operating an account (who serves, how much is
   * left, which order) and editing the catalog (which models, what context
   * budget, which reasoning tiers). They even commit differently — an account
   * change lands on the click, a catalog change is a draft until saved — so a
   * single column put the save button three screens away from what it saves.
   *
   * Only the ACTIVE section is visible; the others stay MOUNTED (the `hidden`
   * attribute), so switching back never refetches, a half-filled draft
   * survives, and the pool keeps its log.
   */
  /* `capabilities` is a section of its own, not a corner of `accounts`: the
   * switches it holds authorize SPEND and tool registration, they commit on the
   * click (there is no Save button anywhere near them), and each is expected to
   * grow sub-options — a working directory for the CLI route, a per-image price
   * cap, an image size. Those have nowhere to go in a flat list under the tab
   * bar, where every added control competes with the account table for the same
   * screen.
   */
  const [panel, setPanel] = useState<'accounts' | 'models' | 'capabilities' | 'diag'>('accounts')
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
   * The region's MEDIA model roster (read-only), keyed by region.
   *
   * NOT part of `statusByRegion`: the usage document is the editable model
   * directory, and folding media rows into it would put them in the saved
   * `lastCatalog` — where the adapter would offer an image model as a chat
   * model. It is a separate, cheap, read-only read that only the capability
   * panel needs.
   */
  const [mediaByRegion, setMediaByRegion] = useState<Partial<Record<WorkBuddyWebRegion, readonly WorkBuddyWebMediaModel[]>>>({})
  const [mediaError, setMediaError] = useState<string | undefined>(undefined)
  const [mediaBusy, setMediaBusy] = useState(false)
  /**
   * Whether the account pool's save is in flight. Both sections write into one
   * region slot and the Host merges per-region, so two concurrent saves can
   * interleave on a stale base and revert each other while both report success
   * — the two save buttons are serialized to make that impossible.
   */
  const [poolBusy, setPoolBusy] = useState(false)
  /** A refused account write (silently unpersisted settings on a locked file). */
  const [accountError, setAccountError] = useState<string | undefined>(undefined)
  /** Region whose on/off checkbox write is in flight, so its box can't race. */
  const [togglingRegion, setTogglingRegion] = useState<WorkBuddyWebRegion | undefined>(undefined)
  /**
   * Region whose SIDEBAR-credit checkbox write is in flight.
   *
   * Tracked separately from {@link togglingRegion} because they are different
   * fields of the same region slot: one in-flight write must not disable the
   * other control, and both must stay serialized against the SAVE writers.
   */
  const [togglingCredits, setTogglingCredits] = useState<WorkBuddyWebRegion | undefined>(undefined)
  /**
   * Which video-model pin is being written right now: the tag string, or
   * undefined.
   *
   * A SEPARATE state from {@link togglingCredits} for the same reason those two
   * switches keep separate busy flags: the pin lives in a different field of the
   * same region slot, so one in-flight write must not disable the other control.
   */
  const [pinningVideoModel, setPinningVideoModel] = useState<string | undefined>(undefined)
  /**
   * The OPTIONAL CodeBuddy CLI route switch (global: one switch, one budget).
   *
   * `undefined` until the first Host answer arrives, so the box renders the
   * committed value instead of guessing — the same rule as `creditsShownOn`.
   */
  const [cliBridgeOn, setCliBridgeOn] = useState<boolean | undefined>(undefined)
  const [cliBridgeBusy, setCliBridgeBusy] = useState(false)
  /**
   * The quick-adjust pins of the CLI route (model, effort, region order) made
   * by THIS card instance.
   *
   * Each is `undefined` until the user changes its picker here: the value
   * then renders from the Host's answer (the authoritative mirror) and falls
   * back to the settings snapshot only when the Host cannot say — the same
   * rule as `cliBridgeOn`. A failed write reverts to `undefined`, so the
   * picker shows the COMMITTED value again instead of one that never landed.
   */
  const [cliBridgeModel, setCliBridgeModel] = useState<string | undefined>(undefined)
  const [cliBridgeModelBusy, setCliBridgeModelBusy] = useState(false)
  const [cliBridgeEffort, setCliBridgeEffort] = useState<string | undefined>(undefined)
  const [cliBridgeEffortBusy, setCliBridgeEffortBusy] = useState(false)
  const [cliBridgeRegionOrder, setCliBridgeRegionOrder] = useState<string | undefined>(undefined)
  const [cliBridgeRegionOrderBusy, setCliBridgeRegionOrderBusy] = useState(false)
  /**
   * The upstream-identity switches the user flipped in this session.
   *
   * `undefined` means "not touched here, read the committed settings"; a flipped
   * value wins until the next snapshot agrees (same rule as `cliBridgeOn`). Each
   * switch has its own busy flag so flipping one does not disable the others —
   * they are independent writes, and a shared flag would make the card feel
   * frozen while one of them is in flight.
   */
  const [usageIdentityOn, setUsageIdentityOn] = useState<boolean | undefined>(undefined)
  const [usageIdentityBusy, setUsageIdentityBusy] = useState(false)
  const [keepPromptLastOn, setKeepPromptLastOn] = useState<boolean | undefined>(undefined)
  const [keepPromptLastBusy, setKeepPromptLastBusy] = useState(false)
  const [sessionTitleOn, setSessionTitleOn] = useState<boolean | undefined>(undefined)
  const [sessionTitleBusy, setSessionTitleBusy] = useState(false)
  const [channelRejectContinueOn, setChannelRejectContinueOn] = useState<boolean | undefined>(undefined)
  const [channelRejectContinueBusy, setChannelRejectContinueBusy] = useState(false)
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
  /**
   * The active region's probe results, mirrored into a ref.
   *
   * The sweep loop reads each verdict as soon as it lands, and state read inside
   * an async loop is the value captured when the loop STARTED — so counting from
   * `probes` would tally the previous run's answers. The ref is updated in the
   * same place the state is, so the two cannot drift.
   */
  const probesRef = useRef<Record<string, WorkBuddyWebProbeResult>>({})
  /** Progress of an in-flight sweep, or undefined when none is running. */
  const [sweeping, setSweeping] = useState<{ done: number, total: number } | undefined>(undefined)
  /**
   * Measured output speed per model (issue #92), keyed by model id.
   *
   * Kept in its own map, NOT merged into `probes`: a speed run says nothing about
   * availability and an availability run says nothing about speed, so one map
   * holding both would let a fresh speed reading overwrite a stale availability
   * verdict (or the reverse) with no field to tell them apart.
   *
   * Deliberately survives a region switch's re-render but is NOT persisted: a
   * speed number is only meaningful with the moment it was taken, and a stored
   * one would be indistinguishable from a fresh measurement. The row prints the
   * time beside it for the same reason.
   */
  const [tpsResults, setTpsResults] = useState<Record<string, WorkBuddyWebTpsResult>>({})
  /** Which speed runs are in flight, so the row and the sweep button can spin. */
  const [tpsProbing, setTpsProbing] = useState<Record<string, boolean>>({})
  /** Progress of a speed sweep, so the button can show "n/m" instead of hanging. */
  const [tpsSweeping, setTpsSweeping] = useState<{ done: number, total: number } | undefined>(undefined)
  /** When each model's speed was measured, in ms; printed beside the number. */
  const [tpsMeasuredAt, setTpsMeasuredAt] = useState<Record<string, number>>({})
  /** The last sweep's tally, cleared when the next one starts. */
  const [sweepSummary, setSweepSummary] = useState<string | undefined>(undefined)
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

  /**
   * FIRST PAINT (issue #77): the same usage document, built from LOCAL state
   * only — no billing request, no per-account check-in read.
   *
   * Why this exists. The card used to paint nothing until ONE monolithic
   * document landed, and that document's tail awaited an upstream call per
   * account (credits for every pool member, check-in for every account, plus
   * the selected account's own two). Each of those has a 30-second timeout and
   * no retry, so a slow or throttled upstream stacked the waits and the panel
   * stayed empty for the reported 30–60 seconds — showing a "not signed in"
   * placeholder the whole time, because that is what an absent document
   * rendered as.
   *
   * The Host answers `detail=fast` from the credential store, the local pool
   * roster and the measurement caches, so this is one local round trip. It
   * carries the whole account table (the row list lives in the `pool` block),
   * which is the part the user came for; credits, check-in and the selected
   * account's live figures arrive with the full document that follows.
   *
   * Deliberately a SEPARATE callback instead of a `detail` argument on
   * `refreshUsage`: the ordering guard inside that callback is pinned by a
   * source test that counts its writes and freshness checks, and a second
   * write path in there would either break the pin or hide a real regression
   * behind it. Here the rules are simple and independent — this response never
   * downgrades a region that has already answered in full.
   */
  const refreshUsageFast = useCallback(async (
    region: WorkBuddyWebRegion,
    signal?: AbortSignal,
  ): Promise<void> => {
    const stale = usageGuard.current.begin(region)
    try {
      const response = await fetch(withWorkBuddyRegionFastDetail(WORKBUDDY_USAGE_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) return
      const value: unknown = await response.json().catch(() => undefined)
      const usage = value as WorkBuddyWebUsage | undefined
      if (usage === undefined) return
      // Superseded while in flight: a newer request owns this region now.
      if (stale()) return
      if (!mounted.current || signal?.aborted === true) return
      setStatusByRegion(prev => {
        const previous = prev[region]
        // A later first paint never REPLACES a region that already answered in
        // full: the fast document is the poorer one (it deliberately carries no
        // credits and no live pool figures), so writing it over a complete
        // snapshot would blank columns that were already on screen. Only a
        // region with nothing — or with a bare error from an attempt that never
        // loaded — takes the fast paint.
        if (previous !== undefined && previous.status === 'signed-in') return prev
        return { ...prev, [region]: usage }
      })
    } catch {
      // A failed first paint is not an error state: it is simply no paint yet,
      // and the full document is already on its way. The loading line stays up
      // until one of them lands.
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    // The FIRST-PAINT fetch runs before the full one (issue #77), for every
    // region and in parallel: the account table appears after one local round
    // trip instead of after the billing reads. The full document is then issued
    // as before, and because it begins its own generation after the fast one
    // has landed, the two cannot invalidate each other — the fast answer is
    // applied while it is still the newest request for that region.
    void (async () => {
      await Promise.all(WORKBUDDY_REGIONS.map(async region => {
        await refreshUsageFast(region, controller.signal)
      }))
      // The card was closed (or the tab switched) while the first paint was in
      // flight: the cleanup aborted this generation, so do not start the
      // expensive one against a dead signal.
      if (controller.signal.aborted) return
      // BOTH regions, not just the active tab: both switches are always rendered
      // in the tab bar, and the Host is where `regionOn` reads their state from.
      // Fetching only the active region left the other switch on the mirror
      // fallback until its tab was clicked — which is exactly the stale source
      // this card is trying to stop trusting.
      for (const region of WORKBUDDY_REGIONS) {
        void refreshUsage(region, controller.signal)
      }
    })()
    return () => { controller.abort() }
  }, [open, activeRegion, refreshUsage, refreshUsageFast])

  /**
   * The document this tab is rendering, or `undefined` before ANY has landed.
   *
   * The distinction is the point of issue #77: an absent document used to be
   * rendered as the `signed-out` placeholder below, so for the whole time the
   * usage route was out the card told a signed-in user they were not signed in
   * and offered "detect accounts" as the only remedy. `loading` now gates that
   * branch, and the placeholder is only a safe shape for the reads below it.
   */
  const loaded: WorkBuddyWebUsage | undefined = statusByRegion[activeRegion]
  const loading = loaded === undefined
  const status: WorkBuddyWebUsage = loaded
    ?? { status: 'signed-out', accounts: [], selectionExplicit: false }
  /**
   * Whether the ACTIVE region has a usable sign-in.
   *
   * The section tabs render only here: a signed-out card is one screen of
   * instructions, and splitting that into panels would hide the only thing it
   * has to say behind a tab.
   */
  const signedIn = status.status === 'signed-in'

  /**
   * Whether the ACTIVE region knows of any account at all.
   *
   * This is the poll's precondition in place of `status === 'signed-in'`. The
   * signed-in flag means "a credential resolves", which is false for a region
   * whose accounts exist but none is usable yet — exactly the state an import
   * or a fresh OAuth sign-in creates. Polling on it meant those regions never
   * refreshed, so the list stayed empty until the card was reopened.
   */
  const hasAccounts = status.status !== 'error' && status.accounts.length > 0

  useEffect(() => {
    // Gate on HAVING AN ACCOUNT, not on `signed-in`. A region whose only
    // accounts were just imported or just signed in through OAuth is not
    // `signed-in` (no credential resolves yet), so gating on that status left
    // the very case the import/sign-in produces with no poll at all — the new
    // account could only appear after the card was closed and reopened. An
    // account list is the real precondition for wanting a refresh.
    if (!open || !hasAccounts) return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refreshUsage(activeRegion, controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, activeRegion, refreshUsage, status.status])

  /**
   * Recover from a failed status read without a close/reopen.
   *
   * Keyed on the document identity (`loaded`), not on `status.status`: every
   * failed read writes a FRESH `{ status: 'error' }` object, so the identity
   * changes and the next attempt is armed. A successful read replaces it with a
   * new object too, which resets the counter through the branch below.
   */
  const statusRetries = useRef(0)
  useEffect(() => {
    if (!open || status.status !== 'error') {
      statusRetries.current = 0
      return
    }
    const delay = Math.min(STATUS_RETRY_MAX_MS, STATUS_RETRY_BASE_MS * 2 ** statusRetries.current)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      statusRetries.current += 1
      void refreshUsage(activeRegion, controller.signal)
    }, delay)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, activeRegion, refreshUsage, loaded])


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
    setAccountError(undefined)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_ACCOUNTS_REFRESH_PATH, activeRegion), {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      const body = await response.json() as { accounts?: { id: string }[]; dismissalsCleared?: boolean }
      if (!response.ok || !Array.isArray(body.accounts)) throw new Error(`HTTP ${response.status}`)
      // The Host VERIFIES that the hides are gone (see `clearDismissals`) and
      // says so; `false` means a locked vault file defeated both the unlink and
      // the rewrite. Without this line the card showed a successful scan while
      // the account the user was trying to recover stayed hidden — the button
      // silently not doing what its own tooltip promises.
      //
      // Absent means a Host that predates the flag, which is not a failure.
      if (body.dismissalsCleared === false) setAccountError(t('row.rescanHidesKept'))
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
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
   * Whether one region's sidebar credit line is shown — for the ACTIVE tab.
   *
   * Prefers the Host's answer, exactly like {@link regionOn} and for the same
   * measured reason: on the affected 0.1.7 deployment the browser's settings
   * mirror never picks up this plugin's writes, so a checkbox reading the mirror
   * rendered its previous value after a successful save and looked impossible to
   * turn off ("关闭不了"). The Host is the authority; the mirror is only a
   * fallback for a Host line that predates the field.
   */
  const creditsShownOn = (item: WorkBuddyWebRegion): boolean => {
    const usage = statusByRegion[item] as { showCreditsInMainUi?: unknown } | undefined
    const fromHost = usage?.showCreditsInMainUi
    if (typeof fromHost === 'boolean') return fromHost
    return regionCreditsShownOf(settingsScope?.getSnapshot().value, item)
  }

  /**
   * Whether the model may call the image tool in this region.
   *
   * Read off the Host's answer first, like {@link creditsShownOn} and for the
   * same measured reason — the browser mirror is stale for this namespace on the
   * affected 0.1.7 deployments, and here a stale `true` would be worse than a
   * dead checkbox: it would claim the spending capability is on.
   */
  const imageToolOn = (item: WorkBuddyWebRegion): boolean => {
    const usage = statusByRegion[item] as { imageToolEnabled?: unknown } | undefined
    if (typeof usage?.imageToolEnabled === 'boolean') return usage.imageToolEnabled
    return regionImageToolEnabledOf(settingsScope?.getSnapshot().value, item)
  }

  /**
   * Whether the model may call the video tool in this region. Mirrors
   * imageToolOn: read off the Host answer first, so a stale mirror cannot
   * leave the spending capability on. Absent is NOT consent.
   */
  const videoToolOn = (item: WorkBuddyWebRegion): boolean => {
    const usage = statusByRegion[item] as { videoToolEnabled?: unknown } | undefined
    if (typeof usage?.videoToolEnabled === 'boolean') return usage.videoToolEnabled
    return regionVideoToolEnabledOf(settingsScope?.getSnapshot().value, item)
  }

  /**
   * The video model pinned for one mode tag in this region, or `''` for "no pin".
   *
   * Same read order as {@link videoToolOn} and for the same measured reason: the
   * Host's answer first, because this namespace's browser mirror is stale on the
   * affected 0.1.7 deployments — a picker reading the mirror alone would keep
   * showing a pin the tool no longer uses.
   *
   * `''` rather than `undefined` because that is what the `<select>` needs for its
   * "default" row; the write path turns it back into "remove the key".
   */
  const preferredVideoModelOf = (item: WorkBuddyWebRegion, tag: string): string => {
    const usage = statusByRegion[item] as { preferredVideoModels?: unknown } | undefined
    const fromHost = usage?.preferredVideoModels
    if (typeof fromHost === 'object' && fromHost !== null) {
      const pinned = (fromHost as Record<string, unknown>)[tag]
      if (typeof pinned === 'string') return pinned
    }
    return regionPreferredVideoModelsOf(settingsScope?.getSnapshot().value, item)[tag] ?? ''
  }

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
   * Show or hide one region's sidebar credit line.
   *
   * This is the SECOND control for that line: the sidebar row also carries an
   * `×` that writes the same `regions.<region>.showCreditsInMainUi` flag, and
   * both go through the same landed-checked writer, so they can never disagree.
   * The checkbox stays because the sidebar is not always rendered (collapsed
   * rail, or a host that never mounts the footer slot).
   *
   * Writes the region's WHOLE slot — unchanged except for this one flag — so a
   * hide never drops the directory, model picks, budgets or pool preferences
   * that live alongside it.
   */
  /**
   * WHERE the active region's credit readout sits (issue #62).
   *
   * Read off the Host's usage answer, like {@link creditsShownOn} and for the
   * same measured reason: the browser's settings mirror for this namespace is
   * documented as stale on the affected 0.1.7 deployments, so a control reading
   * it would keep showing the previous seat after a successful write. Absent
   * means `composer`, which is what the Host resolves for a profile written
   * before the setting existed.
   */
  const creditPositionOn = (item: WorkBuddyWebRegion): WorkBuddyCreditPosition => {
    const usage = statusByRegion[item] as { creditPosition?: unknown } | undefined
    return usage?.creditPosition === 'stats' ? 'stats' : 'composer'
  }

  /**
   * Move one region's credit readout between its two seats.
   *
   * Same shape as {@link toggleCredits}: whole region slot in, landed check,
   * then a Host re-read. The re-read is load-bearing here for the same reason —
   * the control renders the Host's answer, so without it the picker keeps
   * showing the seat it had and the change looks like it did nothing.
   */
  const changeCreditPosition = async (item: WorkBuddyWebRegion, position: WorkBuddyCreditPosition): Promise<void> => {
    if (settingsScope === undefined) return
    setTogglingCredits(item)
    try {
      const regions = nextRegionCreditPosition(settingsScope.getSnapshot().value, item, position) as Record<string, unknown>
      const slot = regions[item]
      await writeRegionCreditPosition(
        settingsScope,
        item,
        position,
        typeof slot === 'object' && slot !== null ? slot as Record<string, unknown> : {},
      )
      await refreshUsage(item)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setTogglingCredits(undefined)
    }
  }

  const toggleCredits = async (item: WorkBuddyWebRegion, shown: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    setTogglingCredits(item)
    try {
      const regions = nextRegionCreditsShown(settingsScope.getSnapshot().value, item, shown) as Record<string, unknown>
      const slot = regions[item]
      await writeRegionCreditsShown(
        settingsScope,
        item,
        shown,
        typeof slot === 'object' && slot !== null ? slot as Record<string, unknown> : {},
      )
      // Re-read the Host so the checkbox renders the value that was just
      // committed. This is load-bearing, not a refresh for its own sake: the
      // checkbox reads `showCreditsInMainUi` off the Host's usage answer (the
      // browser mirror is stale for this namespace), so without this re-read the
      // box keeps showing its previous state and the toggle looks dead even
      // though it landed — the "关闭不了" report.
      await refreshUsage(item)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setTogglingCredits(undefined)
    }
  }

  /**
   * Whether the CLI route is mounted.
   *
   * Host answer first, settings mirror second, for the same measured reason as
   * `imageToolOn`: this namespace's browser mirror goes stale on the affected
   * deployments, and here a stale `true` would claim a spending capability is on.
   */
  const cliBridgeSwitchedOn = (): boolean => {
    if (cliBridgeOn !== undefined) return cliBridgeOn
    const fromHost = (statusByRegion[activeRegion] as { cliBridgeEnabled?: unknown } | undefined)?.cliBridgeEnabled
    if (typeof fromHost === 'boolean') return fromHost
    return cliBridgeEnabledOf(settingsScope?.getSnapshot().value)
  }

  /**
   * Flip the global CLI-route switch.
   *
   * The Host rebuilds only this route on the change (`cliBridge` is volatile),
   * so no provider stack is disposed and no in-flight request is interrupted.
   * Re-reads the usage afterwards so the box shows the COMMITTED value.
   */
  const toggleCliBridge = async (enabled: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    setCliBridgeBusy(true)
    try {
      await writeCliBridgeEnabled(settingsScope, enabled)
      if (mounted.current) setCliBridgeOn(enabled)
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setCliBridgeBusy(false)
    }
  }

  /**
   * The three upstream-identity switches, read the same three-level way the CLI
   * switch is: this card's own successful write, then the settings snapshot.
   *
   * Deliberately NOT reading them from the status document: these are
   * plugin-wide request-shape switches that the Host does not report per region,
   * and inventing a status field for them would create a second source of truth
   * for a value the settings document already owns.
   */
  const usageIdentityValue = (): boolean =>
    usageIdentityOn ?? upstreamSwitchOf(settingsScope?.getSnapshot().value, 'usageIdentity')

  const keepPromptLastValue = (): boolean =>
    keepPromptLastOn ?? upstreamSwitchOf(settingsScope?.getSnapshot().value, 'keepPromptLast')

  const sessionTitleValue = (): { enabled: boolean, model: string } => {
    const committed = sessionTitleOf(settingsScope?.getSnapshot().value)
    return sessionTitleOn === undefined ? committed : { ...committed, enabled: sessionTitleOn }
  }

  /** The custom injected prefixes in effect, used only to REPORT their count. */
  const extraInjectedPrefixes = (): string[] =>
    extraInjectedPrefixesOf(settingsScope?.getSnapshot().value)

  /**
   * The auto-continue block after a channel-gate refusal (see
   * `src/channel-continue.ts`), read the three-level way the other switches are.
   *
   * The cap and the text are read from the committed document rather than
   * mirrored in card state: only `enabled` has a control here, so a local copy of
   * the other two would be a second source of truth for values this card can
   * only READ.
   */
  const channelRejectContinueValue = (): { enabled: boolean, maxConsecutive: number, text: string } => {
    const committed = channelRejectContinueOf(settingsScope?.getSnapshot().value)
    return channelRejectContinueOn === undefined ? committed : { ...committed, enabled: channelRejectContinueOn }
  }

  /**
   * Flip one upstream-identity switch.
   *
   * No `refreshUsage` afterwards, unlike the CLI switch: these change the shape
   * of the NEXT request, not any value the usage document currently reports, so
   * re-reading the usage would only cost an upstream round-trip (the exact
   * stall #131 was about) for a number that cannot have moved.
   */
  const toggleUpstreamSwitch = async (
    field: 'usageIdentity' | 'keepPromptLast' | 'sessionTitle' | 'channelRejectContinue',
    enabled: boolean,
  ): Promise<void> => {
    if (settingsScope === undefined) return
    const setBusy = field === 'usageIdentity'
      ? setUsageIdentityBusy
      : field === 'keepPromptLast'
        ? setKeepPromptLastBusy
        : field === 'sessionTitle' ? setSessionTitleBusy : setChannelRejectContinueBusy
    const setOwn = field === 'usageIdentity'
      ? setUsageIdentityOn
      : field === 'keepPromptLast'
        ? setKeepPromptLastOn
        : field === 'sessionTitle' ? setSessionTitleOn : setChannelRejectContinueOn
    setBusy(true)
    try {
      // `sessionTitle` and `channelRejectContinue` are the two switches whose
      // field is an OBJECT: preserve their committed companions instead of
      // writing the transport shape away. Both carry values with no control on
      // this card (the title's target model, the cap and text here), so a bare
      // boolean would erase settings the user can only edit in the config file.
      const value = field === 'sessionTitle'
        ? { ...sessionTitleOf(settingsScope.getSnapshot().value), enabled }
        : field === 'channelRejectContinue'
          ? { ...channelRejectContinueOf(settingsScope.getSnapshot().value), enabled }
          : enabled
      await writeUpstreamSwitch(settingsScope, field, value)
      if (mounted.current) setOwn(enabled)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * The pinned model / effort of the CLI route, rendered the same way the
   * switch is: this card's own successful write first, then the Host's answer
   * (the authoritative mirror), then the settings snapshot. `''` is a real
   * value on every level: "nothing is pinned, the CLI runs on its own
   * default".
   */
  const cliBridgeModelValue = (): string => {
    if (cliBridgeModel !== undefined) return cliBridgeModel
    const fromHost = (statusByRegion[activeRegion] as { cliBridgeModel?: unknown } | undefined)?.cliBridgeModel
    if (typeof fromHost === 'string') return fromHost
    return cliBridgeModelOf(settingsScope?.getSnapshot().value)
  }

  const cliBridgeEffortValue = (): string => {
    if (cliBridgeEffort !== undefined) return cliBridgeEffort
    const fromHost = (statusByRegion[activeRegion] as { cliBridgeEffort?: unknown } | undefined)?.cliBridgeEffort
    if (typeof fromHost === 'string') return fromHost
    return cliBridgeEffortOf(settingsScope?.getSnapshot().value)
  }

  /**
   * Pin the model the local CLI runs on (or `''` for "back to the CLI's
   * default").
   *
   * The write is the same two-writer order as the switch; on a refusal the
   * optimistic value is REVERTED so the picker renders the committed value
   * again, and the error surfaces through the card's shared error line.
   */
  const pickCliBridgeModel = async (model: string): Promise<void> => {
    if (settingsScope === undefined) return
    setCliBridgeModelBusy(true)
    try {
      await writeCliBridgeModel(settingsScope, model)
      if (mounted.current) setCliBridgeModel(model)
    } catch (error: unknown) {
      if (mounted.current) {
        setCliBridgeModel(undefined)
        setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
      }
    } finally {
      if (mounted.current) setCliBridgeModelBusy(false)
    }
  }

  /**
   * Pin the reasoning effort the local CLI runs on, same write-and-revert
   * rule as {@link pickCliBridgeModel}.
   */
  const pickCliBridgeEffort = async (effort: string): Promise<void> => {
    if (settingsScope === undefined) return
    setCliBridgeEffortBusy(true)
    try {
      await writeCliBridgeEffort(settingsScope, effort)
      if (mounted.current) setCliBridgeEffort(effort)
    } catch (error: unknown) {
      if (mounted.current) {
        setCliBridgeEffort(undefined)
        setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
      }
    } finally {
      if (mounted.current) setCliBridgeEffortBusy(false)
    }
  }

  /**
   * The credential-region order of the CLI route, rendered with the same
   * write-first rule. Unlike the model and effort pins, `''` is NOT a
   * meaningful committed value here: it means "nothing pinned", and the route
   * then runs on the CLI's own default order — CN first. The picker therefore
   * shows that default instead of an empty answer.
   */
  const cliBridgeRegionOrderValue = (): string => {
    if (cliBridgeRegionOrder !== undefined) return cliBridgeRegionOrder
    const fromHost = (statusByRegion[activeRegion] as { cliBridgeRegionOrder?: unknown } | undefined)?.cliBridgeRegionOrder
    const committed = typeof fromHost === 'string' && fromHost !== ''
      ? fromHost
      : cliBridgeRegionOrderOf(settingsScope?.getSnapshot().value)
    return committed !== '' ? committed : 'cn,global'
  }

  /**
   * Pin the credential-region order the local CLI walks, same
   * write-and-revert rule as {@link pickCliBridgeModel}.
   */
  const pickCliBridgeRegionOrder = async (regionOrder: string): Promise<void> => {
    if (settingsScope === undefined) return
    setCliBridgeRegionOrderBusy(true)
    try {
      await writeCliBridgeRegionOrder(settingsScope, regionOrder)
      if (mounted.current) setCliBridgeRegionOrder(regionOrder)
    } catch (error: unknown) {
      if (mounted.current) {
        setCliBridgeRegionOrder(undefined)
        setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
      }
    } finally {
      if (mounted.current) setCliBridgeRegionOrderBusy(false)
    }
  }

  const toggleImageTool = async (item: WorkBuddyWebRegion, enabled: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    setTogglingCredits(item)
    try {
      const regions = nextRegionImageToolEnabled(settingsScope.getSnapshot().value, item, enabled) as Record<string, unknown>
      const slot = regions[item]
      await writeRegionImageToolEnabled(
        settingsScope,
        item,
        enabled,
        typeof slot === 'object' && slot !== null ? slot as Record<string, unknown> : {},
      )
      // Re-read the Host so the box renders the committed value, for the same
      // measured reason as `toggleCredits`: this namespace's browser mirror is
      // written by the Host endpoint and does not come back through `scope.set`.
      await refreshUsage(item)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setTogglingCredits(undefined)
    }
  }

  const toggleVideoTool = async (item: WorkBuddyWebRegion, enabled: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    setTogglingCredits(item)
    try {
      const regions = nextRegionVideoToolEnabled(settingsScope.getSnapshot().value, item, enabled) as Record<string, unknown>
      const slot = regions[item]
      await writeRegionVideoToolEnabled(
        settingsScope,
        item,
        enabled,
        typeof slot === 'object' && slot !== null ? slot as Record<string, unknown> : {},
      )
      // Re-read the Host so the box renders the committed value, for the same
      // measured reason as toggleImageTool: this namespace's browser mirror is
      // written by the Host endpoint and does not come back through scope.set.
      await refreshUsage(item)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setTogglingCredits(undefined)
    }
  }

  /**
   * Pin (or clear) one region's video model for one mode tag.
   *
   * `undefined` means "no pin": the picker's default row, which the tool reads as
   * "take the first model of that group". Both directions go through the same
   * landed-checked write as every other settings control, then re-read the Host —
   * a pin that reverted silently would leave the user believing the tool would
   * use a model it never picks.
   */
  const pinVideoModel = async (
    item: WorkBuddyWebRegion,
    tag: string,
    modelId: string | undefined,
  ): Promise<void> => {
    if (settingsScope === undefined) return
    setPinningVideoModel(tag)
    try {
      const regions = nextRegionPreferredVideoModels(settingsScope.getSnapshot().value, item, tag, modelId) as Record<string, unknown>
      const slot = regions[item]
      await writeRegionPreferredVideoModels(
        settingsScope,
        item,
        tag,
        modelId,
        typeof slot === 'object' && slot !== null ? slot as Record<string, unknown> : {},
      )
      await refreshUsage(item)
    } catch (error: unknown) {
      if (mounted.current) setAccountError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setPinningVideoModel(undefined)
    }
  }

  /**
   * Read the active region's media roster. Read-only and free (the same GET the
   * image tool performs), so it is safe to run whenever the capability panel is
   * shown; `refresh` bypasses the Host's 5-minute cache for the explicit
   * button, because a user who just enabled an image model upstream should not
   * have to wait out a TTL to see it.
   *
   * A failure lands in `mediaError` INSIDE the block and nowhere else: it must
   * not touch `statusByRegion`, or one unreachable roster would replace the
   * whole panel with an error screen.
   */
  const loadMediaModels = useCallback(async (
    region: WorkBuddyWebRegion,
    refresh: boolean,
    signal?: AbortSignal,
  ): Promise<void> => {
    try {
      const url = refresh
        ? `${withWorkBuddyRegion(WORKBUDDY_MEDIA_MODELS_PATH, region)}&refresh=1`
        : withWorkBuddyRegion(WORKBUDDY_MEDIA_MODELS_PATH, region)
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const models = readMediaRoster(await response.json().catch(() => undefined))
      if (models === undefined) throw new Error(`HTTP ${response.status}`)
      if (!mounted.current || signal?.aborted === true) return
      setMediaByRegion(prev => ({ ...prev, [region]: models }))
      setMediaError(undefined)
    } catch (error: unknown) {
      if (!mounted.current || signal?.aborted === true) return
      // The message only: `row.mediaModelsError` supplies the sentence.
      setMediaError(error instanceof Error ? error.message : t('row.requestFailed'))
    }
  }, [t])
  /**
   * Regions whose media roster has already been asked for, so showing the
   * capability panel does not re-read the roster on every render — and so a
   * FAILED read is not retried in a loop. The explicit "re-read" button is the
   * only thing that asks twice, because a user who just enabled a model
   * upstream is the one case where a fresh answer is the point.
   */
  const mediaRequested = useRef(new Set<WorkBuddyWebRegion>())

  /**
   * Read the media roster once per region, when the capability panel is opened.
   *
   * Lazy rather than alongside the usage fetch: the roster is only visible in
   * this one panel, and the usage fetch runs for BOTH regions on every open. If
   * the secret store happens to hold a credential for the region the user is not
   * looking at, an eager read would spend a request nobody asked for.
   */
  useEffect(() => {
    if (!open || panel !== 'capabilities' || !hasAccounts) return
    if (mediaRequested.current.has(activeRegion)) return
    mediaRequested.current.add(activeRegion)
    const controller = new AbortController()
    void loadMediaModels(activeRegion, false, controller.signal)
    return () => { controller.abort() }
  }, [open, panel, activeRegion, hasAccounts, loadMediaModels])

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
          // The `off` answers are CARRIED FORWARD, not re-synced from upstream:
          // they exist precisely because the upstream declaration is wrong for
          // these models (issue #34), so re-deriving them from a refresh would
          // undo the user's correction. Only the directory is replaced.
          // The `off` selection is carried forward, not re-synced from upstream:
          // it exists precisely because the upstream declaration is wrong for
          // some models (issue #34), so re-deriving it from a refresh would undo
          // the user's correction. Only the directory is replaced.
          offIds: new Set(activeOffIds),
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
  /**
   * The LIVE load levels, keyed by model id.
   *
   * Read off the Host's answer rather than from the model list: the list is the
   * SAVED roster the user edits, and a saved roster has no load level in it
   * (load is a fact about this minute, not a setting — `src/busy.ts`). A model
   * the probe did not answer for simply has no entry, and draws nothing.
   */
  const busyLevels = status.status === 'signed-in' ? status.busyLevels ?? {} : {}
  const savedEnabledIds = status.status === 'signed-in' ? new Set(status.enabledModelIds) : new Set<string>()
  const activeEnabledIds = draft?.enabledIds ?? savedEnabledIds
  const savedImageIds = status.status === 'signed-in' ? new Set(status.imageModelIds) : new Set<string>()
  const activeImageIds = draft?.imageIds ?? savedImageIds
  // The `off` level (issue #34): `offModelIds` is the saved set of models that
  // offer it; a row not in the set has it withdrawn.
  const savedOffIds = status.status === 'signed-in' ? new Set(status.offModelIds) : new Set<string>()
  const activeOffIds = draft?.offIds ?? savedOffIds
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
        offIds: new Set(activeOffIds),
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

  /**
   * Flip one row's `off` answer (issue #34).
   *
   * Writes an EXPLICIT answer in both directions, so the built-in rule is only
   * consulted while the user has no opinion. That is also why there is no
   * "reset" control: once an answer matches the rule, the two are
   * indistinguishable in effect, and the tooltip already names the override.
   */
  // Models on the reviewed refusal table, plus the ones whose `off` tier this
  // process actually saw refused (issue #83). The checkbox stays visible but
  // disabled: hiding it would make a saved tick invisible, and the user would
  // have no way to discover why compaction kept failing.
  const offBlocked = (model: WorkBuddyWebModel): boolean =>
    model.reasoning?.offRefused === true || model.reasoning?.refusesOff === true

  const toggleOff = (modelId: string): void => {
    editDraft(current => {
      const next = new Set(current.offIds)
      if (!next.delete(modelId)) next.add(modelId)
      return { ...current, offIds: next }
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
   * Probe ONE model (the route refuses more than one — see `web-status.ts`,
   * where the cap is the gate that keeps a whole-roster sweep from becoming a
   * single unaccounted spend). The HOST owns the request: the browser half sends
   * only a model id and gets an outcome back, because the credential must never
   * cross to the page.
   *
   * The plural name is historical: this used to post a whole list in one request
   * before 3.0.0 removed the batch button. It is kept because callers that
   * already hold a list (the two sweep buttons below) can still express "test
   * these" without a second code path — it just sends them one at a time.
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
      const landedResults = body.results as WorkBuddyWebProbeResult[]
      // Mirror into the ref FIRST: the sweep loop reads verdicts from it, and a
      // state update is not observable until React re-renders.
      probesRef.current = { ...probesRef.current }
      for (const result of landedResults) probesRef.current[result.modelId] = result
      setProbes(previous => {
        const regionResults = { ...(previous[activeRegion] ?? {}) }
        for (const result of landedResults) {
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

  /**
   * ONE-CLICK availability sweep over several models (issue #61 follow-up, by
   * request of the maintainer after comparing with the sibling `trae` plugin).
   *
   * WHY IT IS A CLIENT-SIDE LOOP. The route accepts exactly ONE model id and
   * refuses more, and that cap is deliberate: it is what stops a stale bundle or
   * a hand-rolled client from turning one click into an unaccounted spend over a
   * whole roster (3.0.0's reason for deleting the original batch button). A
   * sweep is therefore expressed the way trae expresses it — one model per
   * request, from here — which keeps that gate intact and has a second benefit
   * the host-side batch never had: each row's verdict appears the moment it is
   * known, instead of the card sitting blank until the slowest model answers.
   *
   * COST is stated in the button's own hint rather than in a confirmation
   * dialog: a probe sends a real-volume request, so a sweep over a whole catalog
   * spends real credit (measured 0.01 per probe at the current default size, on
   * this machine — see the hint text). The user asked for the hint form, and it
   * matches the sibling plugin.
   *
   * SEQUENTIAL, not parallel: a probe exists to discover rate limits, and firing
   * a roster's worth of requests at once is the surest way to create one — the
   * same reason the host's own loop was serial.
   *
   * STOPS ON THE FIRST AUTH FAILURE: a rejected credential answers identically
   * for every remaining model, so continuing would only spend credit to collect
   * the same answer again. Other failures (a rate limit on one model) do NOT
   * stop the sweep — that is information about that model, and stopping would
   * hide it.
   *
   * The summary counts what the run actually established, so a stopped or
   * failed sweep cannot read as a complete green roster.
   */
  const sweepModels = async (modelIds: readonly string[]): Promise<void> => {
    if (modelIds.length === 0) return
    setProbeError(undefined)
    setSweepSummary(undefined)
    setSweeping({ done: 0, total: modelIds.length })
    let available = 0
    let measured = 0
    try {
      for (const [index, modelId] of modelIds.entries()) {
        if (!mounted.current) return
        await probeModels([modelId])
        const result = probesRef.current[modelId]
        measured += 1
        if (result?.outcome === 'ok') available += 1
        if (result?.outcome === 'credential-rejected') {
          // Every remaining model would answer the same way; the summary below
          // says "N of M measured" so the shortfall is visible, not silent.
          if (mounted.current) setProbeError(t('row.modelsTestAuth'))
          break
        }
        if (mounted.current) setSweeping({ done: index + 1, total: modelIds.length })
      }
      if (mounted.current) setSweepSummary(t('row.modelsTestDone', { available, total: measured }))
    } finally {
      if (mounted.current) setSweeping(undefined)
    }
  }

  /** Sweep the models this region has ENABLED (the current draft's selection). */
  const sweepEnabledModels = (): void => {
    void sweepModels(visibleModels.filter(model => activeEnabledIds.has(model.id)).map(model => model.id))
  }

  /**
   * Measure OUTPUT SPEED for one or more models (issue #92).
   *
   * One model per request, like every other spending route: the upstream route
   * refuses more than one id, and that cap is what keeps a stale bundle from
   * turning a click into an unaccounted spend over a whole roster. The loop for a
   * sweep therefore lives here, not on the Host.
   *
   * A failed model does NOT abort the sweep. Unlike an availability sweep — where
   * a rejected credential answers identically for every remaining model and
   * continuing only spends credit to hear the same answer — a speed failure is
   * specific to that model, so stopping would hide the one thing the sweep was
   * asked to find out.
   */
  const measureTpsFor = async (modelIds: readonly string[]): Promise<void> => {
    if (modelIds.length === 0) return
    setTpsProbing(previous => {
      const next = { ...previous }
      for (const id of modelIds) next[id] = true
      return next
    })
    try {
      for (const [index, modelId] of modelIds.entries()) {
        if (!mounted.current) return
        try {
          const response = await fetch(withWorkBuddyRegion(WORKBUDDY_TPS_PATH, activeRegion), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ modelIds: [modelId] }),
          })
          const body = await response.json().catch(() => undefined) as
            | { results?: WorkBuddyWebTpsResult[]; error?: string }
            | undefined
          if (!response.ok || !Array.isArray(body?.results)) {
            throw new Error(body?.error ?? `HTTP ${String(response.status)}`)
          }
          if (!mounted.current) return
          const landed = body.results[0]
          if (landed !== undefined) {
            setTpsResults(previous => ({ ...previous, [landed.modelId]: landed }))
            setTpsMeasuredAt(previous => ({ ...previous, [landed.modelId]: Date.now() }))
          }
        } catch (error: unknown) {
          if (!mounted.current) return
          setProbeError(error instanceof Error ? error.message : t('row.requestFailed'))
        } finally {
          if (mounted.current) {
            setTpsProbing(previous => {
              const next = { ...previous }
              delete next[modelId]
              return next
            })
          }
        }
        if (mounted.current) setTpsSweeping({ done: index + 1, total: modelIds.length })
      }
    } finally {
      if (mounted.current) setTpsSweeping(undefined)
    }
  }

  /**
   * Whether ANY speed run is in flight, for the sweep button's disabled state.
   *
   * NOT `tpsProbing !== undefined`. `tpsProbing` is a record that is ALWAYS an
   * object, so that comparison is permanently true and the button was
   * permanently disabled — the defect this corrects. The other two sweep buttons
   * compare `sweeping !== undefined` because `sweeping` really is an
   * `{done,total} | undefined` pair; this map has no such absent state, so the
   * emptiness of its keys is what "busy" means.
   */
  const tpsBusy = Object.keys(tpsProbing).length > 0

  /**
   * Sweep speed for the models this region has ENABLED.
   *
   * Enabled-only rather than the whole catalog: a speed run is three real
   * requests, so covering a 20-model roster would cost 60 requests to learn
   * something about 18 models the user does not use.
   */
  const sweepTpsEnabledModels = (): void => {
    void measureTpsFor(visibleModels.filter(model => activeEnabledIds.has(model.id)).map(model => model.id))
  }

  /**
   * Sweep EVERY model in the region's live catalog, enabled or not.
   *
   * Deliberately the whole VISIBLE catalog and nothing else: those are the ids
   * the host can validate against its own catalog, so this cannot spend credit
   * on an id that only exists in a config file.
   */
  const sweepAllModels = (): void => {
    void sweepModels(visibleModels.map(model => model.id))
  }

  /**
   * Sweep speed for the WHOLE visible catalog.
   *
   * Same rule as {@link sweepAllModels}: the visible catalog only, because those
   * are the ids the host can validate against its own roster.
   */
  const sweepTpsAllModels = (): void => {
    void measureTpsFor(visibleModels.map(model => model.id))
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
        // #168: the user has now EDITED the boxes, so this array is the whole
        // answer. Without this, an explicit untick of a verified-multimodal
        // model would be re-ticked by the Host's seed on the next read — undoing
        // a correction the user just made.
        imageSelectionExplicit: true,
        offModelIds: [...activeOffIds],
        contextBudgets: activeContextBudgets,
      })
      // Loading stops with the WRITE. Refreshing usage awaits the upstream
      // billing route, which can wait on a 30-second per-account timeout, so
      // including it in the save's loading state told a user their edits were
      // still saving long after the verified write had landed (issue #131).
      // The refresh may still fail, but that is a display freshness problem:
      // the saved draft stays committed and the next poll repairs the figures.
      if (mounted.current) setSaving(false)
      discardModels()
      void refreshUsage(activeRegion)
      return
    } catch (error: unknown) {
      // Drafts stay dirty on failure, so the button remains pressable for a
      // retry; the reason is shown instead of a silent unhandled rejection.
      // A contention refusal gets the remedy appended — the raw message names
      // only a temp file (see `isFileContentionWriteError`).
      if (mounted.current) {
        const reason = error instanceof Error ? error.message : t('row.requestFailed')
        setSaveError(isFileContentionWriteError(error) ? `${reason}${t('row.saveContentionHint')}` : reason)
      }
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

  /**
   * Account-adding and account-migration controls, defined ONCE and rendered
   * in both sign-in states: inside the pool settings block when an account
   * exists, and in the signed-out branch when it does not (the pool section is
   * not rendered there at all). Two JSX copies would be free to drift, and the
   * two states are the same feature — a user who learns these controls in one
   * must find them in the same order in the other.
   */
  const accountTools = (
    <>
      <OAuthSignIn
        t={t}
        region={activeRegion}
        // A finished sign-in stores a credential the Host's snapshot predates;
        // re-read so the new account appears while the veil is still up.
        onAdded={() => refreshUsage(activeRegion)}
      />
      <AccountTransfer
        t={t}
        region={activeRegion}
        // An import writes vault entries the Host already had no snapshot of;
        // re-read so the new accounts join the table while the veil is still
        // up, instead of on some later poll the region may not even run.
        onChanged={() => refreshUsage(activeRegion)}
        // The error branch reports no accounts, and the transfer section is
        // not rendered there — passing an empty list keeps the type honest
        // without inventing a fallback that could only ever be wrong.
        accounts={status.status === 'error'
          ? []
          : status.accounts.map(account => ({ id: account.id, accountName: account.accountName }))}
      />
    </>
  )

  /**
   * WHERE the readout sits — a two-way choice, active tab's region only
   * (issue #62).
   *
   * It sits directly under the show/hide switch because the two answer one
   * question together ("show it, and where"), and because a user only reaches
   * for this when the default seat is unavailable — typically after installing
   * another plugin that occupies the composer row. Rendered as a `<select>`
   * rather than a pair of radios so it stays one compact row.
   *
   * LABEL LEFT, CONTROL RIGHT — the reverse of the first draft, which put the
   * select first. Under an always-visible caption the label is what the eye
   * scans for ("显示位置"), so it leads and the value follows; leading with the
   * control made it read as a second checkbox whose box happened to be a
   * dropdown. It also matches the reference settings screen, where the option
   * name sits left of its picker.
   *
   * Disabled with the region, exactly like the switch: a region that is off has
   * no readout to place.
   */
  const creditPositionPicker = (
    <select
      className="dsm-workbuddy-credit-position"
      value={activeRegionOn ? creditPositionOn(activeRegion) : 'composer'}
      disabled={!activeRegionOn || togglingCredits === activeRegion || !canWrite || saving || poolBusy}
      aria-label={t('row.creditPositionAria', { region: activeRegion === 'cn' ? t('row.tabCn') : t('row.tabGlobal') })}
      onChange={(event: { currentTarget: { value: string } }) => {
        void changeCreditPosition(activeRegion, event.currentTarget.value === 'stats' ? 'stats' : 'composer')
      }}
    >
      <option value="composer">{t('row.creditPositionComposer')}</option>
      <option value="stats">{t('row.creditPositionStats')}</option>
    </select>
  )

  /*
   * The caption under the picker, ALWAYS visible regardless of whether the
   * picker can be used.
   *
   * It states what the setting MEANS, not what its options say — the reference
   * card's caption works the same way, and it is the copy that makes the
   * indented control legible as a child of the switch rather than as a stray
   * row. Restating the option names only when the control is greyed out is what
   * the DISABLED caption below does; folding both duties into one string is why
   * an always-visible line would either repeat the options pointlessly or leave
   * a dead picker unexplained.
   */
  const creditPositionCaption = t('row.creditPositionHintInline')

  /* Shown only when the picker is inert. It names the CAUSE (the switch above)
     and the FIX, which the generic caption deliberately does not. */
  const creditPositionDisabledCaption = t('row.creditPositionDisabledHint')

  /*
   * THE CAPABILITY SWITCHES: what the plugin may DO for this tab (route work to
   * the local CLI, let the model buy an image) and what it may SHOW (the credit
   * readout and where it sits).
   *
   * Order is deliberate and is not by region: SPEND first, display last. The
   * first two cost credits without asking again; the last two only change what
   * is drawn.
   *
   * Placement history, because this block keeps drifting: it started as two
   * boxes side by side under the tab bar (read as ONE shared setting rather than
   * as this tab's), moved into the ACCOUNT POOL's heading row as `headerExtra`
   * (shared a baseline with 「账号池」 and pushed the serving-account badge off to
   * the far right), then became a headed section (its far-right control column
   * split each sentence into a label at one edge and a control at the other).
   * It now has a SECTION of its own — 「能力」 — because these are grants, not
   * account facts, and because each is due sub-options (a working directory for
   * the CLI route, a price cap or size for the image tool) that a flat list
   * competing with the account table had no room for.
   *
   * The layout inside is still the reference card's: a checkbox on a line that
   * commits on the click, the explanation UNDER its label, and the picker that
   * belongs to a switch indented to that switch's label.
   *
   * It renders OUTSIDE AccountPool (below), not through `headerExtra`, so it
   * survives a Host that reports no pool state instead of vanishing with the
   * section that happened to carry it.
   */
  /**
   * The image tool opt-in, rendered above the credit preferences.
   *
   * It sits first because it is the only preference here that authorizes SPEND
   * rather than display: the credit line is a readout, this one lets the model
   * buy an image without asking again. Shown on BOTH tabs: each gateway now
   * publishes its own `text-to-image` model (CN `hunyuan-image-alpha`,
   * international `hy-image-3.5`, measured 2026-10-25), so the global box is no
   * longer a control that can never do anything. The flag is per-region and the
   * tool uses whichever region is BOTH enabled and switched on (CN first), so
   * ticking it here only ever authorizes spending on THIS tab.
   */
  const imageToolPreference = (
    <label className="dsm-workbuddy-pref" title={t('row.imageToolHint')}>
      <input
        type="checkbox"
        /* Its OWN class, not the shared `.dsm-workbuddy-pref-check`: that class
           is the contract the credit-switch suite selects on ("exactly one
           switch"), and a second element carrying it makes every
           single-checkbox selector resolve to the wrong box. Same styling,
           carried by the mirrored rule in `styles.ts`. */
        className="dsm-workbuddy-image-tool-check"
        checked={activeRegionOn ? imageToolOn(activeRegion) : false}
        disabled={!activeRegionOn || togglingCredits === activeRegion || !canWrite || saving || poolBusy}
        onChange={(event: { target: { checked: boolean } }) => {
          void toggleImageTool(activeRegion, event.target.checked)
        }}
      />
      <span className="dsm-workbuddy-pref-copy">
        <span className="dsm-workbuddy-pref-label">{t('row.imageToolLabel')}</span>
        <span className="dsm-workbuddy-pref-hint">{t('row.imageToolHint')}</span>
      </span>
    </label>
  )
  /**
   * The video-tool opt-in. Same shape and same stakes as imageToolPreference:
   * per-region, off means the tool is NOT registered at all (not "registered
   * but refusing"), so a tick here only ever authorizes spending on THIS tab.
   * The tool is an async task that runs tens of seconds to minutes.
   */
  const videoToolPreference = (
    <label className="dsm-workbuddy-pref" title={t('row.videoToolHint')}>
      <input
        type="checkbox"
        /* Its OWN class (see imageToolPreference for why it must not be the
           shared dsm-workbuddy-pref-check class): a second element carrying
           that class would break the credit-switch suite selector. */
        className="dsm-workbuddy-video-tool-check"
        checked={activeRegionOn ? videoToolOn(activeRegion) : false}
        disabled={!activeRegionOn || togglingCredits === activeRegion || !canWrite || saving || poolBusy}
        onChange={(event: { target: { checked: boolean } }) => {
          void toggleVideoTool(activeRegion, event.target.checked)
        }}
      />
      <span className="dsm-workbuddy-pref-copy">
        <span className="dsm-workbuddy-pref-label">{t('row.videoToolLabel')}</span>
        <span className="dsm-workbuddy-pref-hint">{t('row.videoToolHint')}</span>
      </span>
    </label>
  )
  /**
   * What this region can actually draw. The IMAGE rows stay read-only; the
   * VIDEO rows are pinnable in `videoModelPreference` below.
   *
   * The roster used to be read-only because every tag group held exactly one
   * model in both regions (measured 2026-10-25), so a dropdown would have been a
   * choice of one. That stopped being true for VIDEO: CN publishes two models
   * per video tag (`kling-video-v3` and `minimax-video-h3`) — the very
   * "两个模型能不能挑" question. The pin therefore lives in its own block below,
   * and the roster keeps answering "can this tab draw at all, and with what".
   *
   * Indented like the position picker, because it is a property of the switch
   * above it rather than a fourth independent setting.
   */
  const mediaTagLabels: Record<string, string> = {
    'text-to-image': t('row.mediaTagTextToImage'),
    'image-to-image': t('row.mediaTagImageToImage'),
    'text-to-video': t('row.mediaTagTextToVideo'),
    'image-to-video': t('row.mediaTagImageToVideo'),
  }
  const activeMedia = mediaByRegion[activeRegion]
  /**
   * The per-mode video-model picker.
   *
   * Hidden unless the video tool is actually authorized on this tab
   * (`activeRegionOn && videoToolOn`): a pin only ever reaches the tool when that
   * region registers it, so showing the choice elsewhere would invite a decision
   * that changes nothing.
   *
   * One row per VIDEO tag, and only for tags this region's catalog still serves
   * — the tool cannot use a pin for a group that has no models. The "default"
   * row is not decoration: it is the only way back to "take the group's first
   * model", and clearing the pin DELETES the key rather than storing an empty
   * string (see `nextRegionPreferredVideoModels`).
   *
   * A pinned id the catalog no longer carries renders the "default" row too:
   * that is exactly what the tool does with it (falls back rather than failing),
   * so showing it honestly beats a select box displaying an option it does not
   * itself offer.
   */
  const videoModelTags = ['text-to-video', 'image-to-video'] as const
  const videoModelPreference = !(activeRegionOn && videoToolOn(activeRegion)) || activeMedia === undefined
    ? null
    : (
      <div className="dsm-workbuddy-pref dsm-workbuddy-media">
        <span className="dsm-workbuddy-pref-copy">
          <span className="dsm-workbuddy-pref-label">{t('row.videoModelLabel')}</span>
          <span className="dsm-workbuddy-pref-hint">{t('row.videoModelHint')}</span>
          {videoModelTags.map(tag => {
            const group = activeMedia.filter(model => model.tags.includes(tag))
            if (group.length === 0) return null
            const pinned = preferredVideoModelOf(activeRegion, tag)
            return (
              <label key={tag} className="dsm-workbuddy-media-row">
                <span className="dsm-workbuddy-media-tag">{mediaTagLabels[tag] ?? tag}</span>
                <select
                  className="dsm-workbuddy-video-model-select"
                  value={group.some(model => model.id === pinned) ? pinned : ''}
                  disabled={!canWrite || saving || poolBusy || pinningVideoModel !== undefined}
                  onChange={(event: { target: { value: string } }) => {
                    const next = event.target.value
                    void pinVideoModel(activeRegion, tag, next === '' ? undefined : next)
                  }}
                >
                  <option value="">{t('row.videoModelDefault')}</option>
                  {group.map(model => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </select>
              </label>
            )
          })}
        </span>
      </div>
    )
  const mediaModelsPreference = (
    <div className="dsm-workbuddy-pref dsm-workbuddy-media">
      <span className="dsm-workbuddy-pref-copy">
        <span className="dsm-workbuddy-pref-lead">
          <span className="dsm-workbuddy-pref-label">{t('row.mediaModelsLabel')}</span>
          {/* Not `dsm-workbuddy-pref-indent`: that class belongs to the credit
              position picker and the suite resolves it with querySelector,
              which must keep landing on the picker. The roster is a block of
              its own anyway — it has a lead row, a hint and a list — so it is
              aligned by its own style rule instead of borrowing the picker's. */}
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={mediaBusy || !activeRegionOn}
            onClick={() => {
              setMediaBusy(true)
              void loadMediaModels(activeRegion, true).finally(() => {
                if (mounted.current) setMediaBusy(false)
              })
            }}
          >
            {mediaBusy ? t('row.mediaModelsRefreshing') : t('row.mediaModelsRefresh')}
          </button>
        </span>
        <span className="dsm-workbuddy-pref-hint">{t('row.mediaModelsHint')}</span>
        {mediaError !== undefined
          ? <span className="dsm-workbuddy-media-error">{t('row.mediaModelsError', { message: mediaError })}</span>
          : activeMedia === undefined
            ? null
            : activeMedia.length === 0
              ? <span className="dsm-workbuddy-media-empty">{t('row.mediaModelsEmpty')}</span>
              : <ul className="dsm-workbuddy-media-list">
                  {activeMedia.map(model => (
                    <li key={model.id} className="dsm-workbuddy-media-row">
                      <span className="dsm-workbuddy-media-name">{model.name}</span>
                      <span className="dsm-workbuddy-media-id">{model.id}</span>
                      <span className="dsm-workbuddy-media-tags">
                        {model.tags.map(tag => (
                          <span key={tag} className="dsm-workbuddy-media-tag">
                            {mediaTagLabels[tag] ?? tag}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>}
      </span>
    </div>
  )

  /**
   * The CLI-route switch.
   *
   * GLOBAL, so it is not gated on the active tab's provider being on — the route
   * pulls its credential from whichever region still has a signed-in account.
   * Its own class (not `.dsm-workbuddy-pref-check`) for the same reason the image
   * box has one: the credit-switch suite's "exactly one switch" selector must
   * keep resolving to the credit box alone.
   */
  const cliBridgePreference = (
    <label className="dsm-workbuddy-pref" title={t('row.cliBridgeHint')}>
      <input
        type="checkbox"
        className="dsm-workbuddy-cli-bridge-check"
        checked={cliBridgeSwitchedOn()}
        disabled={!canWrite || saving || poolBusy || cliBridgeBusy}
        onChange={(event: { target: { checked: boolean } }) => {
          void toggleCliBridge(event.target.checked)
        }}
      />
      <span className="dsm-workbuddy-pref-copy">
        <span className="dsm-workbuddy-pref-label">{t('row.cliBridgeLabel')}</span>
        <span className="dsm-workbuddy-pref-hint">{t('row.cliBridgeHint')}</span>
      </span>
    </label>
  )

  /**
   * The two quick-adjust pins of the CLI route, rendered under its switch the
   * way the seat picker sits under its switch: indented, and only while the
   * switch is ON — the pickers configure the route the switch turned on, and
   * they disappear together with it.
   *
   * The model options are the active tab's LIVE catalog (`visibleModels`), so
   * they follow the upstream instead of a hardcoded list; a pinned value the
   * catalog does not list is still offered as its own option rather than
   * vanishing from the select. The effort options are the six CLI tiers,
   * narrowed to the pinned model's `reasoning.supportedEfforts` when that
   * model is in the catalog and names tiers the CLI knows.
   */
  const cliBridgeModelPinned = cliBridgeModelValue()
  const cliBridgeModelOptions = visibleModels.map(model => ({
    value: model.id,
    label: model.name !== model.id ? model.name : model.id,
  }))
  if (cliBridgeModelPinned !== '' && !cliBridgeModelOptions.some(option => option.value === cliBridgeModelPinned)) {
    cliBridgeModelOptions.push({ value: cliBridgeModelPinned, label: cliBridgeModelPinned })
  }

  const cliBridgeEffortPinned = cliBridgeEffortValue()
  const pinnedCliBridgeModel = visibleModels.find(model => model.id === cliBridgeModelPinned)
  const pinnedCliBridgeTiers = pinnedCliBridgeModel?.reasoning?.supportedEfforts
  const cliBridgeEffortLevels: string[] = ((): string[] => {
    if (pinnedCliBridgeTiers === undefined || pinnedCliBridgeTiers.length === 0) {
      return [...CLI_BRIDGE_EFFORT_LEVELS]
    }
    const known = CLI_BRIDGE_EFFORT_LEVELS.filter(level => (pinnedCliBridgeTiers as readonly string[]).includes(level))
    return known.length > 0 ? known : [...CLI_BRIDGE_EFFORT_LEVELS]
  })()
  if (cliBridgeEffortPinned !== '' && !cliBridgeEffortLevels.includes(cliBridgeEffortPinned)) {
    cliBridgeEffortLevels.push(cliBridgeEffortPinned)
  }

  const cliBridgeRegionOrderPinned = cliBridgeRegionOrderValue()
  const cliBridgeRegionOrderOptions: { value: string, label: string }[] = CLI_BRIDGE_REGION_ORDERS.map(order => ({
    value: order,
    label: order === 'cn,global'
      ? t('row.cliBridgeRegionOrderCnFirst')
      : order === 'global,cn'
        ? t('row.cliBridgeRegionOrderGlobalFirst')
        : order === 'cn'
          ? t('row.cliBridgeRegionOrderCnOnly')
          : t('row.cliBridgeRegionOrderGlobalOnly'),
  }))
  if (cliBridgeRegionOrderOptions.every(option => option.value !== cliBridgeRegionOrderPinned)) {
    cliBridgeRegionOrderOptions.push({ value: cliBridgeRegionOrderPinned, label: cliBridgeRegionOrderPinned })
  }

  const cliBridgePickers = (
    <div
      className="dsm-workbuddy-pref dsm-workbuddy-pref-indent"
      title={t('row.cliBridgePickersHint')}
    >
      <span className="dsm-workbuddy-pref-copy">
        <span className="dsm-workbuddy-pref-lead dsm-workbuddy-cli-bridge-pickers">
          <label className="dsm-workbuddy-cli-bridge-pick" title={t('row.cliBridgeModelHint')}>
            <span className="dsm-workbuddy-pref-label">{t('row.cliBridgeModelLabel')}</span>
            <select
              className="dsm-workbuddy-cli-bridge-select"
              value={cliBridgeModelPinned}
              disabled={!canWrite || saving || poolBusy || cliBridgeModelBusy || cliBridgeEffortBusy || cliBridgeRegionOrderBusy}
              aria-label={t('row.cliBridgeModelAria')}
              onChange={(event: { currentTarget: { value: string } }) => {
                void pickCliBridgeModel(event.currentTarget.value)
              }}
            >
              <option value="">{t('row.cliBridgeModelDefault')}</option>
              {cliBridgeModelOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="dsm-workbuddy-cli-bridge-pick" title={t('row.cliBridgeEffortHint')}>
            <span className="dsm-workbuddy-pref-label">{t('row.cliBridgeEffortLabel')}</span>
            <select
              className="dsm-workbuddy-cli-bridge-select"
              value={cliBridgeEffortPinned}
              disabled={!canWrite || saving || poolBusy || cliBridgeModelBusy || cliBridgeEffortBusy || cliBridgeRegionOrderBusy}
              aria-label={t('row.cliBridgeEffortAria')}
              onChange={(event: { currentTarget: { value: string } }) => {
                void pickCliBridgeEffort(event.currentTarget.value)
              }}
            >
              <option value="">{t('row.cliBridgeEffortDefault')}</option>
              {cliBridgeEffortLevels.map(level => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>
          <label className="dsm-workbuddy-cli-bridge-pick" title={t('row.cliBridgeRegionOrderHint')}>
            <span className="dsm-workbuddy-pref-label">{t('row.cliBridgeRegionOrderLabel')}</span>
            <select
              className="dsm-workbuddy-cli-bridge-select"
              value={cliBridgeRegionOrderPinned}
              disabled={!canWrite || saving || poolBusy || cliBridgeModelBusy || cliBridgeEffortBusy || cliBridgeRegionOrderBusy}
              aria-label={t('row.cliBridgeRegionOrderAria')}
              onChange={(event: { currentTarget: { value: string } }) => {
                void pickCliBridgeRegionOrder(event.currentTarget.value)
              }}
            >
              {cliBridgeRegionOrderOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </span>
        <span className="dsm-workbuddy-pref-hint">{t('row.cliBridgePickersHint')}</span>
      </span>
    </div>
  )

  /**
   * The upstream-identity switches (issue #133 suggestions 2 and 3).
   *
   * These govern what the gateway SEES and how it files the call, not which
   * provider serves it, so they sit in their own group with their own heading
   * instead of the preference list below (which is all about the card's own
   * display choices). Every one of them was already settable by hand in
   * `cordis.patch.yml`; this is only a UI route to the same fields.
   *
   * ONE shared hint about reloading, not one per switch: all four are sampled
   * when the plugin mounts into the shim, so the rule and its reason are the
   * same sentence for each, and repeating it four times would bury it.
   */
  const upstreamSwitches = (
    <div className="dsm-workbuddy-prefs">
      <span className="dsm-workbuddy-pref-hint">{t('row.upstreamHint')}</span>
      {([
        ['usageIdentity', 'row.usageIdentityLabel', 'row.usageIdentityHint', usageIdentityValue(), usageIdentityBusy, setUsageIdentityOn],
        ['keepPromptLast', 'row.keepPromptLastLabel', 'row.keepPromptLastHint', keepPromptLastValue(), keepPromptLastBusy, setKeepPromptLastOn],
        ['sessionTitle', 'row.sessionTitleLabel', 'row.sessionTitleHint', sessionTitleValue().enabled, sessionTitleBusy, setSessionTitleOn],
      ] as const).map(([field, labelKey, hintKey, on, busy, setOwn]) => (
        <label key={field} className="dsm-workbuddy-pref dsm-workbuddy-upstream-pref" title={t(hintKey)}>
          {/* A DISTINCT class, not `dsm-workbuddy-pref-check`: the credit-switch
              suite (and the layout contract it pins) reads every
              `.dsm-workbuddy-pref-check` in the card as "the one per-region
              display switch", so sharing that class would make these appear to
              be four credit switches. They are not region-scoped display
              preferences; they change the request the whole plugin sends. */}
          <input
            type="checkbox"
            className="dsm-workbuddy-upstream-check"
            checked={on}
            disabled={!canWrite || saving || poolBusy || busy}
            onChange={(event: { target: { checked: boolean } }) => {
              void toggleUpstreamSwitch(field, event.target.checked)
            }}
          />
          <span className="dsm-workbuddy-pref-copy">
            <span className="dsm-workbuddy-pref-label">{t(labelKey)}</span>
            <span className="dsm-workbuddy-pref-hint">{t(hintKey)}</span>
            {/* `sessionTitle` is the only one with a second value; it is shown
                rather than edited because the id is already configurable in
                `sessionTitle.model` and a free-text field here would be a
                second, unvalidated way to break the one thing this switch
                depends on. */}
            {field === 'sessionTitle' && on
              ? <span className="dsm-workbuddy-pref-hint">{t('row.sessionTitleModel')} {sessionTitleValue().model}</span>
              : null}
            {/* `extraInjectedPrefixes` has no control here ON PURPOSE: it is a
                list of literal strings, and a checkbox-shaped UI for it would be
                a worse editor than the config file it already lives in. It is
                REPORTED while it matters (only `keepPromptLast` reads it), so a
                user who added prefixes by hand can see they are in effect rather
                than wondering whether the plugin noticed. */}
            {field === 'keepPromptLast' && on && extraInjectedPrefixes().length > 0
              ? <span className="dsm-workbuddy-pref-hint">{t('row.extraPrefixesCount')} {extraInjectedPrefixes().length}</span>
              : null}
          </span>
        </label>
      ))}
    </div>
  )

  /**
   * The opt-in auto-continue after a channel-gate refusal.
   *
   * Its own group, NOT a row in {@link upstreamSwitches} above, because it
   * breaks that group's one shared promise: those four are sampled when the
   * plugin mounts and need a reload, while this one is read on every failure and
   * takes effect immediately. Hiding that difference behind a shared hint would
   * teach the user the wrong rule for exactly the switch where being wrong is
   * expensive — this one spends real requests.
   *
   * The cap and the text are REPORTED while the switch is on, not edited: both
   * already live in the config file, and the cap is the one number the user asked
   * to be exactly 3, so an unvalidated free-text field here would be a second way
   * to get it wrong.
   */
  const channelRejectContinuePreference = (
    <div className="dsm-workbuddy-prefs">
      <label
        className="dsm-workbuddy-pref dsm-workbuddy-upstream-pref"
        title={t('row.channelRejectContinueHint')}
      >
        {/* This input carries ONLY its own class, deliberately NOT
            `dsm-workbuddy-upstream-check`: that class is the contract the
            upstream-switch suite reads to enumerate "the switches that need a
            reload", and this one is not in that set. */}
        <input
          type="checkbox"
          className="dsm-workbuddy-channel-continue-check"
          checked={channelRejectContinueValue().enabled}
          disabled={!canWrite || saving || poolBusy || channelRejectContinueBusy}
          onChange={(event: { target: { checked: boolean } }) => {
            void toggleUpstreamSwitch('channelRejectContinue', event.target.checked)
          }}
        />
        <span className="dsm-workbuddy-pref-copy">
          <span className="dsm-workbuddy-pref-label">{t('row.channelRejectContinueLabel')}</span>
          <span className="dsm-workbuddy-pref-hint">{t('row.channelRejectContinueHint')}</span>
          {channelRejectContinueValue().enabled
            ? (
              <span className="dsm-workbuddy-pref-hint">
                {t('row.channelRejectContinueLimit')} {String(channelRejectContinueValue().maxConsecutive)}
                {' · '}
                {t('row.channelRejectContinueText')} {channelRejectContinueValue().text}
              </span>
            )
            : null}
        </span>
      </label>
    </div>
  )

  const creditPreferences = (
    <div className="dsm-workbuddy-prefs">
      {cliBridgePreference}
      {/* The picker row is a property of the switch above it, like the seat
          row is a property of the credits switch: hidden while the route is
          off, where it would configure nothing. */}
      {cliBridgeSwitchedOn() ? cliBridgePickers : null}
      {imageToolPreference}
      {videoToolPreference}
      {/* Same rule as the CLI pickers above: the pin row is a property of the
          video switch, so it is hidden while that switch is off. */}
      {videoModelPreference}
      {mediaModelsPreference}
      <label
        className="dsm-workbuddy-pref"
        title={activeRegion === 'cn' ? t('row.showCreditsCnHint') : t('row.showCreditsGlobalHint')}
      >
        <input
          type="checkbox"
          className="dsm-workbuddy-pref-check"
          /* Same two rules as the first draft — the flag is forced OFF for a
             region that is off, and every writer of that region slot is
             serialized — kept HERE because this row owns the write. */
          checked={activeRegionOn ? creditsShownOn(activeRegion) : false}
          disabled={!activeRegionOn || togglingCredits === activeRegion || !canWrite || saving || poolBusy}
          onChange={(event: { target: { checked: boolean } }) => {
            void toggleCredits(activeRegion, event.target.checked)
          }}
        />
        <span className="dsm-workbuddy-pref-copy">
          <span className="dsm-workbuddy-pref-label">
            {activeRegion === 'cn' ? t('row.showCreditsCn') : t('row.showCreditsGlobal')}
          </span>
          <span className="dsm-workbuddy-pref-hint">{t('row.showCreditsHintInline')}</span>
        </span>
      </label>
      {/* Indented to the checkbox's LABEL (15px box + 10px row gap), not to the
          card edge: the picker is a property of the switch above it, and an
          unindented row would read as a third, unrelated setting. */}
      <label
        className="dsm-workbuddy-pref dsm-workbuddy-pref-indent"
        title={t('row.creditPositionHint')}
      >
        <span className="dsm-workbuddy-pref-copy">
          <span className="dsm-workbuddy-pref-lead">
            <span className="dsm-workbuddy-pref-label">{t('row.creditPositionLabel')}</span>
            {creditPositionPicker}
          </span>
          <span className="dsm-workbuddy-pref-hint">
            {activeRegionOn ? creditPositionCaption : creditPositionDisabledCaption}
          </span>
        </span>
      </label>
    </div>
  )

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
          ? <CardBodyBoundary t={t}>
              <div className="dsm-workbuddy-usage">
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
              {/* THE CARD'S THREE SECTIONS. Above them, the region pair is the
                  SCOPE (which provider's data this whole panel is about) and
                  scrolls with the content like any other header row. */}
              {signedIn
                ? <div className="dsm-workbuddy-panels" role="tablist" aria-label={t('row.panelAria')}>
                    <button
                      type="button"
                      role="tab"
                      id="dsm-workbuddy-tab-accounts"
                      aria-controls="dsm-workbuddy-panel-accounts"
                      aria-selected={panel === 'accounts'}
                      className={`dsm-workbuddy-panel-tab${panel === 'accounts' ? ' dsm-workbuddy-panel-tab-active' : ''}`}
                      onClick={() => { setPanel('accounts') }}
                    >
                      {t('row.panelAccounts')}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="dsm-workbuddy-tab-models"
                      aria-controls="dsm-workbuddy-panel-models"
                      aria-selected={panel === 'models'}
                      className={`dsm-workbuddy-panel-tab${panel === 'models' ? ' dsm-workbuddy-panel-tab-active' : ''}`}
                      onClick={() => { setPanel('models') }}
                    >
                      {t('row.panelModels')}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="dsm-workbuddy-tab-capabilities"
                      aria-controls="dsm-workbuddy-panel-capabilities"
                      aria-selected={panel === 'capabilities'}
                      className={`dsm-workbuddy-panel-tab${panel === 'capabilities' ? ' dsm-workbuddy-panel-tab-active' : ''}`}
                      onClick={() => { setPanel('capabilities') }}
                    >
                      {t('row.panelCapabilities')}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="dsm-workbuddy-tab-diag"
                      aria-controls="dsm-workbuddy-panel-diag"
                      aria-selected={panel === 'diag'}
                      className={`dsm-workbuddy-panel-tab${panel === 'diag' ? ' dsm-workbuddy-panel-tab-active' : ''}`}
                      onClick={() => { setPanel('diag') }}
                    >
                      {t('row.panelDiag')}
                    </button>
                  </div>
                : null}

              {/* ACCOUNTS — the default section: the account pool, the two
                  credit switches, and every notice about the credential, all at
                  the top instead of three screens down a single column. */}
              <div
                className="dsm-workbuddy-panel"
                role="tabpanel"
                id="dsm-workbuddy-panel-accounts"
                aria-labelledby="dsm-workbuddy-tab-accounts"
                /* `signedIn &&` — a signed-out card has no section tabs, so its
                   one screen of instructions must not be hidden by a panel
                   state the user cannot see or change. */
                hidden={signedIn && panel !== 'accounts'}
              >
              <p className="dsm-workbuddy-models-summary">{t('row.tabHint')}</p>
              {/* Its OWN paragraph rather than a clause appended to the hint
                  above: this one is BOLD and is the only sentence here that
                  corrects a wrong assumption rather than describing a fact.
                  Appending it in the same grey run is what let the ×0 tiers
                  read as "unlimited" in the first place (issue #56's reporter
                  lost 30 minutes to exactly that reading). */}
              <p className="dsm-workbuddy-models-summary dsm-workbuddy-free-quota-warn">
                {t('row.tabFreeQuotaWarn')}
              </p>
              {!activeRegionOn
                ? <p className="dsm-workbuddy-tab-off-notice">{t('row.tabOffNotice')}</p>
                : null}
              {/* The credit/CLI/image preferences are NOT here any more: they
                  moved to their own 「能力」 section, which is where a control
                  that authorizes spending (or registers a tool) belongs. This
                  panel is about WHICH account serves the tab; those switches are
                  about WHAT the plugin may do with it, and every one of them is
                  expected to grow sub-options that had no room in a flat list
                  competing with the account table. */}
              {/* The signed-in status card is GONE: the account name and the
                  token expiry were both information the rest of the card already
                  carries, and this line was actively the wrong place for it.
                  With a pool, several accounts are signed in at once, so naming
                  one was never the whole truth; the pool block names the account
                  actually serving and its table lists every account with its
                  state. The token auto-renews, so its expiry is nothing the user
                  can act on — and when the credential genuinely breaks, the
                  dedicated panels below say so with a remedy.

                  What remains here is only text the user must ACT on: the
                  re-login hint for a failed region, and the orphaned-choice
                  notice. A region's health at a glance is still on its tab dot. */}
              {status.status === 'error'
                || (status.status === 'signed-in' && status.creditsError !== undefined)
                // A refusal gets its own, specific advice in the panel below;
                // the generic "sign in again" would contradict it.
                ? status.status === 'signed-in' && status.credentialRejected === true
                  ? null
                  : <p className="dsm-workbuddy-usage-hint">{t('row.reloginHint')}</p>
                : null}
              {/* The ACCOUNT-level failures: a rescan whose hides could not be
                  lifted, and an account switch that was refused. This state was
                  already written by both paths but never rendered, so a refused
                  write and a stuck-vault re-scan both read as clicks that did
                  nothing. Rendered here, once, above the panels it explains —
                  both call sites are on this card, and neither owns a status
                  area of its own. */}
              {accountError === undefined
                ? null
                : <p className="dsm-workbuddy-account-error" role="alert">{accountError}</p>}
              {selectionLost
                ? <p className="dsm-workbuddy-usage-hint">{t('row.selectionLostHint')}</p>
                : null}
              {status.status === 'signed-in'
                ? <>
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
                      // Account DISCOVERY lives with the pool now: the pool's
                      // member table is where accounts are chosen, so re-reading
                      // the local sign-ins belongs beside it rather than in the
                      // card's status header — one place to manage accounts.
                      onRescan={() => { void rescanAccounts() }}
                      rescanning={busy}
                      // Manual account selection lives here too, and ONLY while
                      // the pool is OFF. With the pool off nothing else can pick
                      // the serving account — the ranking is out of the picture —
                      // so removing this from the card header without putting it
                      // here left the user with no way to choose at all. With the
                      // pool ON it is deliberately not rendered: the ranking
                      // decides the serving account, so a picker would be a
                      // control that changes nothing.
                      onSelectAccount={(accountId) => { void switchAccount(accountId) }}
                      selectingAccount={switchingAccount}
                      accountTools={accountTools}
                      siblingBusy={saving || togglingRegion !== undefined}
                      onBusyChange={setPoolBusy}
                      // Returns the promise so the pool section can AWAIT the
                      // display refresh that follows a verified write (A-8).
                      //
                      // The draft is NO LONGER held until this resolves (5.8.0,
                      // issue #131): it is discarded the moment the write
                      // verifies, because the re-read is a network round trip and
                      // "saving…" stayed on over settings that had already
                      // landed. So the boolean below drives the STALE NOTICE, not
                      // a draft decision — `refreshUsage` reports a failed fetch
                      // by RESOLVING (undefined) rather than throwing, so `true`
                      // here means "the snapshot was actually applied" and
                      // `false` means "stored, display not refreshed"; `false`
                      // renders `row.poolSavedStaleRefresh` and must not be
                      // reported as a save failure.
                      onSaved={async () => (await refreshUsage(activeRegion)) !== undefined}
                      // Hands the PROMISE back, not a fire-and-forget call: the
                      // pool keeps its row veil up until the fresh snapshot has landed
                      // (see the `onRefresh` prop note in AccountPool).
                      onRefresh={() => refreshUsage(activeRegion)}
                    />
                  </>
                : null}
              </div>

              {signedIn
                ? <div
                  className="dsm-workbuddy-panel"
                  role="tabpanel"
                  id="dsm-workbuddy-panel-models"
                  aria-labelledby="dsm-workbuddy-tab-models"
                  hidden={panel !== 'models'}
                >
                    <section className="dsm-workbuddy-models" aria-label={t('row.modelsTitle')}>
                      {/* The model list no longer folds. It used to be a native
                          <details>: a header that toggled on click, with a
                          chevron and a "click to collapse" hint. The list is what
                          users came for, so collapsing it only ever hid the thing
                          they wanted — and it made this section the only one on
                          the card with a click-to-hide header, which reads as a
                          different kind of section rather than the same one. */}
                      <div className="dsm-workbuddy-models-fold">
                        <div className="dsm-workbuddy-models-head">
                          <div>
                            <div className="dsm-workbuddy-models-title-row">
                              <h3 className="dsm-workbuddy-models-title">
                                {t('row.modelsTitle')}
                                {dirty
                                  ? <span className="dsm-workbuddy-models-dirty">{t('row.modelsDirty')}</span>
                                  : null}
                              </h3>
                            </div>
                            <p className="dsm-workbuddy-models-summary">{t('row.modelsSummary', { count: activeEnabledIds.size })}</p>
                          </div>
                          <div className="dsm-workbuddy-models-head-actions">
                            <button
                              type="button"
                              className="dsm-btn dsm-btn-outline"
                              disabled={busy}
                              onClick={() => { void refreshModels() }}
                            >
                              {busy ? t('row.modelsRefreshing') : t('row.modelsRefresh')}
                            </button>
                            {/* Two sweeps, by request of the maintainer after
                                comparing with the sibling `trae` plugin — which
                                ships the same pair. Both stay ONE model per
                                request (the route refuses more, and that cap is
                                what keeps a sweep from being an unaccounted
                                spend), so the loop lives here rather than in the
                                Host. The "all" button carries the cost hint: it
                                covers the models you did NOT enable as well, so
                                it spends more than the enabled-only run. */}
                            <button
                              type="button"
                              className="dsm-btn dsm-btn-outline dsm-workbuddy-models-sweep"
                              disabled={busy || sweeping !== undefined || activeEnabledIds.size === 0}
                              title={t('row.modelsTestEnabledHint')}
                              onClick={sweepEnabledModels}
                            >
                              {sweeping === undefined
                                ? t('row.modelsTestEnabled')
                                : t('row.modelsTesting', { done: sweeping.done, total: sweeping.total })}
                            </button>
                            <button
                              type="button"
                              className="dsm-btn dsm-btn-outline dsm-workbuddy-models-sweep"
                              disabled={busy || sweeping !== undefined || visibleModels.length === 0}
                              title={t('row.modelsTestAllHint')}
                              onClick={sweepAllModels}
                            >
                              {sweeping === undefined
                                ? t('row.modelsTestAll')
                                : t('row.modelsTesting', { done: sweeping.done, total: sweeping.total })}
                            </button>
                            {/* Speed sweep (issue #92). A separate button from the
                                two above because it answers a different question
                                and costs a different amount: the availability
                                probes send 25k input tokens each, while a speed
                                run sends ~35 and asks for 256 back, so this is
                                roughly 30x cheaper per model yet still three real
                                requests. Keeping it separate means the cost hint
                                on each button stays true. */}
                            <button
                              type="button"
                              className="dsm-btn dsm-btn-outline dsm-workbuddy-models-sweep"
                              disabled={busy || tpsSweeping !== undefined || tpsBusy
                                || activeEnabledIds.size === 0}
                              title={t('row.tpsSweepEnabledHint')}
                              onClick={sweepTpsEnabledModels}
                            >
                              {tpsSweeping === undefined
                                ? t('row.tpsSweepEnabled')
                                : t('row.tpsTesting', { done: tpsSweeping.done, total: tpsSweeping.total })}
                            </button>
                          </div>
                        </div>
                      {probeError === undefined ? null
                        : <p className="dsm-workbuddy-model-probe-result dsm-workbuddy-model-probe-result-bad" role="alert">
                            {t('row.probeError', { message: probeError })}
                          </p>}
                      {/* The sweep's tally, under the buttons. Absent until a
                          sweep runs, so the section does not grow a line that
                          says nothing. */}
                      {sweepSummary === undefined ? null
                        : <p className="dsm-workbuddy-models-sweep-summary" role="status">{sweepSummary}</p>}
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
                                    {effectiveRate(model) === undefined ? null
                                      // The SAME token the picker shows: the label slot
                                      // appends `x0.00` to the model name (see
                                      // `adapter.ts`), and a card saying `(0.00x)` would
                                      // make one number look like two. The 7px gap above
                                      // already separates it from the name, so no dot.
                                      : <span className="dsm-workbuddy-model-name-rate">x{effectiveRate(model)!.toFixed(2)}</span>}
                                  </span>
                                  {/* The upstream's own promotion badge, when one
                                      holds for this model right now. It sits NEXT
                                      to the name rather than inside it: the name
                                      truncates with an ellipsis, and a badge
                                      inside it would be cut off with the text. */}
                                  {promoChip(model)}
                                  {/* The upstream's LIVE load level, drawn as an
                                      icon. It sits NEXT to the name for the same
                                      reason the promo badge does: the name
                                      truncates, and a marker inside it would be
                                      cut off with the text. A level that is not
                                      worth drawing (or was not measured) draws
                                      nothing at all. */}
                                  {busyIcon(busyLevels[model.id], uiLanguage())}
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
                              <label
                                className={`dsm-workbuddy-model-off${offBlocked(model) ? ' dsm-workbuddy-model-off-blocked' : ''}`}
                                title={offBlocked(model) ? t('row.modelOffRefusedHint') : t('row.modelOffHint')}
                              >
                                <input
                                  type="checkbox"
                                  checked={activeOffIds.has(model.id)}
                                  disabled={!canWrite || saving || offBlocked(model)}
                                  onChange={() => { toggleOff(model.id) }}
                                />
                                <span>{t('row.modelOff')}</span>
                                {/* The tick can be a leftover from an older build,
                                    and this build will not send the level anyway —
                                    so say so instead of leaving a checkbox that
                                    looks saved but cannot take effect (issue #83). */}
                                {offBlocked(model) ? <span className="dsm-workbuddy-model-off-flag">{t('row.modelOffRefused')}</span> : null}
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
                                {/* Half-meg tier. Gated on `> 500_000` rather than
                                    `> 200_000` so it never offers a cap ABOVE a
                                    model's real window: a 192K model (hy3) and a
                                    300K one would otherwise get a button that
                                    silently lowers nothing and misrepresents the
                                    window. The upstream ladder is 300K/600K/960K
                                    or 1M, so 500K is a deliberate convenience
                                    point, not an upstream limit — hence a plain
                                    literal here, like the 200K label above.
                                    Unchecked with no stored budget, which is what
                                    `=== 500_000` gives for `undefined`; the `??
                                    200_000` default belongs to the 200K tier
                                    only. */}
                                {model.nativeContextWindow > 500_000
                                  ? <label>
                                      <input
                                        type="radio"
                                        name={`context-${model.id}`}
                                        checked={activeContextBudgets[model.id] === 500_000}
                                        disabled={!canWrite || saving}
                                        onChange={() => { setContextBudget(model.id, 500_000) }}
                                      />
                                      <span>500K</span>
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
                                    DEFAULT_PROBE_INPUT_TOKENS in src/probe.ts), because
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
                                {/* Speed, beside availability (issue #92). Its own
                                    button because the two answers are about
                                    different things: a model can be perfectly
                                    available and half the speed of its
                                    neighbour at the same credit multiplier. */}
                                <button
                                  type="button"
                                  className="dsm-btn dsm-btn-outline dsm-workbuddy-model-probe"
                                  disabled={tpsProbing[model.id] === true || status.status !== 'signed-in'}
                                  title={t('row.tpsHint')}
                                  onClick={() => { void measureTpsFor([model.id]) }}
                                >
                                  {tpsProbing[model.id] === true ? t('row.tpsMeasuring') : t('row.tpsMeasure')}
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
                                const reason = inlineProbeReason(result.outcome, result.message)
                                return (
                                  <p
                                    className={`dsm-workbuddy-model-probe-result dsm-workbuddy-model-probe-result-${view.tone}`}
                                    role="status"
                                    // The full upstream text, kept reachable even
                                    // when the line below shortens or drops it.
                                    {...result.message === undefined ? {} : { title: result.message }}
                                  >
                                    {view.text}
                                    {reason === undefined ? null : ' · ' + reason}
                                  </p>
                                )
                              })()}
                              {/* Speed sits on its OWN line, below the
                                  availability verdict: the two are independent
                                  facts and merging them into one <p> would make
                                  a fast-but-unavailable model read as one
                                  combined state that does not exist. */}
                              {(() => {
                                const measured = tpsResults[model.id]
                                if (measured === undefined) return null
                                const view = tpsResultView(measured, t, tpsMeasuredAt[model.id])
                                return (
                                  <p
                                    className={`dsm-workbuddy-model-probe-result dsm-workbuddy-model-probe-result-${view.tone}`}
                                    role="status"
                                  >
                                    {view.text}
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
                      </div>
                    </section>
              </div>
                : null}
              {/* CAPABILITIES — what the plugin is allowed to DO, as opposed to
                  which account it does it with. Three switches, no Save button:
                  each one commits on the click, which is exactly why they cannot
                  sit inside a section whose note promises 「点保存才生效」.

                  `signedIn &&` matches the accounts panel: a signed-out card has
                  no tab bar, so the section must stay reachable (and it is the
                  only place the CLI switch lives on an older Host that reports no
                  pool state). */}
              <div
                className="dsm-workbuddy-panel"
                role="tabpanel"
                id="dsm-workbuddy-panel-capabilities"
                aria-labelledby="dsm-workbuddy-tab-capabilities"
                hidden={signedIn && panel !== 'capabilities'}
              >
                <p className="dsm-workbuddy-panel-note">{t('row.panelCapabilitiesHint')}</p>
                {creditPreferences}
                {upstreamSwitches}
                {channelRejectContinuePreference}
              </div>
              {/* DIAGNOSTICS — the third section, and the one that earns its tab
                  by holding nothing the other two already say: the facts a bug
                  report needs (which region, which host, which account, which
                  credential expiry, how big the catalog actually is) plus the
                  upstream's own error text rather than a summary of it. No
                  control lives here, on purpose. */}
              <div
                className="dsm-workbuddy-panel"
                role="tabpanel"
                id="dsm-workbuddy-panel-diag"
                aria-labelledby="dsm-workbuddy-tab-diag"
                hidden={!signedIn || panel !== 'diag'}
              >
                {status.status !== 'signed-in'
                  ? null
                  : <>
                      <div className="dsm-workbuddy-diag">
                        <div className="dsm-workbuddy-diag-row">
                          <span className="dsm-workbuddy-diag-label">{t('row.diagRegion')}</span>
                          <span className="dsm-workbuddy-diag-value">
                            {status.region === 'cn' ? t('row.tabCn') : t('row.tabGlobal')}
                          </span>
                        </div>
                        <div className="dsm-workbuddy-diag-row">
                          <span className="dsm-workbuddy-diag-label">{t('row.diagDomain')}</span>
                          <span className="dsm-workbuddy-diag-value dsm-workbuddy-diag-mono">
                            {status.domain === undefined || status.domain === ''
                              ? t('row.modelUnknown')
                              : status.domain}
                          </span>
                        </div>
                        <div className="dsm-workbuddy-diag-row">
                          <span className="dsm-workbuddy-diag-label">{t('row.diagAccount')}</span>
                          <span className="dsm-workbuddy-diag-value">{nameOf(status.accountName)}</span>
                        </div>
                        <div className="dsm-workbuddy-diag-row">
                          <span className="dsm-workbuddy-diag-label">{t('row.diagToken')}</span>
                          <span className="dsm-workbuddy-diag-value dsm-workbuddy-diag-mono">
                            {formatDate(status.tokenExpiresAtMs)}
                          </span>
                        </div>
                        <div className="dsm-workbuddy-diag-row">
                          <span className="dsm-workbuddy-diag-label">{t('row.diagCatalog')}</span>
                          <span className="dsm-workbuddy-diag-value">{formatNumber(status.models.length)}</span>
                        </div>
                        <div className="dsm-workbuddy-diag-row">
                          <span className="dsm-workbuddy-diag-label">{t('row.diagEnabled')}</span>
                          <span className="dsm-workbuddy-diag-value">{formatNumber(status.enabledModelIds.length)}</span>
                        </div>
                        <div className="dsm-workbuddy-diag-row">
                          <span className="dsm-workbuddy-diag-label">{t('row.diagPool')}</span>
                          <span className="dsm-workbuddy-diag-value">
                            {status.pool?.enabled === true
                              ? t('row.diagPoolOn', { count: status.pool.accounts.length })
                              : t('row.diagPoolOff')}
                          </span>
                        </div>
                        <div className="dsm-workbuddy-diag-row">
                          <span className="dsm-workbuddy-diag-label">{t('row.diagFailures')}</span>
                          {(() => {
                            const failures: string[] = []
                            if (status.credentialRejected === true) failures.push(t('row.credentialRejectedTitle'))
                            if (status.refreshError !== undefined) failures.push(status.refreshError)
                            if (status.creditsError !== undefined) failures.push(status.creditsError)
                            // Issue #139: a promotion whose published hours could
                            // not be read draws NO badge and NO discount (see
                            // `promoWithinDailyWindow`), which is indistinguishable
                            // from "the promotion ended". Counting them here is what
                            // makes that visible instead of silent — and this is the
                            // symptom a future upstream format change will actually
                            // produce, not the render crash the report guessed at.
                            const unreadable = status.models.reduce(
                              (count, model) => count + (model.promos ?? []).filter(
                                promo => promo.schedule?.dailyUnusable === true,
                              ).length,
                              0,
                            )
                            if (unreadable > 0) failures.push(t('row.diagPromoUnreadable', { count: unreadable }))
                            // The upstream's OWN text, joined — not a rewritten
                            // sentence. This panel exists to be quoted.
                            return failures.length === 0
                              ? <span className="dsm-workbuddy-diag-value">{t('row.diagNoFailures')}</span>
                              : <span className="dsm-workbuddy-diag-value dsm-workbuddy-diag-bad dsm-workbuddy-diag-mono">
                                  {failures.join(' · ')}
                                </span>
                          })()}
                        </div>
                      </div>
                      <p className="dsm-workbuddy-diag-hint">{t('row.diagHint')}</p>
                    </>}
              </div>
              {status.status === 'signed-out' && loading
                // NOT the signed-out branch: nothing has answered yet. Showing
                // "not signed in" here was issue #77 — a signed-in user with a
                // pool full of accounts was told to sign in, for as long as the
                // usage route took, and the only control on screen detected
                // accounts they already had. The line below is what a first
                // paint in flight looks like; the `detail=fast` document
                // normally replaces it within one local round trip.
                ? <p className="dsm-workbuddy-usage-text" role="status">{t('row.accountsLoading')}</p>
                : null}
              {status.status === 'signed-out' && !loading
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
                    {/* Re-detect stays HERE as well, not only in the pool block:
                        the pool renders for a signed-in region only, and "I just
                        signed in over there, look again" is precisely a
                        signed-OUT action. Moving the control without this copy
                        would have removed the only way out of that state. */}
                    <div className="dsm-workbuddy-usage-account-actions">
                      <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        disabled={busy}
                        onClick={() => { void rescanAccounts() }}
                      >
                        {busy ? t('row.accountsScanning') : t('row.accountsRescan')}
                      </button>
                    </div>
                    {/* Account tools, signed-OUT flavour. The pool section
                        that normally hosts these does not render without an
                        account, and a signed-out machine is exactly where both
                        matter most: QR is the only way to add an account
                        without the desktop app, and a file exported from
                        another computer is how this one gains its accounts.
                        Same container and same order as the signed-in copy, so
                        the two states do not read as two different features. */}
                    <div className="dsm-workbuddy-pool-tools">{accountTools}</div>
                    {searched.length > 0 ? <SearchedPaths items={searched} t={t} /> : null}
                  </>
                : null}
              {status.status === 'error'
                ? <div className="dsm-workbuddy-usage-error-block">
                    <p className="dsm-workbuddy-usage-error" role="alert">
                      {t('row.usageErrorHint', {
                        message: status.message === '' ? t('row.requestFailed') : status.message,
                      })}
                    </p>
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      onClick={() => {
                        statusRetries.current = 0
                        void refreshUsage(activeRegion)
                      }}
                    >
                      {t('row.usageRetry')}
                    </button>
                  </div>
                : null}
            </div>
          </CardBodyBoundary>
          : null}
      </div>
    </li>
  )
}
