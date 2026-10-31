/**
 * The account pool's card section.
 *
 * 参考：`WorkBuddyCard.tsx` 的既有写法 —— 草稿态 + dirty 标记 + 「保存/放弃」、
 *   60 秒轮询、`writeField` 验证写入，全部沿用；样式类名继续用
 *   `dsm-workbuddy-*` 前缀，好让这一块与卡片其余部分共用同一套外观语言。
 * 改动：把「账号池」这一整块独立成模块。原因是它有三条别的区块没有的规则，
 *   放在卡片里会被淹没：
 *
 *   1. **一种状态、两套写入。** 偏好（启用、目标模型、成员）走草稿 + 保存
 *      （保存成功才丢弃草稿）；**测试结果**是运行时事实，由 Host 在批量测试后
 *      自动落盘，绝不经这个保存按钮。把它们混在一起，一次「保存」就会用旧草稿
 *      覆盖刚测出的结果。
 *   2. **免费模型可能不存在。** 国内版静态目录不带倍率，所以「自动挑免费模型」
 *      在国内版首次刷新前会挑到空。此时**不回退到收费模型**，而是如实说明并
 *      停用测试按钮。
 *   3. **签到只在有它的区域出现。** 海外区域没有签到，按钮与那一列都不渲染；
 *      Host 侧同样拒绝该动作，免得留下一个界面看不见、接口却还能打的死角。
 *
 * @module dsh-connect-workbuddy/client/AccountPool
 */

import { applyManualOrder } from './manual-order'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import {
  WORKBUDDY_BENEFIT_CLAIM_PATH,
  WORKBUDDY_GITHUB_URL,
  WORKBUDDY_PLAN_URL,
  WORKBUDDY_POOL_ACCOUNT_PARAM,
  WORKBUDDY_POOL_PATH,
  withWorkBuddyRegion,
  withWorkBuddyRegionAndAction,
} from '../status-paths.ts'
import type {
  WorkBuddyWebPool,
  WorkBuddyWebPoolModel,
  WorkBuddyWebPoolAccount,
  WorkBuddyWebPoolCheckinRow,
  WorkBuddyWebPoolTestRow,
  WorkBuddyWebProbeOutcome,
  WorkBuddyWebRegion,
} from '../status-paths.ts'
import { exclusionText } from './exclusion-text.ts'
import { availabilityLine, formatShortClock, outcomeOk, outcomeText, stateColor } from './account-state.ts'
import { formatCredits } from './credit-format.ts'
import { BusyOverlay } from './BusyOverlay.tsx'
import { DeviceModeBlockedDialog, DeviceProfileDialog } from './DeviceProfileDialog.tsx'
import type { WorkBuddyDeviceMode, WorkBuddyDeviceProfile } from './device-profile.ts'
import type { WorkBuddySettingsKey } from './locales.ts'
import type { Translate } from './searched-paths.ts'
import { readNdjson } from './ndjson.ts'
import { inlineProbeReason } from './probe-reason.ts'
import { probeAgeText, probeSourceText } from './probe-age.ts'
import { PROBE_INPUT_TOKEN_CHOICES } from '../probe.ts'
import {
  announcedBatchCount,
  draftBaseFor,
  effectiveMemberIds,
  ghostMembers as ghostMemberLabels,
  ghostNameList,
  poolFailureText,
  usableMemberIds,
  allMembersBlockedByModel,
} from './pool-state.ts'
import { isFileContentionWriteError, writePoolPreferences } from './account-selection.ts'
import type { WorkBuddyAccountScope } from './account-selection.ts'

/** One line in the pool's activity log. */
interface PoolLogEntry {
  atMs: number
  text: string
  tone: 'ok' | 'warn' | 'error' | 'info'
}

/** The preferences the card edits as a draft. */
export interface PoolPreferences {
  enabled: boolean
  targetModelId: string
  /**
   * Tokens each test probe sends; `0` means the host's measured default.
   *
   * Spelled `0` rather than optional so the controlled `<select>` has a real
   * value to bind: a dropdown whose current value is `undefined` falls back to
   * showing its first option, which would claim "10K" for a user who never
   * chose a size. The host accepts `0` as "default" for exactly this reason.
   */
  probeInputTokens: number
  /**
   * The account ids checked into this pool.
   *
   * An explicit opt-in with NO default: the batch actions claim rewards and
   * spend credits on real accounts, so membership is the user's decision rather
   * than a consequence of which sign-ins exist on this machine. An unchecked
   * account is listed but never touched.
   */
  memberAccountIds: readonly string[]
  /**
   * Manual priority order for member ids.
   *
   * Unlike membership, ORDER matters: the pool spends these in sequence, so a
   * swapped pair is a real edit. Empty means "no manual ordering — let the credit
   * policy decide", which is exactly what an older profile that never persisted
   * this field reads as.
   */
  orderAccountIds: readonly string[]
  /**
   * Per-account test model, keyed by account id (issue #61).
   *
   * A MAP rather than a scalar because `6004` is an account × model condition:
   * the model a test must use is the one the user actually chats with on THAT
   * account. An absent entry means "follow `targetModelId`", so a profile that
   * never uses this setting behaves exactly as before.
   */
}

export interface AccountPoolProps {
  t: Translate
  region: WorkBuddyWebRegion
  /** The Host's pool state; absent when the Host has no pool support. */
  pool?: WorkBuddyWebPool
  settingsScope?: WorkBuddyAccountScope
  /**
   * Whether the SAME card's other save (the model list) is in flight.
   *
   * Both saves write into one region slot, and the Host's `__save` merges
   * PER-REGION — so two saves running at once can interleave on a stale slot
   * and the later write can revert the earlier one while both report success.
   * While one is in flight the other's button is disabled, which makes the
   * race impossible rather than merely unlikely.
   */
  siblingBusy?: boolean
  /**
   * Reports whether THIS section's save is in flight, so the model list's save
   * can be held off for the same reason. Fired on change and on unmount with
   * `false`.
   */
  onBusyChange?: (busy: boolean) => void
  /**
   * Re-read this machine's local sign-ins.
   *
   * Lives here because the pool's member table is where accounts are managed:
   * a new sign-in shows up as a row to tick, so "look again" belongs beside the
   * rows rather than in the card's status header. The card keeps its own copy
   * for the signed-out state, where this whole section is not rendered.
   */
  onRescan?: () => void
  /** A rescan is in flight; the button reports it rather than looking inert. */
  rescanning?: boolean
  /**
   * Switch the account that serves this region.
   *
   * Rendered ONLY while the pool is off: that is the mode where the user's own
   * choice is what serves, so it is the only mode where changing it means
   * anything. With the pool on the ranking decides, and a picker would be a
   * control that changes nothing — which is exactly why it was removed from the
   * card header. It lives in this section so account handling stays in one place.
   */
  onSelectAccount?: (accountId: string) => void
  /** A selection write is in flight; the picker is held until it lands. */
  selectingAccount?: boolean
  /**
   * Called after a successful save. The `pool` prop comes from the usage
   * route, so without a re-read the card would render the PREVIOUS pool state
   * while the draft was already discarded — the save would look like it did
   * nothing until the next poll.
   *
   * THE DRAFT IS NOT HELD UNTIL THE RE-READ SUCCEEDS (5.8.0, issue #131). It
   * used to be: the sections kept the draft until this promise resolved `true`,
   * and `false` meant "stale, keep it". That was the bug — the re-read depends on
   * a network round trip that can be slow or fail, and the settings were already
   * written and verified by then, so a slow refresh held a permanent "saving…"
   * spin over work that had landed.
   *
   * The 5.8.0 contract is: the draft is discarded IMMEDIATELY after the VERIFIED
   * write, and this callback only drives the DISPLAY refresh. `false` therefore
   * means "stored, but the panel could not re-read it" and is surfaced as its own
   * status line (`row.poolSavedStaleRefresh`), never as a save failure — it must
   * not reuse `row.poolSaveFailed`, because "保存失败" was demonstrably untrue
   * there. The accepted trade is a short window in which the rows still show the
   * pre-save values; the alternative (locking the button on a failed refresh) is
   * worse and was the reported defect.
   */
  onSaved?: () => void | Promise<boolean>
  /**
   * Called after a batch action (check in / test) has changed the Host's state.
   *
   * A batch claims credits and writes probe results, but the panel's numbers
   * come from the usage route — so without a re-read the card kept showing the
   * credits from BEFORE the check-in until the next 60-second poll, and a
   * freshly measured probe outcome stayed invisible. The pool section does not
   * own that fetch, so it asks the card for it, exactly as a save does.
   *
   * RETURNS A PROMISE when the caller can report when the fresh snapshot has
   * landed. A row removal keeps its veil up until then: the row is still on
   * screen while the re-read is in flight, and dismissing the veil before the
   * fresh props arrive is precisely what made a delete look like it had not
   * happened. Callers that cannot await it keep the fire-and-forget void form.
   */
  onRefresh?: () => void | Promise<unknown>
  /**
   * Account-ADDING and account-MIGRATION controls, rendered inside the pool
   * settings block, ABOVE the preference rows.
   *
   * They live here rather than in the card header because both are account
   * management, and the pool's member table is where accounts are managed.
   * They sit above the "preferences, saved on save" note on purpose: QR
   * sign-in and import/export take effect IMMEDIATELY and have no draft, so
   * under that note they would imply a Save button that does nothing for them.
   *
   * Passed as ready-made nodes so this section does not own their state: each
   * component already keeps its own phase, and the card renders the same pair
   * in its signed-out branch, where this section does not exist at all.
   */
  accountTools?: ReactNode
  /**
   * 设备头档位与每账号覆盖值（`src/client/device-profile.ts`）。
   *
   * 四个一起可选：一个没有挂 `/device-profile` 路由的 Host 不会传它们，这时
   * 切换项与齿轮整块都不渲染——显示一个点不动的控件，比不显示更糟。
   */
  deviceMode?: WorkBuddyDeviceMode
  deviceProfiles?: Readonly<Record<string, WorkBuddyDeviceProfile>>
  onDeviceModeChange?: (mode: WorkBuddyDeviceMode) => void | Promise<unknown>
  /**
   * 保存一个账号的覆盖值。`''` 表示清空该项（回到派生值）。
   *
   * 抛错表示没写成功：面板会把消息留在弹窗里并让它保持打开，用户不必重填。
   */
  onSaveDeviceProfile?: (accountId: string, values: { machineId: string, sessionId: string }) => Promise<void>
}

/** How many activity lines are kept; the oldest are dropped. */
const LOG_LIMIT = 60

/**
 * Activity logs, kept per region OUTSIDE the component.
 *
 * The card unmounts its whole body when collapsed (`WorkBuddyCard.tsx:832`
 * renders it only while `open`), and again whenever a poll briefly leaves the
 * region unsigned-in. Component state therefore lost the entire log on every
 * collapse. Holding it here keeps the history across remounts and across tab
 * switches.
 */
const logStore = new Map<WorkBuddyWebRegion, readonly PoolLogEntry[]>()

/**
 * Whether two id sets are equal, ignoring order.
 *
 * The membership compare must not depend on click order: re-selecting the same
 * accounts in a different sequence is not an edit, and treating it as one would
 * light up "unsaved changes" for a no-op.
 */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const wanted = new Set(right)
  return left.every(id => wanted.has(id))
}

/**
 * Whether two id lists are equal IN ORDER.
 *
 * Unlike `sameIds`, position matters: manual priority is order-sensitive, so a
 * swapped pair is a real change and must light up "unsaved changes". A set
 * comparison here would treat reordering as a no-op and drop the user's sort.
 */
function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((id, index) => id === right[index])
}

function formatNumber(value: number): string {
  return formatCredits(value)
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

/**
 * The pool section.
 *
 * Renders nothing when the Host reports no pool state at all: an older Host
 * built without this feature should show an unmodified card, not an empty
 * section implying the feature exists.
 */
export function AccountPool(props: AccountPoolProps): ReturnType<typeof h> | null {
  const { t, region, pool, settingsScope, siblingBusy, onBusyChange, onSaved, onRefresh, onRescan, rescanning, onSelectAccount, selectingAccount, accountTools } = props
  const { deviceMode, deviceProfiles, onDeviceModeChange, onSaveDeviceProfile } = props
  const [draft, setDraft] = useState<PoolPreferences | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  // A stale re-read after a VERIFIED write — a different fact from a failed
  // save, and it must not borrow the 「保存失败：」 framing (issue #131).
  const [staleNotice, setStaleNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<'checkin' | 'test' | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  // Seeded from the shared store so a remount continues the same history.
  const [log, setLog] = useState<readonly PoolLogEntry[]>(() => logStore.get(region) ?? [])
  // The two pools keep separate histories; switching tabs swaps which one is
  // shown rather than mixing them (the card promised they are independent).
  useEffect(() => {
    setLog(logStore.get(region) ?? [])
  }, [region])
  // Which region the drafts belong to. Switching tabs must not carry one
  // region's unsaved edits onto the other, and the two pools are independent.
  const [draftRegion, setDraftRegion] = useState<WorkBuddyWebRegion | undefined>(undefined)
  // The ordering rule is reference material, not a setting: collapsed by
  // default so it cannot push the actual controls below the fold. Held in
  // component state rather than in the saved draft, because opening it is not
  // something the user would ever want to "save", and it must survive the
  // re-renders that a pool refresh causes.
  const [orderRulesOpen, setOrderRulesOpen] = useState(false)
  /**
   * 设备头编辑器：哪个账号、是否在保存、上一次失败的原因。
   *
   * `undefined` = 弹窗关着。分开存 `saving`/`error` 而不是塞进同一个对象，是因为
   * 保存失败时弹窗必须**保持打开**并保留用户填的值——关掉再重开一次，填写内容
   * 就全没了。
   */
  const [deviceEditing, setDeviceEditing] = useState<{ accountId: string, name: string } | undefined>(undefined)
  const [deviceSaving, setDeviceSaving] = useState(false)
  const [deviceError, setDeviceError] = useState<string | undefined>(undefined)
  const [deviceBlockedOpen, setDeviceBlockedOpen] = useState(false)
  const [deviceModeBusy, setDeviceModeBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const saved: PoolPreferences = {
    enabled: pool?.enabled ?? false,
    // Falls back to the STALE id, not to ''. When the saved model has left the
    // catalog the Host reports it as `staleTargetModelId` and omits
    // `targetModelId` (so an unguarded caller cannot test it). Reading that as
    // '' here would make the controlled select display "auto" while the disk
    // still holds the old id — and the next save would then write '' back,
    // silently destroying the user's choice. Carrying the stale id keeps the
    // display, the draft and the disk in agreement; the explicit "switch back
    // to automatic" button is what clears it, as a deliberate act.
    targetModelId: pool?.targetModelId || pool?.staleTargetModelId || '',
    // `0` (unset) is carried as-is rather than resolved to 25000 here: the
    // dropdown needs to show "默认" for someone who never chose, and writing the
    // resolved number back on the next save would silently convert "I never
    // touched this" into "I chose this".
    probeInputTokens: pool?.probeInputTokens ?? 0,
    memberAccountIds: pool?.memberAccountIds ?? [],
    // Defaults to empty (no manual ordering) when the host has never persisted
    // one: an empty order means "let the credit policy decide" — the same
    // semantics as an older profile that predates manual sorting.
    orderAccountIds: pool?.orderAccountIds ?? [],
    // Copied verbatim (issue #61), including entries whose model has left the
    // catalog: the host keeps them for the same reason, and dropping one here
    // would make the next Save delete the user's choice.
  }
  // The draft only applies to the tab it was made on.
  const active: PoolPreferences = draftRegion === region && draft !== null ? draft : saved
  /**
   * Whether the pool is RUNNING right now, which is the SAVED value.
   *
   * `active` is the user's draft and only becomes reality at Save. Using it for
   * the parts that DESCRIBE the running pool made the card state a mode that had
   * not taken effect yet: flipping the switch off (unsaved) revealed the manual
   * picker while the pool was still ranking every request, so the picker showed
   * the rotated account as "in use" and a selection made there was overridden by
   * the very pool the user was looking at — the "shows A, bills B" trap this
   * section keeps guarding against. The mirror case was milder but the same
   * class of wrong: turning the pool ON (unsaved) hid the picker while the manual
   * account was still the one being billed.
   *
   * Everything that reports pool state reads this; only the switch itself (its
   * controlled value) and `dirty` read the draft, because those two ARE about
   * the pending edit.
   */
  const poolRunning = saved.enabled
  const dirty = draftRegion === region && draft !== null && (
    draft.enabled !== saved.enabled
    || draft.targetModelId !== saved.targetModelId
    || draft.probeInputTokens !== saved.probeInputTokens
    // By content, key-sorted: a re-picked model is a change, and so is a
    // cleared one — the latter is an ABSENT key on both sides only if the user
    // never set it, which is why this compares entries rather than sizes.
    // Order-insensitive: the user's clicks decide the set, not its ordering,
    // so re-checking the same accounts in a different order is not a change.
    || !sameIds(draft.memberAccountIds, saved.memberAccountIds)
    // Order IS a change for the manual sort: swapping two priorities is editing
    // even though the set is untouched. `sameOrder` compares positionally; the
    // set-based `sameIds` must NOT be reused here (it would swallow a reorder).
    || !sameOrder(draft.orderAccountIds, saved.orderAccountIds)
  )

  /**
   * Membership that actually resolves to a local sign-in — what a batch runs on.
   *
   * The HOST computes this and sends it, so the card cannot drift from the
   * batch's real behaviour. Counting the raw saved list is what let the UI
   * claim "已选 1 / 共 1" and enable both buttons while the batch ran on ZERO
   * accounts and reported success.
   *
   * Derived locally as a FALLBACK for the case where the user has edited the
   * draft (the Host's answer describes the SAVED state) or an older Host omits
   * the field.
   */
  const listedIds = new Set((pool?.accounts ?? []).map(account => account.accountId))
  // Manual priority order for the DISPLAYED member rows. `active` is the draft
  // when the user is mid-edit, so this follows it (see `savedEffective` note
  // below). Explicit ids that are no longer members are dropped; members with no
  // explicit rank append in their original list order.
  const orderIds: string[] = (() => {
    const members = active.memberAccountIds.filter(id => listedIds.has(id))
    const explicit = active.orderAccountIds.filter(id => members.includes(id))
    const rest = members.filter(id => !explicit.includes(id))
    return [...explicit, ...rest]
  })()
  // The user has pinned at least one member explicitly — the sign that they are
  // sorting manually rather than letting the credit policy pick the order.
  const orderIsManual = active.orderAccountIds.some(id => active.memberAccountIds.includes(id))
  const savedEffective = pool?.effectiveMemberAccountIds ?? []
  const effectiveMembers = effectiveMemberIds({
    savedEffective,
    draftMembers: active.memberAccountIds,
    listedIds,
    dirty,
  })
  /**
   * Saved ids with no matching sign-in; surfaced rather than silently ignored.
   *
   * Named from the Host's last-measured map (issue #60): the id alone told the
   * user nothing, because nothing on screen shows ids. `pool.memberNames` can
   * only be absent for an older Host or an account never measured, and the
   * helper then falls back to an id prefix instead of a blank.
   */
  const ghostMembers = ghostMemberLabels(active.memberAccountIds, listedIds, pool?.memberNames ?? {})

  /**
   * Pool MEMBERS that can serve right now.
   *
   * Judged over members only. Using the whole account table made the "no usable
   * account" warning unreachable: unchecked rows are listed for the user to opt
   * into and never carry `excludedBy`, so any unchecked sign-in kept the count
   * above zero — exactly when every member was limited and the explanation was
   * most needed.
   */
  const usableMemberSet = new Set(usableMemberIds(pool?.accounts ?? [], effectiveMembers, active.memberAccountIds))
  const usable = (pool?.accounts ?? []).filter(account => usableMemberSet.has(account.accountId))
  // Membership edits also need the bound settings scope, because they are
  // saved through the same verified write path as the other preferences.
  const canEditPool = settingsScope !== undefined

  // Report this section's save state so the sibling save can hold off: two
  // in-flight saves into one region slot can interleave and revert each other
  // (see the `siblingBusy` prop note), so the card serializes them.
  useEffect(() => {
    onBusyChange?.(saving)
    return () => { onBusyChange?.(false) }
  }, [onBusyChange, saving])

  const appendLog = useCallback((text: string, tone: PoolLogEntry['tone']): void => {
    setLog(previous => {
      const next = [{ atMs: Date.now(), text, tone }, ...previous].slice(0, LOG_LIMIT)
      logStore.set(region, next)
      return next
    })
  }, [region])

  /**
   * The latest saved preferences, for callbacks that must not capture a stale
   * copy.
   *
   * `saved` is rebuilt on every render, so putting it in a `useCallback` dep
   * list would rebuild the callback every render (making the memo pointless),
   * while listing individual fields by hand is exactly what caused the
   * data-loss defect this ref fixes: a field added later
   * (`memberAccountIds`) was missing from the list, so the callback kept a
   * stale base and checking one account silently dropped another.
   *
   * A ref gives both properties at once — a STABLE callback identity and a
   * base read at call time. It is synced in a LAYOUT effect, which flushes
   * synchronously after commit and BEFORE the browser paints: a user event
   * cannot be processed before a frame is painted, so by the time any click
   * reaches `editDraft` the ref is current. (A plain `useEffect` would leave a
   * window between paint and its flush; a render-phase write would be unsafe
   * under concurrent rendering, where a discarded pass could leave the ref
   * holding values from a tree that never committed.)
   *
   * Seeded with the initial value so the very first interaction, before any
   * effect has run, still reads real preferences.
   */
  const savedRef = useRef(saved)
  useLayoutEffect(() => { savedRef.current = saved })

  /** Read by `editDraft` so it can refuse edits mid-save without rebuilding. */
  const savingRef = useRef(saving)
  useLayoutEffect(() => { savingRef.current = saving })

  const editDraft = useCallback((edit: (current: PoolPreferences) => PoolPreferences): void => {
    // Refuse edits while a save is in flight. A successful save DISCARDS the
    // draft, so an edit made during the round trip would be silently thrown away
    // when the write landed — the user would see their change vanish with no
    // error. Controls are disabled during the save too; this guards the paths
    // that do not go through a disabled control.
    if (savingRef.current) return
    setDraftRegion(region)
    setDraft(previous => {
      // Resolved inside the updater, so the fallback is the newest saved
      // preferences rather than the ones captured when this callback was made.
      return edit(draftBaseFor(previous, draftRegion, region, savedRef.current))
    })
  }, [draftRegion, region])

  const discard = useCallback((): void => {
    setDraft(null)
    setDraftRegion(undefined)
    setSaveError(undefined)
    setStaleNotice(undefined)
  }, [])

  /** Save the pool preferences through the plugin's VERIFIED write path. */
  const save = useCallback(async (): Promise<void> => {
    if (settingsScope === undefined || !dirty || draft === null) return
    setSaving(true)
    setSaveError(undefined)
    setStaleNotice(undefined)
    try {
      // Loading is deliberately bounded by the verified settings write, not by
      // the upstream usage refresh. `refreshUsage` may wait on a billing route
      // with a 30-second per-account timeout, and keeping the Save button in
      // 「保存中…」 for that long made a completed save look stuck (issue #131).
      await writePoolPreferences(settingsScope, region, draft)
      if (mounted.current) setSaving(false)
      // The verified write is the commit point: busy clears and the draft is
      // discarded IMMEDIATELY, before the refresh starts (issue #131). Keeping
      // the draft until the parent's re-read resolved is what left the button in
      // 「保存中…」 on a slow or failed usage read — data already on disk. The
      // accepted trade is a short window where the rows show pre-save values.
      discard()
      // The refresh is display-only: it is allowed to resolve undefined/throw
      // without turning a successful save into an error or restoring a draft
      // that the Host has already persisted. A stale re-read is reported on its
      // own channel, never as a save failure.
      const refreshed = await onSaved?.()
      if (refreshed === false && mounted.current) setStaleNotice(t('row.poolSavedStaleRefresh'))
    } catch (error: unknown) {
      // Only a failed settings write reaches here. The draft is the only copy
      // of the user's edits, so it must be kept for a retry.
      if (mounted.current) {
        const reason = error instanceof Error ? error.message : t('row.requestFailed')
        // A contention refusal needs the remedy appended: the raw message names
        // a temp file and no cause. See `isFileContentionWriteError`.
        setSaveError(isFileContentionWriteError(error) ? `${reason}${t('row.saveContentionHint')}` : reason)
        setSaving(false)
      }
    }
  }, [dirty, discard, draft, onSaved, region, settingsScope, t])

  /**
   * Drop one ghost member from the draft.
   *
   * A DRAFT edit, not a write: membership is one of the preferences the Save
   * button commits, and a control that wrote straight through would leave the
   * panel claiming "unsaved changes" for an edit it had already persisted. The
   * ghost rows therefore behave exactly like unchecking a listed account, which
   * is the behaviour the old copy ("save again to drop them") described but
   * gave the user no way to perform — the ids had no rows to uncheck.
   */
  const removeGhost = useCallback((accountId: string): void => {
    editDraft(current => ({
      ...current,
      memberAccountIds: current.memberAccountIds.filter(id => id !== accountId),
    }))
  }, [editDraft])

  /** Check or uncheck one account in this pool. */
  const toggleMember = useCallback((accountId: string, next: boolean): void => {
    editDraft(current => {
      const set = new Set(current.memberAccountIds)
      if (next) set.add(accountId)
      else set.delete(accountId)
      return { ...current, memberAccountIds: [...set] }
    })
  }, [editDraft])

  /**
   * Move one member one step up (`-1`) or down (`+1`) in the manual priority.
   *
   * The FIRST click is "the user starts sorting manually": it persists the WHOLE
   * currently-visible order into the draft, not just the one swapped pair. A
   * click that wrote only the moved id would leave the other rows unsorted (and
   * `orderIsManual` false), so the draft and the tables they power stay in sync.
   * `delta` is restricted to ±1 — a single swap per click — which is what makes
   * the first/last rows' extra buttons (rather than fields) correct.
   */
  const moveMember = useCallback((accountId: string, delta: -1 | 1): void => {
    editDraft(current => {
      // The visible order, derived exactly like the render-side `orderIds` (which
      // this deliberately mirrors): explicit ids first, un-pinned members appended
      // in original order. Deriving it from `current` here — not a render-scoped
      // `orderIds` — keeps the callback free of that per-render value's identity.
      const listed = new Set((pool?.accounts ?? []).map(account => account.accountId))
      const members = current.memberAccountIds.filter(id => listed.has(id))
      const explicit = current.orderAccountIds.filter(id => members.includes(id))
      const rest = members.filter(id => !explicit.includes(id))
      const visible = [...explicit, ...rest]
      const index = visible.indexOf(accountId)
      if (index < 0) return current
      const to = index + delta
      if (to < 0 || to >= visible.length) return current
      const next = [...visible]
      next.splice(index, 1)
      next.splice(to, 0, accountId)
      return { ...current, orderAccountIds: next }
    })
  }, [editDraft, pool])

    /** Check every listed account, or none of them. */
  const selectAll = useCallback((next: boolean): void => {
    editDraft(current => ({
      ...current,
      memberAccountIds: next ? (pool?.accounts ?? []).map(account => account.accountId) : [],
    }))
  }, [editDraft, pool])

  /** Run one batch action against the Host. */
  const runAction = useCallback(async (action: 'checkin' | 'test'): Promise<void> => {
    setBusy(action)
    setActionError(undefined)
    // Count what the batch will ACTUALLY run on — the same set the Host itself
    // resolves (`effective ?? saved`). Counting the raw saved list was the last
    // surviving exit of the H-5 defect: a ghost-only pool logged "checking in 1
    // account(s)" and was then refused with 409 having touched nothing. Counting
    // the DRAFT-derived set would be the opposite error, announcing unsaved
    // edits the Host will not run.
    //
    // Read through `pool` rather than the `saved` object literal above, even
    // though the two are equal. `saved` is rebuilt on every render, so a
    // callback that closed over it would need it in its dependency array and
    // would be recreated constantly; worse, `useCallback`'s deps here are
    // `[appendLog, pool, region, t]`, so reading ANY draft-dependent binding
    // (`active`, `dirty`, `effectiveMembers`, `ghostMembers`) from this body
    // would silently use a stale render's value. Reading `pool` — which IS a
    // dependency — keeps this callback's inputs complete and makes that trap
    // impossible rather than merely unlikely.
    const memberCount = announcedBatchCount({
      savedEffective: pool?.effectiveMemberAccountIds,
      savedMembers: pool?.memberAccountIds ?? [],
    })
    appendLog(
      action === 'checkin'
        ? t('row.poolLogCheckinStart', { count: memberCount })
        : t('row.poolLogTestStart', { count: memberCount, model: pool?.targetModelId ?? '' }),
      'info',
    )
    /**
     * One test row into the activity log.
     *
     * Shared by the STREAMED shape (a line per account) and the whole-batch
     * shape (an older Host's single document), so the two can never report the
     * same measurement differently — the failure mode this file's history is
     * mostly made of.
     */
    const logTestRow = (row: WorkBuddyWebPoolTestRow): void => {
      // Tolerate a malformed row instead of dereferencing it blind: one bad
      // entry used to throw a TypeError out of the whole loop, which the outer
      // catch turned into a batch error — so the remaining rows were never
      // reported and no completion line was written.
      const outcome = row?.result?.outcome
      if (outcome === undefined) {
        appendLog(t('row.poolLogTestRowMalformed', {
          accountName: row?.accountName === '' || row?.accountName === undefined
            ? t('row.accountUnnamed')
            : row.accountName,
        }), 'warn')
        return
      }
      appendLog(t('row.poolLogTestRow', {
        accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
        outcome: outcomeText(t, outcome),
      }), outcomeOk(outcome) ? 'ok' : 'warn')
    }
    try {
      const response = await fetch(withWorkBuddyRegionAndAction(WORKBUDDY_POOL_PATH, region, action), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      // The TEST route answers with NDJSON, one line per account, so each result
      // can be reported as it lands. Check-in still answers in one document, and
      // an older Host sends the whole batch as JSON — hence the content-type
      // check rather than assuming either shape.
      //
      // Both shapes converge on ONE success tail — the refresh call and the
      // completion logs sit after this if/else, not inside each arm. The refresh
      // is structurally pinned to a single site on the success path, because a
      // second one is how a failed batch ends up re-reading the usage too.
      let failed = false
      const streamed = (response.headers.get('content-type') ?? '').includes('ndjson')
      if (streamed) {
        if (!response.ok) {
          throw new Error(poolFailureText(t, { status: response.status }))
        }
        // Read the whole stream even after unmount: dropping the reader would
        // leave the Host writing into a socket nobody drains.
        let sawRow = false
        await readNdjson(response.body, line => {
          const row = line['row'] as WorkBuddyWebPoolTestRow | undefined
          if (row !== undefined) {
            sawRow = true
            // Rows arrive one at a time, so this is the per-account progress the
            // batch never used to give. Skip the DOM work once unmounted; the
            // reader above still has to drain.
            if (mounted.current) logTestRow(row)
            return
          }
          const reason = line['reason']
          if (typeof reason === 'string') {
            // The status is committed by the first line, so a mid-batch failure
            // arrives HERE rather than as a non-2xx response.
            failed = true
            const message = poolFailureText(t, {
              status: 200,
              reason,
              error: typeof line['error'] === 'string' ? line['error'] : undefined,
            })
            if (mounted.current) {
              setActionError(message)
              appendLog(t('row.poolLogBatchFailed', { message }), 'error')
            }
          }
        })
        if (!mounted.current) return
        // No completion line for a stream that errored, and none for one that
        // reported nothing at all: both would announce a batch that did not run.
        if (!failed && sawRow) appendLog(t('row.poolLogTestDone'), 'ok')
      } else {
        const body = await response.json().catch(() => undefined) as
          | { rows?: unknown, error?: string, modelId?: string, reason?: string }
          | undefined
        if (!response.ok) {
          // `poolFailureText` owns the three-tier rule (localized cause → the
          // Host's own words → a message keyed on the status). It lives in the
          // browser-free module so every tier, including the status one, is
          // pinned by a test — a rule kept here could not be.
          throw new Error(poolFailureText(t, {
            status: response.status,
            reason: body?.reason,
            error: body?.error,
            // See the row call sites: a non-JSON body means the route itself is
            // missing, not that the Host refused the method (issue #86).
            bodyUnreadable: body === undefined,
          }))
        }
        if (!mounted.current) return
        if (action === 'checkin') {
          for (const row of (body?.rows ?? []) as WorkBuddyWebPoolCheckinRow[]) {
            if (row.status === 'claimed') {
              appendLog(t('row.poolLogCheckinClaimed', {
                accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
                credit: String(row.credit ?? 0),
              }), 'ok')
            } else if (row.status === 'already') {
              appendLog(t('row.poolLogCheckinAlready', {
                accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
              }), 'info')
            } else if (row.status === 'skipped') {
              // An enterprise account has no consumer check-in (issue #124).
              // Neutral wording: nothing is wrong with the account.
              appendLog(t('row.poolLogCheckinSkipped', {
                accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
              }), 'info')
            } else {
              appendLog(t('row.poolLogCheckinFailed', {
                accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
                message: row.message ?? t('row.requestFailed'),
              }), 'error')
            }
          }
          appendLog(t('row.poolLogCheckinDone'), 'ok')
        } else {
          // An older Host (or a non-streaming answer): every row arrives at once.
          // Same reporter as the streamed path, so the log reads identically.
          for (const row of (body?.rows ?? []) as WorkBuddyWebPoolTestRow[]) logTestRow(row)
          appendLog(t('row.poolLogTestDone'), 'ok')
        }
      }
      // A failed stream is not a success: re-reading would mask the error the
      // log just reported, which is exactly what this placement forbids.
      if (failed) return
      // The batch has changed credits and probe state on the Host, but the
      // numbers on screen come from the usage route. Re-read it here, or the
      // panel keeps showing pre-check-in credits until the next 60s poll and a
      // fresh probe outcome stays invisible.
      onRefresh?.()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('row.requestFailed')
      if (mounted.current) {
        setActionError(message)
        // Also write it INTO the log. The error used to render only outside the
        // log, leaving readers of the activity list with a dangling "started N
        // accounts" and no indication that nothing ran.
        appendLog(t('row.poolLogBatchFailed', { message }), 'error')
      }
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }, [appendLog, onRefresh, pool, region, t])

  /** The account whose per-row action is in flight; gates every row's buttons. */
  const [rowBusyAccountId, setRowBusyAccountId] = useState<string | undefined>(undefined)
  /**
   * Which per-row action is running, for the veil's scenario line.
   *
   * A removal and a test both set `rowBusyAccountId`, but they mean different
   * things to the person watching ("this account is going away" versus "this
   * account is being measured") — and the veil exists precisely to say which.
   */
  const [rowBusyAction, setRowBusyAction] = useState<'test' | 'remove' | 'claim' | undefined>(undefined)

  /**
   * Test ONE account from its row.
   *
   * Same Host rule as the batch (testOne reuses the batch's probe), the same
   * log vocabulary, and the same refresh-after — a row result must read exactly
   * like the batch result it replaces.
   */
  const runRowTest = useCallback(async (accountId: string): Promise<void> => {
    setRowBusyAccountId(accountId)
    setRowBusyAction('test')
    setActionError(undefined)
    const url = withWorkBuddyRegionAndAction(WORKBUDDY_POOL_PATH, region, 'test')
      + '&' + WORKBUDDY_POOL_ACCOUNT_PARAM + '=' + encodeURIComponent(accountId)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined) as
        | { rows?: WorkBuddyWebPoolTestRow[], reason?: string, error?: string }
        | undefined
      if (!response.ok) {
        throw new Error(poolFailureText(t, {
          status: response.status,
          reason: body?.reason,
          error: body?.error,
          // No JSON at all means the request never reached a plugin handler: every
          // route here answers in JSON, its own 405 included (issue #86).
          bodyUnreadable: body === undefined,
        }))
      }
      if (!mounted.current) return
      const row = body?.rows?.[0]
      if (row === undefined) {
        setActionError(t('row.poolLogTestRowMalformed', { accountName: t('row.accountUnnamed') }))
        return
      }
      const outcome = row.result?.outcome
      if (outcome === undefined) {
        appendLog(t('row.poolLogTestRowMalformed', {
          accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
        }), 'warn')
      } else {
        appendLog(t('row.poolLogTestRow', {
          accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
          outcome: outcomeText(t, outcome),
        }), outcomeOk(outcome) ? 'ok' : 'warn')
      }
      onRefresh?.()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('row.requestFailed')
      if (mounted.current) {
        setActionError(message)
        appendLog(t('row.poolLogBatchFailed', { message }), 'error')
      }
    } finally {
      if (mounted.current) {
        setRowBusyAccountId(undefined)
        setRowBusyAction(undefined)
      }
    }
  }, [appendLog, onRefresh, region, t])

  /**
   * Claim ONE benefit on ONE account, from its row (issue #79).
   *
   * Always a single account and a single campaign: there is no batch entry
   * point, because a claim spends a real entitlement that cannot be undone. The
   * row is the unit of consent, so the row is the only way to ask for it.
   *
   * The Host re-reads the campaign before AND after the write, so the message
   * here reports what the gateway says now rather than what was requested. The
   * refresh afterwards is what actually removes the 待领取 line: the card has no
   * optimistic update, so a claim that silently did nothing cannot leave a stale
   * line claiming credits were taken.
   */
  const runRowClaim = useCallback(async (
    accountId: string,
    accountName: string,
    kind: 'compensation' | 'gift',
    title: string,
    creditNum: number,
  ): Promise<void> => {
    const name = accountName === '' ? t('row.accountUnnamed') : accountName
    setRowBusyAccountId(accountId)
    setRowBusyAction('claim')
    setActionError(undefined)
    // Not withWorkBuddyRegionAndAction: that helper appends `&action=<pool action>`,
    // and the claim route takes no action — it is addressed by accountId + kind.
    const url = withWorkBuddyRegion(WORKBUDDY_BENEFIT_CLAIM_PATH, region)
      + '&' + WORKBUDDY_POOL_ACCOUNT_PARAM + '=' + encodeURIComponent(accountId)
      + '&kind=' + encodeURIComponent(kind)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined) as
        | { reason?: string, error?: string }
        | undefined
      if (!response.ok) {
        throw new Error(poolFailureText(t, {
          status: response.status,
          reason: body?.reason,
          error: body?.error,
          // No JSON at all means the request never reached a plugin handler: every
          // route here answers in JSON, its own 405 included (issue #86).
          bodyUnreadable: body === undefined,
        }))
      }
      if (!mounted.current) return
      appendLog(t('row.poolLogBenefitClaimed', {
        accountName: name,
        title,
        count: formatNumber(creditNum),
      }), 'ok')
      // AWAIT the re-read, for the same reason removal below does: the row keeps
      // rendering the OLD snapshot until the new usage lands, and the claim pill
      // is only cleared by that snapshot. Returning before it arrived cleared the
      // busy flag while the card still showed a live 「领取」 pill, so a claim
      // that succeeded looked like it had not — inviting a second click the route
      // then refuses as already-claimed.
      await onRefresh?.()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('row.requestFailed')
      if (mounted.current) {
        setActionError(message)
        appendLog(t('row.poolLogBenefitFailed', { accountName: name, message }), 'error')
      }
    } finally {
      if (mounted.current) {
        setRowBusyAccountId(undefined)
        setRowBusyAction(undefined)
      }
    }
  }, [appendLog, onRefresh, region, t])

  /**
   * Remove ONE account from its row, via the Host.
   *
   * The Host dismisses the account (and deletes its vault entry when it has
   * one), so the row stays gone across rescans. The desktop app is not signed
   * out. The message below still distinguishes the two cases, because "there
   * was no plugin-stored copy" is worth saying: it tells the user the account
   * comes from the app itself rather than from an OAuth sign-in or an import.
   */
  const runRowRemove = useCallback(async (accountId: string, accountName: string): Promise<void> => {
    setRowBusyAccountId(accountId)
    setRowBusyAction('remove')
    setActionError(undefined)
    const url = withWorkBuddyRegionAndAction(WORKBUDDY_POOL_PATH, region, 'remove')
      + '&' + WORKBUDDY_POOL_ACCOUNT_PARAM + '=' + encodeURIComponent(accountId)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined) as
        | { removed?: boolean, error?: string, reason?: string }
        | undefined
      if (!response.ok) {
        throw new Error(poolFailureText(t, {
          status: response.status,
          reason: body?.reason,
          error: body?.error,
          // No JSON at all means the request never reached a plugin handler: every
          // route here answers in JSON, its own 405 included (issue #86).
          bodyUnreadable: body === undefined,
        }))
      }
      if (!mounted.current) return
      appendLog(
        body?.removed === true
          ? t('row.poolRowRemoved', { accountName: accountName === '' ? t('row.accountUnnamed') : accountName })
          : t('row.poolRowRemoveDesktopOnly', {
              accountName: accountName === '' ? t('row.accountUnnamed') : accountName,
            }),
        body?.removed === true ? 'ok' : 'info',
      )
      // AWAIT the re-read. The row is still rendered from the OLD snapshot
      // until it lands, and the veil is what covers that gap — dropping it
      // here (as the fire-and-forget call did) left the deleted row sitting
      // on screen with no sign that anything was still happening, which reads
      // as a delete that did not work.
      await onRefresh?.()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('row.requestFailed')
      if (mounted.current) {
        setActionError(message)
        appendLog(t('row.poolLogBatchFailed', { message }), 'error')
      }
    } finally {
      if (mounted.current) {
        setRowBusyAccountId(undefined)
        setRowBusyAction(undefined)
      }
    }
  }, [appendLog, onRefresh, region, t])

  if (pool === undefined) return null

  /**
   * Where the target model came from, and which model it is.
   *
   * Shown INSIDE the 「目标 test model」 setting row (as its description line)
   * rather than as a note under the buttons, which is where it used to be — one
   * of two places that stated the target model, the other being the header
   * subtitle. Both are gone from the header, so this is now the single place the
   * provenance is stated, right beside the control it describes.
   *
   * Returns null when there is nothing to say, so the caller can fall back to the
   * static explanation instead of rendering an empty "current:" prefix.
   */
  // "Which model, and did I choose it?" — but ONLY when the answer is not
  // already on screen. The picker sits directly beside this sentence and shows
  // the very same id, so `preferred` said the same thing twice in one row of
  // pixels; `stale` gets a whole warning block of its own below. What survives
  // is `free`, the one case the picker cannot express: the pool picked a model
  // the user never chose.
  const targetProvenance = pool.targetModelSource === 'free'
    ? t('row.poolTargetCurrentFree', { model: pool.targetModelId ?? '' })
    : null

  /**
   * The account the next request will start from.
   *
   * Read from the Host's `current` flag rather than re-derived here: the Host
   * owns the selection, and a browser-side guess is how the card would start
   * disagreeing with the account actually billed.
   */
  const currentAccount = pool.accounts.find(account => account.current)
  const currentName = currentAccount === undefined
    ? undefined
    : currentAccount.accountName === '' ? t('row.accountUnnamed') : currentAccount.accountName

  /**
   * The manual-mode picker: shown ONLY with the pool off, and it is the whole of
   * "manual mode" — with the pool off nothing else chooses who is billed.
   *
   * It lives in the HEAD line, sharing one slot with the 「current: X」 badge,
   * instead of in a row of its own further down. That row said the same account
   * name for the third time on one screen (badge, picker, member row), and the
   * repetition is what made the page read as generated rather than designed.
   * The two states are the two halves of one question — "who serves?" — so they
   * get one place to answer it: a picker when the answer is yours, a badge when
   * the pool decides.
   */
  const manualPicker = !poolRunning && onSelectAccount !== undefined && pool.accounts.length > 0
    ? h('label', { className: 'dsm-workbuddy-pool-head-pick' },
        h('span', { className: 'dsm-workbuddy-pool-head-pick-label' }, t('row.poolManualAccountLabel')),
        h('select', {
          className: 'dsm-workbuddy-pool-select dsm-workbuddy-pool-account-select',
          value: currentAccount?.accountId ?? '',
          disabled: selectingAccount === true,
          onChange: (event: { currentTarget: { value: string } }) => {
            onSelectAccount(event.currentTarget.value)
          },
        },
          // "No account in effect" is a real state (an orphaned saved id, a
          // failed refresh). Without a matching option the control would
          // silently display the first account — the same "looks fine, but is
          // not what runs" confusion this card keeps having to avoid.
          pool.accounts.some(account => account.current)
            ? null
            : h('option', { value: '', disabled: true }, t('row.poolManualAccountNone')),
          ...pool.accounts.map(account =>
            h('option', { key: account.accountId, value: account.accountId },
              account.accountName === '' ? t('row.accountUnnamed') : account.accountName)),
        ),
      )
    : null

  /**
   * The full ordering rule, collapsed — pure reference text.
   *
   * It used to sit between 「本池包含的账号」 and the first account row, which put
   * a paragraph of explanation ahead of the accounts it explains and pushed the
   * table down. Reference text belongs BELOW the data it describes; here it is,
   * at the top of 「更多设置」, next to the controls it explains.
   *
   * A <details>/<summary> pair rather than a stateful button: it is
   * keyboard-operable and screen-reader-expanded natively, and cannot fall out
   * of sync with what is on screen. `open` is controlled so a background refresh
   * cannot collapse a section the user just opened.
   */
  const orderRules = h('details', {
    className: 'dsm-workbuddy-pool-order-rules',
    open: orderRulesOpen,
    onToggle: (event: { currentTarget: { open: boolean } }) => setOrderRulesOpen(event.currentTarget.open),
  },
    h('summary', { className: 'dsm-workbuddy-pool-order-rules-summary' },
      t('row.poolOrderRulesTitle')),
    h('div', { className: 'dsm-workbuddy-pool-order-rules-body' },
      h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolOrderRulesIntro')),
      h('ol', { className: 'dsm-workbuddy-pool-order-rules-list' },
        ...ORDER_RULE_KEYS.map(key => h('li', { key }, t(key))),
      ),
      h('p', { className: 'dsm-workbuddy-pool-order-rules-why' }, t('row.poolOrderWhy')),
      h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolOrderBadgeNote')),
    ),
  )

  /**
   * 切换设备头档位。**即时生效**，不走草稿：这个开关决定每一行那个齿轮是否可用，
   * 如果它要等一次「保存」才生效，用户会先看到齿轮没反应、再去找保存按钮。
   */
  const changeDeviceMode = async (mode: WorkBuddyDeviceMode): Promise<void> => {
    if (onDeviceModeChange === undefined || deviceModeBusy || mode === deviceMode) return
    setDeviceModeBusy(true)
    setActionError(undefined)
    try {
      await onDeviceModeChange(mode)
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setDeviceModeBusy(false)
    }
  }

  /** 保存一个账号的覆盖值；失败时让弹窗留着、把原因放在里面。 */
  const saveDeviceProfileFor = async (
    accountId: string,
    values: { machineId: string, sessionId: string },
  ): Promise<void> => {
    if (onSaveDeviceProfile === undefined) return
    setDeviceSaving(true)
    setDeviceError(undefined)
    try {
      await onSaveDeviceProfile(accountId, values)
      if (mounted.current) setDeviceEditing(undefined)
    } catch (error: unknown) {
      // 失败不关弹窗：关掉就等于把用户刚填的两个 36 位十六进制扔掉。
      if (mounted.current) setDeviceError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setDeviceSaving(false)
    }
  }

  return h('section', { className: 'dsm-workbuddy-pool' },
    // The row veil: a removal writes the Host state, and the table only
    // changes once the re-read lands. That gap is what the user used to sit
    // through in silence, reading a still-listed account as "the delete did
    // nothing". A test keeps no veil — it changes no row membership, and its
    // result already has its own line in the log.
    rowBusyAction === 'remove'
      ? h(BusyOverlay, {
          visible: true,
          message: t('row.poolRowRemoving'),
          hint: t('row.veilHintList'),
        })
      : null,
    // Saving gets the same veil as every other write in this section.
    //
    // `saving` already spans the whole operation and not merely the write: it
    // is set before `writePoolPreferences` and cleared in the `finally`, after
    // `onSaved()` has awaited the re-read (see `save`). So the veil comes down
    // exactly when the panel shows the stored values — which is the same rule
    // the removal veil follows, and the reason this needs no extra state.
    saving
      ? h(BusyOverlay, {
          visible: true,
          message: t('row.poolSaving'),
          hint: t('row.veilHintList'),
        })
      : null,
    // The header is the title plus ONE answer to "who is serving?".
    //
    // The subtitle ("4 accounts in this region · target model X") and the
    // paragraph beside the badge are both GONE. Neither was wrong, but both
    // stated things the rest of the block already shows: the account count is
    // the member table's row count, and the target model is the value of the
    // 「target test model」 control right below — including where that value came
    // from. Two extra lines of prose above the first control is a lot of reading
    // before anything can be acted on.
    h('div', { className: 'dsm-workbuddy-pool-head' },
      h('h3', { className: 'dsm-workbuddy-pool-title' }, t('row.poolTitle')),
      // One slot, not two. With the pool off this is the picker — the name is
      // there because the control carries it, so a badge repeating it would be
      // the same fact twice in one row of pixels. With the pool on there is
      // nothing to pick, so the slot falls back to the badge: the pool's whole
      // job is deciding who gets billed, and a row tint alone answers "who is it
      // right now" only for someone already looking.
      manualPicker !== null
        ? manualPicker
        : currentName === undefined
          ? null
          : h('span', { className: 'dsm-workbuddy-pool-current-badge' },
              t('row.poolCurrentHeader', { account: currentName })),
    ),

    // The mode switch, FIRST.
    //
    // It used to live at the bottom of the panel, inside the settings card —
    // about 400px below the batch buttons it governs, and below the table whose
    // every column changes meaning with it (「未入池」 only matters when the pool
    // is what picks). This page has exactly two modes, "the plugin picks" and
    // "you pick"; the control that selects between them has to come before the
    // mode-specific controls, not after all of them.
    //
    // It deliberately keeps the `dsm-workbuddy-pool-settings` class: that is the
    // settings-GROUP style (bordered, stacked rows), and the component tests
    // locate the pool switch as the first checkbox inside it.
    h('div', { className: 'dsm-workbuddy-pool-settings dsm-workbuddy-pool-modebar' },
      h('div', { className: 'dsm-workbuddy-pool-modebar-row' },
        h('label', { className: 'sw' },
          h('input', {
            type: 'checkbox',
            checked: active.enabled,
            disabled: !canEditPool,
            onChange: (event: { currentTarget: { checked: boolean } }) => {
              const next = event.currentTarget.checked
              editDraft(current => ({ ...current, enabled: next }))
            },
          }),
          h('span', { className: 'sw-track' }),
        ),
        h('b', { className: 'dsm-workbuddy-pool-modebar-label' }, t('row.poolEnabled')),
        // The RUNNING mode, not the draft: the switch shows the pending edit and
        // the dirty chip beside it says the edit is pending, so this chip is free
        // to answer the different question — "what is the pool doing right now?".
        // Reading the draft here would label the page 「自动挑号」 while the saved
        // pool was still off and the manual picker below was still in charge,
        // which is the "shows A, bills B" trap this section keeps guarding
        // against (see `poolRunning`).
        h('span', { className: 'dsm-workbuddy-pool-modebar-state' },
          poolRunning ? t('row.poolModeAuto') : t('row.poolModeManual')),
        // Unsaved state sits beside the switch because the switch is the first
        // thing a user can dirty. It used to sit on the settings card's heading,
        // i.e. below everything it warned about.
        dirty ? h('span', { className: 'dsm-workbuddy-pool-dirty' }, t('row.poolDirty')) : null,
      ),
      // ONE line, and only one: the same paragraph used to appear twice — once
      // under the batch buttons and again under the switch at the bottom — which
      // read as a developer comment that had leaked into the page, and made the
      // page look longer than it is. The ranking rules it used to summarise have
      // their own disclosure in the member block, where the ordering is actually
      // edited; a second copy here would be the same duplication in a new place.
      h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolEnabledHint')),
    ),

    // "In use" and "in the pool" are orthogonal, and the row cannot say both
    // without looking self-contradictory: a green 「当前使用」 badge next to a grey
    // 「未入池」 on the same line, under a count of 「已选 0 / 1」, reads as a bug.
    // It is not — the account is serving right now and is not a rotation member —
    // but the explanation has to exist SOMEWHERE, so it goes here, in one line,
    // only in the state that needs it.
    poolRunning && currentAccount !== undefined && !effectiveMembers.includes(currentAccount.accountId)
      ? h('p', { className: 'dsm-workbuddy-pool-note dsm-workbuddy-pool-serving-note' },
          t('row.poolServingOutside', { account: currentName ?? '' }))
      : null,

    // The manual picker is NOT here any more: it moved into the header line,
    // where it shares one slot with the 「current: X」 badge (see `manualPicker`).
    // Two controls, one question — stating "who serves" in the title row and
    // again in a row of its own further down was the third repetition of the
    // same account name on one screen.

    // (The long "what the switch does" paragraph that used to stand here is
    // gone: the same text was rendered twice on one screen — here and under the
    // settings card's switch — and the switch it explained is now the first
    // control on the page, with a one-line hint beside it.)

    // Failover needs somewhere to go. With every member measured unusable (or
    // none checked at all) a failure is reported instead of retried, so say so
    // rather than leaving the user to infer it from a failed request.
    //
    // TWO verdicts, and the difference is the whole point of issue #64. When
    // every member is blocked by the SAME model, the generic "no usable account"
    // sentence names the wrong suspect: the accounts are healthy, and the user's
    // first instinct — switch accounts — is the one action that cannot help.
    // The model-wide branch is checked FIRST so it wins; the generic one stays
    // for the mixed and account-level cases it describes correctly.
    // ...
    // Gated on "there ARE members": with nothing checked, "no usable account"
    // names the wrong cause and sends the user hunting for a blocked account
    // when the actual fix is to tick a box. That case now gets the inline hint
    // beside the batch buttons instead.
    poolRunning && effectiveMembers.length > 0 && usable.length === 0
      ? allMembersBlockedByModel(pool?.accounts ?? [], effectiveMembers, active.memberAccountIds)
        ? h('p', { className: 'dsm-workbuddy-pool-warn', role: 'status' },
            `${t('row.poolModelWideBusy')} ${t('row.poolModelWideBusyHint')}`)
        : h('p', { className: 'dsm-workbuddy-pool-warn', role: 'status' },
            `${t('row.poolNoCandidate')} ${t('row.poolNoCandidateHint')}`)
      : null,

    // Membership is chosen here, explicitly. The header carries the select-all
    // control so "include everything" is one click, while the default stays
    // empty — checking nothing must never silently mean "all of them".
    h('div', { className: 'dsm-workbuddy-pool-members' },
      h('div', { className: 'dsm-workbuddy-pool-members-head' },
        h('div', null,
          h('h4', { className: 'dsm-workbuddy-pool-members-title' }, t('row.poolMembersTitle')),
          h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolMembersHint')),
        ),
        h('div', { className: 'dsm-workbuddy-pool-members-actions' },
          h('span', { className: 'dsm-workbuddy-pool-hint' }, t('row.poolSelectedCount', {
            count: effectiveMembers.length,
            total: pool.accounts.length,
          })),
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn-outline dsm-workbuddy-pool-small-btn',
            disabled: pool.accounts.length === 0 || !canEditPool,
            onClick: () => selectAll(true),
          }, t('row.poolSelectAll')),
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn-outline dsm-workbuddy-pool-small-btn',
            disabled: effectiveMembers.length === 0 || !canEditPool,
            onClick: () => selectAll(false),
          }, t('row.poolSelectNone')),
        ),
      ),
      // The batch bar sits HERE — under the member heading, above the rows —
      // because every button on it acts on the set that heading describes: the
      // 「已选 N / M」 count and 全选 / 全不选 are one line above, and the
      // checkboxes they count are in the table one line below. It used to stand
      // ABOVE the whole member block, where it read as a page-level toolbar and
      // had the buttons asking "act on WHICH accounts?" a full block before the
      // control that answers it.
      //
      // Two clusters, one row: on the left, things done TO the accounts you
      // checked; on the right, re-reading which accounts exist at all.
      //
      // The batch buttons are MANUAL actions, so they are deliberately NOT gated on
      // the pool switch: the switch decides whether the plugin picks the serving
      // account by itself, not whether the user may act on the accounts they
      // checked. Gating them on the switch made "switch the pool off" mean "you can
      // no longer check in or test anything", which is the opposite of what the
      // switch is for — and left a user with no manual path at all.
      h('div', { className: 'dsm-workbuddy-pool-actions' },
        h('div', { className: 'dsm-workbuddy-pool-actions-group' },
          pool.checkinSupported
            ? h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn-primary',
                // Disabled with an EMPTY pool: the buttons act on checked accounts
                // only, so a pool with nothing checked has nothing to run.
                disabled: busy !== undefined || effectiveMembers.length === 0,
                onClick: () => { void runAction('checkin') },
              }, busy === 'checkin' ? t('row.poolCheckingIn') : t('row.poolCheckinAll'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn-outline',
            disabled: busy !== undefined
              // Same criterion as the check-in button beside it. This one still
              // counted the SAVED list, so a ghost id (a member whose sign-in is
              // gone) left the button enabled while the batch ran on zero accounts
              // — and the log then announced a test that never happened. The two
              // buttons act on the same set and must gate on the same set.
              || effectiveMembers.length === 0
              // Refuse BOTH unresolvable-target states. Previously only 'none' was
              // checked, so a saved id that had dropped out of the catalog enabled
              // this button and the Host ran a batch against a model the region no
              // longer offers.
              || pool.targetModelSource === 'none'
              || pool.targetModelSource === 'stale',
            title: pool.targetModelSource === 'none'
              ? t('row.poolTargetNone')
              : pool.targetModelSource === 'stale' ? t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' }) : undefined,
            onClick: () => { void runAction('test') },
          }, busy === 'test' ? t('row.poolTesting') : t('row.poolTestAll')),
          // The Host answers a batch only when it is done, so there is no per-row
          // progress to report. The line therefore states the one thing that IS
          // true while it runs — accounts are being handled one at a time — instead
          // of naming an account that may not be the one in flight.
          busy !== undefined
            ? h('span', { className: 'dsm-workbuddy-pool-hint' }, t('row.poolBusyHint'))
            // Why both buttons are dead, right where the user is looking. This
            // sentence used to be an amber banner under the member table — a whole
            // screen away from the buttons it explained, and it made the only
            // coloured thing on the page a footnote instead of an error.
            : effectiveMembers.length === 0
              ? h('span', { className: 'dsm-workbuddy-pool-hint' }, t('row.poolNoneSelectedHint'))
              : null,
        ),
        // Re-reading the local sign-ins. Beside the member table rather than in the
        // card header: a sign-in that appeared externally shows up as a new row to
        // tick, so this is the control that makes it appear.
        onRescan === undefined
          ? null
          : h('div', { className: 'dsm-workbuddy-pool-actions-group' },
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn-outline',
                disabled: rescanning === true,
                onClick: onRescan,
              }, rescanning === true ? t('row.accountsScanning') : t('row.accountsRescan')),
            ),
      ),

      // The ordering rules are NOT here any more: this is reference text, and it
      // used to sit between the member heading and the first account row, so a
      // collapsed disclosure line was the last thing read before the accounts
      // themselves — annotation before data. It now lives at the top of 「更多
      // 设置」, below everything actionable (see `orderRules`).

      // 设备头档位：它同时决定"这台机器对外声称自己是谁"和每一行那个齿轮能不能
      // 用，所以必须贴着账号表——埋进「更多设置」会让齿轮看起来时好时坏。
      deviceMode === undefined || onDeviceModeChange === undefined
        ? null
        : h('div', { className: 'dsm-workbuddy-device-mode' },
            h('span', { className: 'dsm-workbuddy-device-mode-title' }, t('row.deviceModeTitle')),
            h('span', {
              className: 'dsm-workbuddy-device-mode-seg',
              role: 'group',
              'aria-label': t('row.deviceModeTitle'),
            },
              ...(['virtual', 'real'] as const).map(mode => h('button', {
                key: mode,
                type: 'button',
                className: `dsm-workbuddy-device-seg-btn${deviceMode === mode ? ' dsm-workbuddy-device-seg-on' : ''}`,
                'aria-pressed': deviceMode === mode,
                disabled: deviceModeBusy,
                onClick: () => { void changeDeviceMode(mode) },
              }, t(mode === 'virtual' ? 'row.deviceModeVirtual' : 'row.deviceModeReal'))),
            ),
            h('span', { className: 'dsm-workbuddy-hint' },
              deviceMode === 'real' ? t('row.deviceModeHintReal') : t('row.deviceModeHintVirtual')),
          ),

      h('div', { className: `dsm-workbuddy-pool-table${pool.checkinSupported ? ' dsm-workbuddy-pool-table-checkin' : ''}` },
        h('div', { className: 'dsm-workbuddy-pool-row dsm-workbuddy-pool-row-head' },
          h('span', null, t('row.poolColumnAccount')),
          h('span', null, t('row.poolColumnCredits')),
          h('span', null, t('row.poolColumnProbe')),
          pool.checkinSupported ? h('span', null, t('row.poolColumnCheckin')) : null,
          // The per-row actions column: no header text, the buttons speak.
          h('span', null),
        ),
        ...(() => {
          const ordered = sortAccountsByOrder(pool.accounts, orderIds)
          // `memberSeen` counts how many member rows we've emitted so far, 0-based
          // among members (not among all rows). The first/last member row needs to
          // know where it sits to disable the ↑ on the first and ↓ on the last.
          let memberSeen = 0
          let memberTotal = 0
          for (const account of ordered) {
            if (active.memberAccountIds.includes(account.accountId)) memberTotal += 1
          }
          return ordered.map(account => {
            const isMember = active.memberAccountIds.includes(account.accountId)
            const left = isMember ? memberSeen : -1
            const right = isMember ? memberTotal - 1 - memberSeen : -1
            if (isMember) memberSeen += 1
            return renderAccountRow({
              t,
              account,
              checked: isMember,
              canEdit: canEditPool,
              checkinSupported: pool.checkinSupported,
              onToggle: next => toggleMember(account.accountId, next),
              // Per-row actions, right side of the row. A `busy` row gates ITS OWN
              // buttons only: see the rowBusyAccountId note in renderAccountRow.
              busy: rowBusyAccountId === account.accountId,
              rowBusy: rowBusyAccountId !== undefined,
              rowBusyAction,
              /** The pill also needs to know WHICH row is busy, not just that one is. */
              claimBusy: rowBusyAccountId === account.accountId,
              testDisabled: pool.targetModelSource === 'none' || pool.targetModelSource === 'stale',
              targetHint: pool.targetModelSource === 'none'
                ? t('row.poolTargetNone')
                : pool.targetModelSource === 'stale' ? t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' }) : undefined,
              // Compared against the SAVED resolution (`pool.targetModelId`), not
              // the draft: a model the user is merely considering must not make
              // every row suddenly reprint its model id.
              poolModelId: pool.targetModelId ?? '',
              onTest: () => { void runRowTest(account.accountId) },
              onRemove: () => { void runRowRemove(account.accountId, account.accountName) },
              // 齿轮只在 Host 真的能保存时才出现；「真实值」档下置灰但仍可点，
              // 点了弹出"为什么"。两条路都通向一次说明，而不是一个死按钮。
              ...onSaveDeviceProfile === undefined ? {} : {
                onEditDevice: () => {
                  if (deviceMode === 'real') {
                    setDeviceBlockedOpen(true)
                    return
                  }
                  setDeviceError(undefined)
                  setDeviceEditing({ accountId: account.accountId, name: account.accountName })
                },
              },
              deviceGearBlocked: deviceMode === 'real',
              // Per-campaign claim, passed through as a factory: the button is
              // rendered only for benefits that are actually claimable, and the
              // row supplies the campaign so one route serves both kinds.
              onClaim: (kind, title, creditNum) => {
                void runRowClaim(account.accountId, account.accountName, kind, title, creditNum)
              },
              // Manual-sort props (see renderAccountRow): the 1-based rank among
              // members, whether ordering is manual, and whether this row's move
              // arrows are enabled. First member's ↑ and last member's ↓ are
              // disabled but still rendered so rows never shift position.
              orderIndex: isMember && orderIsManual ? left + 1 : undefined,
              orderIsManual,
              // The DRAFT's `enabled`, not the saved one (`pool.enabled`). The
              // arrows live in the membership block, which the user builds up in
              // the draft: tick an account, order it, then press Save once. Gating
              // on the SAVED switch made the arrows not exist until a save the
              // user had no reason to suspect was required — the order looked
              // impossible to set, and the next Save then had nothing to write.
              // Still the draft, never a claim about the running pool:
              // `poolRunning` (saved) remains the single source for what is live.
              moveEnabled: active.enabled && isMember && canEditPool,
              onMoveUp: () => { void moveMember(account.accountId, -1) },
              onMoveDown: () => { void moveMember(account.accountId, 1) },
              moveUpDisabled: left <= 0,
              moveDownDisabled: right <= 0,
            })
          })
        })(),
      ),
      // (The empty-pool amber banner that stood here is gone — the same fact is
      // stated inline beside the two disabled buttons, which is where the user
      // hits it. A second, louder copy 300px below only made the page look
      // broken in two places.)
      // State the discrepancy instead of silently ignoring the stale ids: the
      // user's saved list still contains them, and they need to know why the
      // pool behaves as if they were absent — and WHICH they are (issue #60).
      ghostMembers.length === 0
        ? null
        : h('div', { className: 'dsm-workbuddy-pool-ghosts' },
            h('p', { className: 'dsm-workbuddy-pool-warn', role: 'status' },
              t('row.poolGhostMembers', {
                count: ghostMembers.length,
                names: ghostNameList(ghostMembers),
              })),
            // One removable chip per ghost. This is the "corresponding mark" the
            // warning never had: the ids have no row in the table above (that
            // roster is local sign-ins, and a ghost is precisely the member that
            // is not in it), so without this the user could see that something
            // was wrong but had nowhere to act.
            h('ul', { className: 'dsm-workbuddy-pool-ghost-list' },
              ghostMembers.map(ghost => h('li', { key: ghost.id, className: 'dsm-workbuddy-pool-ghost' },
                h('span', { className: 'dsm-workbuddy-pool-ghost-name' }, ghost.label),
                h('button', {
                  type: 'button',
                  className: 'dsm-workbuddy-pool-ghost-remove',
                  title: t(ghost.named ? 'row.poolGhostRemoveNamed' : 'row.poolGhostRemoveUnnamed', {
                    account: ghost.label,
                  }),
                  'aria-label': t('row.poolGhostRemove', { account: ghost.label }),
                  disabled: saving,
                  onClick: () => { removeGhost(ghost.id) },
                }, '✕'))))),
      dirty && !sameIds(active.memberAccountIds, saved.memberAccountIds)
        ? h('p', { className: 'dsm-workbuddy-pool-dirty' }, t('row.poolUnsavedMembers'))
        : null,
    ),

    pool.targetModelSource === 'none'
      ? h('p', { className: 'dsm-workbuddy-pool-warn', role: 'status' },
          `${t('row.poolTargetNone')} ${t('row.poolTargetNoneHint')}`)
      : null,
    // The saved target is no longer offered. Reported rather than silently
    // swapped for the free model: testing something the user did not choose
    // would be its own defect.
    pool.targetModelSource === 'stale'
      ? h('div', { className: 'dsm-workbuddy-pool-conflict' },
          h('span', { className: 'dsm-workbuddy-pool-conflict-main' },
            h('b', null, t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' })),
            h('span', null, t('row.poolTargetStaleHint')),
          ),
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn-outline',
            disabled: !canEditPool,
            onClick: () => { editDraft(current => ({ ...current, targetModelId: '' })) },
          }, t('row.poolTargetStaleClear')),
        )
      : null,

    actionError === undefined ? null
      : h('p', { className: 'dsm-workbuddy-pool-error', role: 'alert' }, actionError),

    renderSettings({
      t, pool, active, dirty, saving, siblingBusy: siblingBusy === true,
      saveError, staleNotice, settingsScope,
      onEdit: editDraft, onSave: () => { void save() }, onDiscard: discard,
      appendLog, targetProvenance, orderRules,
      ...accountTools === undefined ? {} : { accountTools },
    }),

    h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolRegionNote')),

    renderLog({ t, log, busy: busy !== undefined, onClear: () => { logStore.set(region, []); setLog([]) } }),

    // 设备参数弹窗挂在 section 末尾：它是 fixed 定位的遮罩，DOM 位置不影响呈现，
    // 挂在这里能保证它盖在整段内容之上（而不是被下面的表格挤开）。
    deviceEditing === undefined
      ? null
      : h(DeviceProfileDialog, {
          t,
          accountName: deviceEditing.name,
          // 已保存的值：只有被覆盖过的那一项才非空，另一项留空即"继续派生"。
          saved: {
            machineId: deviceProfiles?.[deviceEditing.accountId]?.machineId ?? '',
            sessionId: deviceProfiles?.[deviceEditing.accountId]?.sessionId ?? '',
          },
          saving: deviceSaving,
          ...deviceError === undefined ? {} : { error: deviceError },
          onCancel: () => {
            setDeviceEditing(undefined)
            setDeviceError(undefined)
          },
          onSave: values => { void saveDeviceProfileFor(deviceEditing.accountId, values) },
        }),
    deviceBlockedOpen ? h(DeviceModeBlockedDialog, { t, onClose: () => setDeviceBlockedOpen(false) }) : null,
  )
}

/** An account's display name by id, or undefined when it is not listed. */
function nameOf(accountId: string, pool: WorkBuddyWebPool | undefined): string | undefined {
  const account = pool?.accounts.find(entry => entry.accountId === accountId)
  return account === undefined ? undefined : account.accountName
}

/** One account's row. */
function renderAccountRow(input: {
  t: Translate
  account: WorkBuddyWebPoolAccount
  checked: boolean
  canEdit: boolean
  /** Whether this region has a check-in at all; the column is omitted when not. */
  checkinSupported: boolean
  onToggle: (next: boolean) => void
  /**
   * A per-row action is in flight for THIS row: its own buttons gate on it.
   *
   * Deliberately NOT "any row is busy". Gating every row on a single global flag
   * made one claim repaint every other row's pill as 「领取中…」, which reads as
   * one click claiming the whole pool — the opposite of what this row-level
   * button means (issue #79). Only this row's pill may say it is claiming.
   */
  busy: boolean
  /** SOME row has an action in flight; the toolbar-level actions gate on it. */
  rowBusy: boolean
  /** The region cannot name a target model; the test button says why. */
  testDisabled: boolean
  targetHint: string | undefined
  /**
   * The model the pool would measure with RIGHT NOW.
   *
   * Every row shares one test model, so printing it on every row restated the
   * same id N times and pushed each row onto a third line. The row prints a
   * model only when its own measurement used a DIFFERENT one — which is the
   * only case where the reader has something to learn.
   */
  poolModelId: string
  /** Run a single-account test against THIS account's target model. */
  onTest: () => void
    /** Forget this account's plugin-stored credential. */
  onRemove: () => void
  /**
   * Claim one campaign on THIS account. Rendered per claimable benefit, so the
   * campaign kind and its wording travel with the click instead of being
   * re-derived from the row at claim time.
   */
  onClaim: (kind: 'compensation' | 'gift', title: string, creditNum: number) => void
  /** Which per-row action is in flight, so the claim button can name its state. */
  rowBusyAction: 'test' | 'remove' | 'claim' | undefined
  /** This row's own claim is the action in flight (never another row's). */
  claimBusy: boolean
  /** 1-based rank among members; undefined when not a member / not manually ordered. */
  orderIndex: number | undefined
  /** Whether the pool order is user-pinned (vs the credit policy picking it). */
  orderIsManual: boolean
  /** The ↑/↓ buttons render only when the pool is enabled AND this row is checked. */
  moveEnabled: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  /** First member's ↑ (and last member's ↓) stay visible but disabled, so rows never shift. */
  moveUpDisabled: boolean
  moveDownDisabled: boolean
  /**
   * 打开这个账号的设备参数弹窗；undefined = 这台 Host 没有设备设置路由，
   * 整颗齿轮不渲染（而不是渲染一个点了没反应的）。
   */
  onEditDevice?: () => void
  /**
   * 「真实值」档下齿轮置灰。
   *
   * 仍然是 `<button>` 而不是 `disabled`：置灰表达"现在用不了"，点击表达"为什么"。
   * 一个真正 disabled 的按钮点不动，用户只会以为界面坏了。
   */
  deviceGearBlocked: boolean
}): ReturnType<typeof h> {
  const {
    t, account, checked, canEdit, checkinSupported, onToggle, busy, rowBusy, testDisabled,
    targetHint, onTest, onRemove, onClaim, rowBusyAction, claimBusy, orderIndex, orderIsManual, moveEnabled,
    onMoveUp, onMoveDown, moveUpDisabled, moveDownDisabled, poolModelId,
    onEditDevice, deviceGearBlocked,
  } = input
  const name = account.accountName === '' ? t('row.accountUnnamed') : account.accountName
  const excluded = exclusionText(t, account.excludedBy)
  const probe = account.probe
  // The sentence comes from the SHARED rule (`account-state.ts`) so the
  // composer credits panel prints the identical words for the identical
  // measurement. An untested account has nothing to say, and the card supplies
  // its own "never tested" wording for that case.
  const outcomeLine = availabilityLine(t, account) ?? t('row.poolNeverTested')
  // The reason worth inlining, from the ONE rule both tables share (see
  // `probe-reason.ts`). It is absent for a limited account — whose body just
  // repeats the reset time printed beside it — and shortened otherwise, because
  // "the request was cancelled" versus "the network is down" is the question
  // this table exists to answer. The full text stays as a tooltip below.
  //
  const reason = probe === undefined ? undefined : inlineProbeReason(probe.outcome, probe.message)
  // HOW OLD and WHO WROTE IT, on their OWN line below the outcome.
  //
  // A second line rather than more " · " joins on the first: the outcome line
  // already carries up to three facts, and appending two more made a single
  // dense run that readers scanned past. These two answer a different question
  // ("is this current, and what wrote it?") from the outcome line ("what does
  // the pool think?"), so they get their own row.
  //
  // They are what make an unexpected value explainable: the same account is
  // written by the "test" batch AND by any failing live request, and they
  // overwrite each other. Without them the table showed a bare outcome with no
  // way to tell "a live request really failed just now" from "the record went
  // back to something older" — the exact confusion this line exists to remove.
  //
  // An unknown source (a record written before the field existed) says so
  // instead of guessing, because the row the user is asking about is the worst
  // possible place to print a confident wrong answer.
  const age = probe === undefined ? undefined : probeAgeText(t, probe.atMs, Date.now())
  // The writer, reduced to ONE pill: its text and the class that carries its
  // meaning. `undefined` means "nothing to say" (no measurement at all), which
  // the renderer distinguishes from the dashed "source unknown" pill a
  // pre-existing record gets.
  const probeLabel = probe === undefined
    ? undefined
    : probe.source === undefined
      ? { text: t('row.poolProbeSourceUnknown'), className: 'dsm-workbuddy-pool-prov-tag dsm-workbuddy-pool-prov-unknown' }
      : probe.source === 'live-request'
        ? { text: t('row.poolProbeSourceLive'), className: 'dsm-workbuddy-pool-prov-tag dsm-workbuddy-pool-prov-live' }
        : { text: t('row.poolProbeSourceTest'), className: 'dsm-workbuddy-pool-prov-tag' }
  // The relative wait ("约 1 小时后") used to be appended HERE, by this call site
  // only — which is why the composer panel showed the instant without it. It is
  // now part of `availabilityLine`, so both surfaces get it from one place and
  // cannot disagree about what "01:32 之后可再用" means.
  const probeLine = [outcomeLine, reason]
    .filter(part => part !== undefined && part !== '')
    .join(' · ')

  return h('div', {
    className: `dsm-workbuddy-pool-row${account.current ? ' dsm-workbuddy-pool-row-current' : ''}`,
    key: account.accountId,
  },
    h('span', { className: 'dsm-workbuddy-pool-account' },
      h('label', { className: 'dsm-workbuddy-pool-check' },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: !canEdit,
          'aria-label': t('row.poolSelectAria', { accountName: name }),
          onChange: (event: { currentTarget: { checked: boolean } }) => onToggle(event.currentTarget.checked),
        }),
      ),
      h('span', {
        className: 'dsm-workbuddy-usage-dot',
        style: { background: stateColor(account) },
      }),
      h('span', { className: 'dsm-workbuddy-pool-account-name' },
        h('b', null, name),
        // Manual-sort badge + ↑/↓ buttons. Shown only for a CHECKED row: an
        // unchecked account is not in the pool, so there is nothing to order.
        // SAFETY: a numeric rank is shown ONLY when `orderIsManual` is true —
        // never for a credit-policy-ordered pool, whose "order" reshuffles every
        // refresh and would make a `第 1 位` lie. The non-manual state gets the
        // dashed "自动排序" badge instead.
        checked
          ? h('span', { className: 'dsm-workbuddy-pool-order' },
              // A SPAN, not a disabled <button>. The badge only DESCRIBES the
              // order; rendering it as an inert button would tell assistive
              // technology and the user that a control exists there, and it
              // would also join the row's button list, so "the pool has exactly
              // two move arrows" could no longer be stated as a count.
              orderIsManual
                ? h('span', {
                    className: 'dsm-workbuddy-pool-rank',
                    title: t('row.poolRankManualTitle'),
                  }, t('row.poolRankLabel', { rank: orderIndex ?? 0 }))
                : h('span', {
                    className: 'dsm-workbuddy-pool-rank dsm-workbuddy-pool-rank-auto',
                    title: t('row.poolRankAutoTitle'),
                  }, t('row.poolRankAuto')),
              // Move arrows render only while the pool is ON and this row is
              // editable; first/last stay visible (disabled) so rows never shift.
              moveEnabled
                ? h('span', { className: 'dsm-workbuddy-pool-move' },
                    h('button', {
                      type: 'button',
                      className: 'dsm-workbuddy-pool-move-btn',
                      title: t('row.poolMoveUpTitle'),
                      'aria-label': t('row.poolMoveUpAria', { accountName: name }),
                      disabled: moveUpDisabled,
                      onClick: onMoveUp,
                    }, '↑'),
                    h('button', {
                      type: 'button',
                      className: 'dsm-workbuddy-pool-move-btn',
                      title: t('row.poolMoveDownTitle'),
                      'aria-label': t('row.poolMoveDownAria', { accountName: name }),
                      disabled: moveDownDisabled,
                      onClick: onMoveDown,
                    }, '↓'),
                  )
                : null,
            )
          : null,
        // Which account is serving, in WORDS. The row tint alone is a 7%-opacity
        // background: enough to spot when you already know to look, and no help
        // at all when the question is "which one is it?".
        account.current
          ? h('span', { className: 'dsm-workbuddy-pool-current-tag' }, t('row.poolCurrentBadge'))
          : null,
        // Stated in words ONLY for the accounts that are NOT in the pool.
        //
        // 「已在池中」 on a row whose checkbox is already ticked (and whose row is
        // already tinted) said "in the pool" a third time and cost every member
        // another line of name-block text. Absence is the half that needs words:
        // an empty box with empty credit and probe columns is otherwise
        // indistinguishable from a member whose data has not arrived yet.
        checked
          ? null
          : h('span', { className: 'dsm-workbuddy-pool-not-member' }, t('row.poolNotMember')),
        excluded === undefined
          ? probe === undefined ? null : h('span', null, t('row.poolTestedAt', { at: formatShortClock(probe.atMs) }))
          : h('span', { className: 'dsm-workbuddy-pool-excluded' }, excluded),
      ),
    ),
    h('span', { className: 'dsm-workbuddy-pool-credits' },
      account.credits === undefined
        ? h('span', null, '—')
        : h('b', null, formatNumber(account.credits)),
      account.expiringSoon !== undefined && account.expiringSoon > 0
        ? h('span', { className: 'dsm-workbuddy-pool-soon' },
            t('row.poolCreditSoon', { count: formatNumber(account.expiringSoon) }))
        : account.nearestExpiryMs === undefined
          ? null
          : h('span', { className: 'dsm-workbuddy-pool-soon-plain' },
              t('row.poolCreditNearest', { at: formatShortClock(account.nearestExpiryMs) })),
      // Claimable benefits (issue #79). Rendered ONLY when there is at least one:
      // a claimed campaign and a lapsed one both arrive here ABSENT, so the line
      // disappears by itself once nothing is left to take — that absence is the
      // requested behaviour, not an omission.
      //
      // Each entry carries its OWN claim button, because the button is the unit
      // of consent: one click spends one account's entitlement and nothing else.
      // A row-wide or pool-wide "claim all" is deliberately absent — the pool can
      // hold a dozen accounts, and a single click that silently spends all of
      // them is not a decision this card may make for the user.
      account.enterprise === true || account.benefits === undefined || account.benefits.length === 0
        ? null
        : h('span', { className: 'dsm-workbuddy-pool-benefits' },
            account.benefits.map((benefit, index) => h('span', {
              key: benefit.kind,
              className: benefit.urgent
                ? 'dsm-workbuddy-pool-benefit dsm-workbuddy-pool-benefit-urgent'
                : 'dsm-workbuddy-pool-benefit',
            },
              // Separator BETWEEN entries, so it can never dangle.
              index === 0 ? null : h('span', { className: 'dsm-workbuddy-pool-prov-sep' }, '·'),
              // An urgent window counts days; a comfortable one states just the
              // amount, because "{n} days left" on a long window is noise. A
              // window ending today says 今天截止 rather than "还剩 0 天".
              h('span', { className: 'dsm-workbuddy-pool-benefit-tag' }, benefit.urgent
                ? benefit.daysLeft === undefined || benefit.daysLeft === 0
                  ? t('row.poolBenefitDueToday', { title: benefit.title, count: formatNumber(benefit.creditNum) })
                  : t('row.poolBenefitUrgent', {
                      title: benefit.title,
                      count: formatNumber(benefit.creditNum),
                      days: formatNumber(benefit.daysLeft),
                    })
                : t('row.poolBenefitClaimable', { title: benefit.title, count: formatNumber(benefit.creditNum) })),
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn-outline dsm-workbuddy-pool-small-btn dsm-workbuddy-pool-benefit-btn',
                // Gated on a write in flight ANYWHERE in the card, because a second
                // write fired while the first is still landing would race the
                // refresh. But the LABEL is gated on this row alone: a shared label
                // state made one click repaint the whole table as 「领取中…」, which
                // reads as a pool-wide claim (issue #79).
                disabled: rowBusy,
                title: t('row.poolBenefitHint', { url: WORKBUDDY_PLAN_URL }),
                'aria-label': t('row.poolBenefitClaimAria', { title: benefit.title, count: formatNumber(benefit.creditNum) }),
                onClick: () => onClaim(benefit.kind, benefit.title, benefit.creditNum),
              }, h('span', null,
                claimBusy && rowBusyAction === 'claim'
                  ? t('row.poolBenefitClaiming')
                  : t('row.poolBenefitClaim'))),
            )),
          ),
    ),
    // The full upstream text stays on the element as a tooltip even when the
    // line above suppressed it as redundant. Suppressing it inline must not mean
    // "unreachable": a rate-limited row still has the upstream's exact wording
    // one hover away, requestId included.
    h('span', {
      className: 'dsm-workbuddy-pool-probe',
      ...probe?.message === undefined ? {} : { title: probe.message },
    },
      h('span', { className: 'dsm-workbuddy-pool-probe-main' }, probeLine),
      // The provenance row renders ONLY when there is something to say: an
      // untested account has no measurement to date, and an empty second line
      // would add height to every row while explaining nothing.
      probeLabel === undefined && age === undefined ? null : h('span', { className: 'dsm-workbuddy-pool-probe-prov' },
        // The writer is a PILL, not plain text, because it is the one readable
        // distinction on this line: "hit by a live request" explains a change the
        // user otherwise reads as a bug. Colouring it by that meaning is what
        // makes the row scannable — a neutral "tested" and a loud "hit by a live
        // request" must not look alike.
        probeLabel === undefined
          ? null
          : h('span', { className: probeLabel.className }, probeLabel.text),
        // The separator lives BETWEEN the two parts, so it can never dangle when
        // one side is absent.
        probeLabel === undefined || age === undefined
          ? null
          : h('span', { className: 'dsm-workbuddy-pool-prov-sep' }, '·'),
        age === undefined ? null : h('span', { className: 'dsm-workbuddy-pool-prov-age' }, age),
        // WHICH MODEL the verdict above is about (issue #61) — printed ONLY when
        // this row was measured against something other than the pool's current
        // test model. The pool has exactly one test model, so repeating it here
        // was pure duplication: the same id on every row, three times on screen
        // counting the picker and its provenance sentence, and it was the longest
        // run on the line, which is what wrapped rows onto a third line.
        //
        // The #61 concern still holds in the case it is actually about: a verdict
        // measured before the model changed must not look like it applies to the
        // current one. That case is exactly `modelId !== poolModelId`, and it is
        // still stated — including "unknown", which differs from any named model.
        probe !== undefined && probe.modelId !== poolModelId
          ? h('span', { className: 'dsm-workbuddy-pool-prov-model' },
              probe.modelId === undefined
                ? t('row.poolProbeModelUnknown')
                : t('row.poolProbeModel', { model: probe.modelId }))
          : null,
      ),
    ),
    checkinSupported
      ? h('span', { className: 'dsm-workbuddy-pool-checkin' },
          // Enterprise accounts have no consumer check-in at all (issue #129):
          // showing 「未签到」 would tell them to perform an action the upstream
          // already refuses with `10001`, which reads as their own mistake.
          account.enterprise === true
            ? h('span', { className: 'dsm-workbuddy-pool-unknown' }, t('row.poolCheckinEnterprise'))
            // Three states, not two: an unread account says nothing rather than
            // claiming "not checked in", which would contradict a check-in the user
            // just watched succeed.
            : account.checkedInToday === undefined
              ? h('span', { className: 'dsm-workbuddy-pool-unknown', title: t('row.poolNeverTested') },
                  t('row.poolCheckinUnknown'))
              : account.checkedInToday
                ? h('span', { className: 'dsm-workbuddy-pool-checked' }, t('row.poolCheckedIn'))
                : t('row.poolNotCheckedIn'),
        )
      // Absent entirely where the region has no check-in: an empty column would
      // still imply the state exists and is merely unknown.
      : null,
    // Per-row actions, RIGHT side of the row: test this one account, and forget
    // this account's plugin-stored credential. The test reuses the batch's
    // probe (one measurement, one vocabulary); the removal deletes ONLY the
    // vault entry — a desktop sign-in reappears on the next rescan, which the
    // log message states instead of a silent no-op.
    h('span', { className: 'dsm-workbuddy-pool-row-actions' },
      // 设备参数入口。放在「测试」左边：它改的是"这个账号以什么身份出现"，
      // 与"它现在能不能用"是同一层的问题，两个按钮挨着才读得通。
      onEditDevice === undefined
        ? null
        : h('button', {
            type: 'button',
            className: `dsm-btn dsm-btn-outline dsm-workbuddy-pool-small-btn dsm-workbuddy-device-gear${deviceGearBlocked ? ' dsm-workbuddy-device-gear-off' : ''}`,
            'aria-disabled': deviceGearBlocked ? true : undefined,
            title: deviceGearBlocked ? t('row.deviceGearBlockedHint') : t('row.deviceGearHint'),
            'aria-label': t('row.deviceGearAria', { accountName: name }),
            onClick: onEditDevice,
          }, '⚙'),
      h('button', {
        type: 'button',
        className: 'dsm-btn dsm-btn-outline dsm-workbuddy-pool-small-btn',
        disabled: rowBusy || testDisabled,
        title: testDisabled ? targetHint : undefined,
        onClick: onTest,
      }, t('row.poolRowTest')),
      h('button', {
        type: 'button',
        className: 'dsm-btn dsm-btn-outline dsm-workbuddy-pool-small-btn',
        disabled: rowBusy,
        title: t('row.poolRowRemoveHint'),
        'aria-label': t('row.poolRowRemoveAria', { accountName: name }),
        onClick: onRemove,
      }, t('row.poolRowRemove')),
    ),
  )
}

/** The preference editor plus its save/discard actions. */
function renderSettings(input: {
  t: Translate
  pool: WorkBuddyWebPool
  active: PoolPreferences
  dirty: boolean
  saving: boolean
  /**
   * The card's other save is in flight. Both sections write into one region
   * slot, and the Host merges per-region — concurrent saves could interleave
   * on a stale base and revert each other, so the two saves are serialized.
   */
  siblingBusy: boolean
  saveError: string | undefined
  /** A verified save whose re-read came back stale — reported, not an error. */
  staleNotice: string | undefined
  settingsScope: WorkBuddyAccountScope | undefined
  onEdit: (edit: (current: PoolPreferences) => PoolPreferences) => void
  onSave: () => void
  onDiscard: () => void
  appendLog: (text: string, tone: PoolLogEntry['tone']) => void
  /**
   * Where the target model came from, already localized — or null when the Host
   * had nothing to report. Passed in rather than recomputed here because the
   * source lives on the pool snapshot this renderer does not own.
   */
  targetProvenance: string | null
  accountTools?: ReactNode
  /**
   * The collapsed 「本池如何挑选账号」 reference block, already built by the panel
   * that owns the disclosure state. Passed in so this renderer stays a pure
   * function of its input — the open/closed state is component state, and a
   * second copy of it here would drift.
   */
  orderRules: ReactNode
}): ReturnType<typeof h> {
  const {
    t, pool, active, dirty, saving, siblingBusy,
    saveError, staleNotice, settingsScope,
    onEdit, onSave, onDiscard, targetProvenance, accountTools, orderRules,
  } = input
  const canEdit = settingsScope !== undefined

  return h('div', { className: 'dsm-workbuddy-pool-settings-wrap' },
    // Account tools FIRST — ABOVE the 「更多设置」 heading, not under it.
    //
    // They used to sit just inside that block, above its note, on the argument
    // that one bordered area should hold "everything about accounts". That read
    // is wrong in the one place it matters: everything under this heading is a
    // DRAFT that only takes effect when 「保存」 is pressed (the note under the
    // heading says so), while signing in and importing apply immediately. A
    // control that acts at once must not live inside a block that promises "点保存
    // 才生效" — a user who reads the note first waits for a button that was never
    // needed, and one who clicks first is surprised the table changed on its own.
    // Above the heading, the dashed border and the absence of a save button say
    // the truth: these are actions, the rows below are preferences.
    accountTools === undefined ? null : h('div', { className: 'dsm-workbuddy-pool-tools' }, accountTools),
    // A SUBHEADING, not a second page title. This block is "the rest of the
    // settings" — a target model and a probe size — not the panel's main event,
    // so it must not compete with 「账号池」 at the top. The unsaved-changes chip
    // that used to hang here now lives beside the switch, where the first
    // editable control is.
    h('div', { className: 'dsm-workbuddy-pool-card-head' },
      h('h4', { className: 'dsm-workbuddy-pool-card-title' }, t('row.poolSettingsTitle')),
    ),
    // Reference text, at the top of the settings block and OUT of the member
    // block: it explains the badges and arrows in the table above, so it belongs
    // under the data rather than in front of it.
    orderRules,
    h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolSettingsHint')),

    h('div', { className: 'dsm-workbuddy-pool-settings' },
      // The 「启用账号池」 switch is NOT here any more: it is the page's mode
      // selector and now stands directly under the title (see the mode bar). What
      // remains below are the two settings a manual TEST needs, which is why they
      // stay reachable with the pool off.
      h('div', { className: 'dsm-workbuddy-pool-set' },
        h('span', { className: 'dsm-workbuddy-pool-set-copy' },
          h('b', null, t('row.poolTargetLabel')),
          // The provenance leads, so the answer to "which model is it, and did I
          // choose it?" is read before the static explanation of how auto works.
          h('span', null,
            targetProvenance === null ? null : `${targetProvenance} `,
            t('row.poolTargetHint')),
        ),
        h('span', { className: 'dsm-workbuddy-pool-set-ctl' },
          h('select', {
            className: 'dsm-workbuddy-pool-select',
            value: active.targetModelId,
            // Not gated on the switch: the manual test needs this choice in both
            // modes, and with the pool off the test is the ONLY way to measure an
            // account — disabling its model picker would make that impossible.
            disabled: !canEdit,
            onChange: (event: { currentTarget: { value: string } }) => {
              const value = event.currentTarget.value
              onEdit(current => ({ ...current, targetModelId: value }))
            },
          },
            h('option', { value: '' }, t('row.poolTargetAutoOption')),
            // A saved id that is no longer in the catalog needs its OWN option.
            // Without it the controlled select has no matching option, so the
            // browser falls back to displaying the first one ("auto") while the
            // stored value stays the old id — the display and the value diverge,
            // and the next save writes the stale id back. Disabled so it can
            // never be re-picked, and shown so the user sees what is saved.
            active.targetModelId !== '' && !(pool.catalog ?? []).some(m => m.id === active.targetModelId)
              ? h('option', { value: active.targetModelId, disabled: true },
                  t('row.poolTargetStaleOption', { model: active.targetModelId }))
              : null,
            // The catalog's own models, so a manual choice comes from something
            // that exists. The multiplier rides in the label because knowing
            // whether a choice costs credits is the whole point of choosing.
            ...(pool.catalog ?? []).map(model => h('option', {
              value: model.id,
              key: model.id,
            }, model.creditMultiplier === undefined
              ? model.name
              : `${model.name} (x${model.creditMultiplier.toFixed(2)})`)),
          ),
        ),
      ),
      // The probe size, as its own row under the model picker.
      //
      // Directly beneath the model because the two together define what a test
      // actually sends, and the choice only makes sense against the measured
      // 20k~30k rate-limit threshold the hint describes — a user cannot judge
      // "30K" without being told what it is compared against.
      h('div', { className: 'dsm-workbuddy-pool-set' },
        h('span', { className: 'dsm-workbuddy-pool-set-copy' },
          h('b', null, t('row.poolProbeSizeLabel')),
          h('span', null, t('row.poolProbeSizeHint')),
        ),
        h('span', { className: 'dsm-workbuddy-pool-set-ctl' },
          h('select', {
            className: 'dsm-workbuddy-pool-select',
            // Bound as a STRING because a DOM select's value always is one; the
            // numeric value is parsed on change. `'0'` is the default option, so
            // a user who never chose keeps seeing "默认" rather than a number.
            value: String(active.probeInputTokens),
            // Not gated on the pool switch, for the same reason the model picker
            // is not: testing is the only way to measure an account with the
            // pool off, and this setting exists to serve that measurement.
            disabled: !canEdit,
            onChange: (event: { currentTarget: { value: string } }) => {
              const parsed = Number.parseInt(event.currentTarget.value, 10)
              // A non-numeric option value falls back to the default rather than
              // writing NaN, which would serialise as `null` and then read back
              // as "unset" — the same meaning, but only by accident.
              const next = Number.isFinite(parsed) ? parsed : 0
              onEdit(current => ({ ...current, probeInputTokens: next }))
            },
          },
            h('option', { value: '0' }, t('row.poolProbeSizeDefault')),
            // Driven by the shared list, so the menu and the host's coercion
            // rule can never disagree about which sizes exist.
            ...PROBE_INPUT_TOKEN_CHOICES.map(tokens => h('option', {
              value: String(tokens),
              key: String(tokens),
            }, t('row.poolProbeSizeOption', { tokens: String(tokens / 1000) }))),
          ),
        ),
      ),
    ),

    // Same shape as the model section's action row, deliberately: the two are
    // the card's two "commit your edits" rows, and a user who learns where the
    // buttons are in one should not have to look in the other. Encouragement
    // (the star link) leads on the left, the buttons sit on the right.
    //
    // Nothing between them, matching the model row. There WAS a status line
    // ("change any setting above to save it" / "you have unsaved changes"), and
    // it was redundant twice over: the Save button's own enabled state already
    // distinguishes the two cases, and a line that only appears while dirty made
    // the row reflow on every edit.
    h('div', { className: 'dsm-workbuddy-pool-save-bar' },
      h('a', {
        className: 'dsm-workbuddy-usage-cheer',
        href: WORKBUDDY_GITHUB_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
        t('row.cheer'),
        h('span', { className: 'dsm-workbuddy-usage-cheer-star', 'aria-hidden': 'true' }, '★'),
      ),
      h('div', { className: 'dsm-workbuddy-pool-save-buttons' },
        h('button', {
          type: 'button',
          className: 'dsm-btn dsm-btn-outline',
          disabled: !dirty || saving || siblingBusy,
          onClick: onDiscard,
        }, t('row.poolDiscard')),
        h('button', {
          type: 'button',
          className: 'dsm-btn dsm-btn-primary',
          disabled: !dirty || saving || siblingBusy || !canEdit,
          onClick: onSave,
        }, saving ? t('row.poolSaving') : t('row.poolSaved')),
      ),
    ),

    saveError === undefined
      ? null
      : h('p', { className: 'dsm-workbuddy-pool-error', role: 'alert' },
          t('row.poolSaveFailed', { message: saveError })),

    // The stale re-read must not be framed as a failed save: the setting IS
    // written and verified, so prefixing it with 「保存失败」 told the user the
    // opposite of what had happened (issue #131). Neutral `role="status"`.
    staleNotice === undefined
      ? null
      : h('p', { className: 'dsm-workbuddy-pool-warn', role: 'status' }, staleNotice),
  )
}

/** The activity log. */
function renderLog(input: {
  t: Translate
  log: readonly PoolLogEntry[]
  /** A batch is running, so the log is still being appended to. */
  busy: boolean
  onClear: () => void
}): ReturnType<typeof h> {
  const { t, log, busy, onClear } = input
  return h('div', { className: 'dsm-workbuddy-pool-log' },
    h('div', { className: 'dsm-workbuddy-pool-log-head' },
      h('span', null, t('row.poolLogTitle')),
      log.length === 0
        ? null
        : h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn-outline dsm-workbuddy-pool-log-clear',
            // Disabled while a batch runs: it would keep appending as the batch
            // progressed, so the clear would look like it had not worked.
            disabled: busy === true,
            onClick: onClear,
          }, t('row.poolLogClear')),
    ),
    log.length === 0
      ? h('div', { className: 'dsm-workbuddy-pool-log-empty' }, t('row.poolLogEmpty'))
      : h('div', { className: 'dsm-workbuddy-pool-log-body' },
          ...log.map((entry, index) => h('div', {
            className: 'dsm-workbuddy-pool-log-row',
            // `atMs` alone can repeat within a batch, so the index is needed
            // for uniqueness; the list is prepend-only, which is what makes
            // that stable enough (no reorder, no duplicate keys).
            key: `${entry.atMs}-${index}`,
          },
            h('span', { className: 'dsm-workbuddy-pool-log-time' }, formatClock(entry.atMs)),
            h('span', { className: `dsm-workbuddy-pool-log-text dsm-workbuddy-pool-log-${entry.tone}` }, entry.text),
          )),
        ),
  )
}

/**
 * Sort accounts by the manual priority order, without losing stability.
 *
 * Helpers/rows are rendered in this order so a click on ↑/↓ reorders the row
 * immediately (client-side), before any save + host round-trip. Ids in `orderIds`
 * that are not actually members are skipped; members not listed fall back to the
 * END in their original relative order.
 *
 * The sort is STABLE: two ids with the same priority rank keep their original
 * array order. A `rank` lookup returns `orderIds.length` as the sentinel for
 * "not ordered", which is larger than any real rank, so unlisted members sort
 * after every listed one. An EMPTY `orderIds` short-circuits: the input order is
 * already the answer, and we avoid building the rank map / comparator for the
 * common (never-sorted) case.
 *
 * TWO subtleties that a naive rank comparator gets wrong, both of which would
 * make the table visibly wrong:
 *
 * - DUPLICATE ids keep the FIRST occurrence's rank (`if (!rank.has(id))`).
 *   Overwriting instead would let a stray duplicate silently push the account
 *   it names to the duplicate's later position, so the row would drift away
 *   from the badge that claims to describe it.
 * - The sort key is the PAIR (rank, original index), not rank alone. Ranks are
 *   unique per id, but the `Infinity` fallback is shared by every unlisted
 *   account, and `Array.prototype.sort` is NOT guaranteed stable across engines
 *   for arbitrary inputs; relying on it would let the unlisted tail reshuffle
 *   between renders. Breaking the tie on the original index makes the result a
 *   pure function of the input, which is what stops the table from jittering
 *   when the same snapshot arrives twice.
 */
/**
 * The ordering rules, in EXACTLY the comparator's priority order.
 *
 * Kept as one table rather than inline literals so the order is a single thing
 * a reader can compare against `src/account-pool.ts` — the rule text and the
 * code must never drift, and a flat list makes that diff trivial. Typed as
 * `WorkBuddySettingsKey` so a renamed or removed locale key is a compile error
 * instead of a raw key rendered to the user.
 */
const ORDER_RULE_KEYS = [
  'row.poolOrderRuleUsable',
  'row.poolOrderRuleExpiring',
  'row.poolOrderRuleManual',
  'row.poolOrderRuleNearestExpiry',
  'row.poolOrderRuleExpiringAmount',
  'row.poolOrderRuleTotal',
  'row.poolOrderRuleFreshness',
  'row.poolOrderRuleId',
] as const satisfies readonly WorkBuddySettingsKey[]

export function sortAccountsByOrder(
  accounts: readonly WorkBuddyWebPoolAccount[],
  orderIds: readonly string[],
): WorkBuddyWebPoolAccount[] {
  // Delegates to the shared implementation. The composer credits panel lists
  // the same accounts, and when each surface owned its own sort the two
  // disagreed — the pool showed the manual order while the panel showed
  // whatever the Host returned. One implementation makes that unrepresentable.
  return applyManualOrder(accounts.map(account => ({ id: account.accountId, account })), orderIds)
    .map(entry => entry.account)
}
