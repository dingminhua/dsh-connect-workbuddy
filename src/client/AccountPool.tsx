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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import {
  WORKBUDDY_POOL_PATH,
  withWorkBuddyRegionAndAction,
} from '../status-paths.ts'
import type {
  WorkBuddyWebPool,
  WorkBuddyWebPoolAccount,
  WorkBuddyWebPoolCheckinRow,
  WorkBuddyWebPoolTestRow,
  WorkBuddyWebProbeOutcome,
  WorkBuddyWebRegion,
} from '../status-paths.ts'
import type { Translate } from './searched-paths.ts'
import {
  announcedBatchCount,
  draftBaseFor,
  effectiveMemberIds,
  ghostMemberIds,
  poolFailureText,
  usableMemberIds,
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
   * The account ids checked into this pool.
   *
   * An explicit opt-in with NO default: the batch actions claim rewards and
   * spend credits on real accounts, so membership is the user's decision rather
   * than a consequence of which sign-ins exist on this machine. An unchecked
   * account is listed but never touched.
   */
  memberAccountIds: readonly string[]
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
   * Called after a successful save. The `pool` prop comes from the usage
   * route, so without a re-read the card would render the PREVIOUS pool state
   * while the draft was already discarded — the save would look like it did
   * nothing until the next poll.
   *
   * RESOLVE `false` WHEN THE RE-READ DID NOT DELIVER FRESH PROPS. The parent
   * cannot report that by throwing: the card's `refreshUsage` answers a failed
   * fetch by resolving, so "it did not throw" does NOT mean "the fresh props
   * arrived". Resolving `false` stops this section from discarding the draft
   * against a still-stale `saved` prop, which is the exact window this ordering
   * exists to close. `void` (no returned promise) is treated as success, so a
   * plain fire-and-forget callback stays valid.
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
   */
  onRefresh?: () => void
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

/** Whether a probe outcome means the model answered. */
function outcomeOk(outcome: WorkBuddyWebProbeOutcome): boolean {
  return outcome === 'ok'
}

/** A short, localizable label for one probe outcome. */
function outcomeText(t: Translate, outcome: WorkBuddyWebProbeOutcome): string {
  switch (outcome) {
    case 'ok': return t('row.probeOk')
    case 'rate-limited': return t('row.poolExcludedRateLimited')
    case 'out-of-credit': return t('row.poolExcludedOutOfCredit')
    case 'credential-rejected': return t('row.probeCredentialRejected')
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    default: return t('row.probeFailed')
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

/**
 * `MM/DD, HH:mm` on a 24-hour clock.
 *
 * `hourCycle: 'h23'` is REQUIRED, not decorative: without it `Intl` follows the
 * browser locale's preference, and en-US renders `09/30, 01:23 PM`. A wall-clock
 * glued to "AM/PM" reads as 12-hour no matter what the surrounding UI assumes,
 * and it is the one thing a Chinese user cannot scan past — the card otherwise
 * speaks 24-hour everywhere (see `formatClock`).
 *
 * `h23` rather than `hour12: false`, because the latter maps to `h24` in some
 * engines and would print midnight as `24:00`. `h23` pins 00–23 exactly, which
 * is also the cycle DSH's own timestamps use.
 */
function formatShort(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

/** A dot colour for one account's state. */
function stateColor(account: WorkBuddyWebPoolAccount): string {
  if (account.excludedBy !== undefined) {
    // Amber for states that resolve on their own, red for states that need the
    // user to act. `unavailable` is an unreachable upstream — the same
    // "wait, do not re-auth" class as a rate limit — so painting it red would
    // assert the account is broken when only the network was.
    return account.excludedBy === 'rate-limited' || account.excludedBy === 'unavailable'
      ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
      : 'var(--dsw-alias-state-error-primary, #ef4444)'
  }
  if (account.probe === undefined) return 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return outcomeOk(account.probe.outcome)
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : 'var(--dsw-alias-state-warn-primary, #f59e0b)'
}

/** The exclusion label for one account, or undefined when it is usable. */
function exclusionText(t: Translate, account: WorkBuddyWebPoolAccount): string | undefined {
  switch (account.excludedBy) {
    case 'rate-limited': return t('row.poolExcludedRateLimited')
    case 'out-of-credit': return t('row.poolExcludedOutOfCredit')
    case 'credential-rejected': return t('row.poolExcludedRejected')
    // These four used to be folded into 'credential-rejected', which made the
    // name column contradict the probe column right beside it: "被拒绝，请重新
    // 登录" next to "连不上上游——这是网络问题". They now reuse the probe labels,
    // so one measurement yields one consistent story.
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    case 'failed': return t('row.probeFailed')
    case 'unusable': return t('row.poolExcludedUnusable')
    default: return undefined
  }
}

/**
 * The pool section.
 *
 * Renders nothing when the Host reports no pool state at all: an older Host
 * built without this feature should show an unmodified card, not an empty
 * section implying the feature exists.
 */
export function AccountPool(props: AccountPoolProps): ReturnType<typeof h> | null {
  const { t, region, pool, settingsScope, siblingBusy, onBusyChange, onSaved, onRefresh } = props
  const [draft, setDraft] = useState<PoolPreferences | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
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
    memberAccountIds: pool?.memberAccountIds ?? [],
  }
  // The draft only applies to the tab it was made on.
  const active: PoolPreferences = draftRegion === region && draft !== null ? draft : saved
  const dirty = draftRegion === region && draft !== null && (
    draft.enabled !== saved.enabled
    || draft.targetModelId !== saved.targetModelId
    // Order-insensitive: the user's clicks decide the set, not its ordering,
    // so re-checking the same accounts in a different order is not a change.
    || !sameIds(draft.memberAccountIds, saved.memberAccountIds)
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
  const savedEffective = pool?.effectiveMemberAccountIds ?? []
  const effectiveMembers = effectiveMemberIds({
    savedEffective,
    draftMembers: active.memberAccountIds,
    listedIds,
    dirty,
  })
  /** Saved ids with no matching sign-in; surfaced rather than silently ignored. */
  const ghostMembers = ghostMemberIds(active.memberAccountIds, listedIds)

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
  }, [])

  /** Save the pool preferences through the plugin's VERIFIED write path. */
  const save = useCallback(async (): Promise<void> => {
    if (settingsScope === undefined || !dirty || draft === null) return
    setSaving(true)
    setSaveError(undefined)
    // Set only once the write VERIFIED *and* the fresh props are in.
    // `discard()` must never run otherwise: the draft is the only copy of the
    // user's edits, so throwing it away after a failed write would be
    // unrecoverable — and throwing it away against a still-stale `saved` prop
    // would show the values the user just replaced.
    let committed = false
    try {
      await writePoolPreferences(settingsScope, region, draft)
      // Re-read the Host's answer BEFORE discarding the draft.
      //
      // `discard()` makes `active` fall back to the `saved` prop, which comes
      // from the usage route — so discarding first and refreshing afterwards
      // leaves a window where the panel shows the OLD values the user just
      // replaced, with the controls live again. Awaiting the re-read first keeps
      // the just-saved draft on screen (and `saving` true, so nothing is
      // interactive) until the fresh props have actually arrived, and the
      // discard that follows is then invisible: the draft and the new `saved`
      // agree.
      //
      // The result is CHECKED, not ignored. The parent reports a re-read that
      // did not deliver fresh props by resolving `false` — it cannot throw,
      // because the card's `refreshUsage` answers a failed fetch by resolving.
      // Inferring success from "did not throw" is what let a failed re-read
      // discard the draft and revert the panel to the pre-edit values.
      const refreshed = await onSaved?.()
      if (refreshed === false) {
        // The write verified, so this is a DISPLAY problem rather than data
        // loss: the Host has the new preferences. Keep the draft (it equals
        // what was just saved) and say so; the 60s poll repairs the panel.
        if (mounted.current) setSaveError(t('row.poolSavedStaleRefresh'))
        return
      }
      committed = true
    } catch (error: unknown) {
      // A failed WRITE lands here — and so would a parent `onSaved` that threw.
      // Either way the draft is the only copy of the user's edits, so it must
      // be kept. (A failed RE-READ does not land here: it resolves `false`, and
      // is handled above.)
      if (mounted.current) {
        const reason = error instanceof Error ? error.message : t('row.requestFailed')
        // A contention refusal needs the remedy appended: the raw message names
        // a temp file and no cause. See `isFileContentionWriteError`.
        setSaveError(isFileContentionWriteError(error) ? `${reason}${t('row.saveContentionHint')}` : reason)
      }
    } finally {
      if (committed) discard()
      if (mounted.current) setSaving(false)
    }
  }, [dirty, discard, draft, onSaved, region, settingsScope, t])

  /** Check or uncheck one account in this pool. */
  const toggleMember = useCallback((accountId: string, next: boolean): void => {
    editDraft(current => {
      const set = new Set(current.memberAccountIds)
      if (next) set.add(accountId)
      else set.delete(accountId)
      return { ...current, memberAccountIds: [...set] }
    })
  }, [editDraft])

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
    try {
      const response = await fetch(withWorkBuddyRegionAndAction(WORKBUDDY_POOL_PATH, region, action), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
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
          } else {
            appendLog(t('row.poolLogCheckinFailed', {
              accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
              message: row.message ?? t('row.requestFailed'),
            }), 'error')
          }
        }
        appendLog(t('row.poolLogCheckinDone'), 'ok')
      } else {
        for (const row of (body?.rows ?? []) as WorkBuddyWebPoolTestRow[]) {
          // Tolerate a malformed row instead of dereferencing it blind: one bad
          // entry used to throw a TypeError out of the whole loop, which the
          // outer catch turned into a batch error — so the remaining rows were
          // never reported and no completion line was written.
          const outcome = row?.result?.outcome
          if (outcome === undefined) {
            appendLog(t('row.poolLogTestRowMalformed', {
              accountName: row?.accountName === '' || row?.accountName === undefined
                ? t('row.accountUnnamed')
                : row.accountName,
            }), 'warn')
            continue
          }
          appendLog(t('row.poolLogTestRow', {
            accountName: row.accountName === '' ? t('row.accountUnnamed') : row.accountName,
            outcome: outcomeText(t, outcome),
          }), outcomeOk(outcome) ? 'ok' : 'warn')
        }
        appendLog(t('row.poolLogTestDone'), 'ok')
      }
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

  if (pool === undefined) return null

  /**
   * Where the target model came from.
   *
   * Rendered under the buttons. This was computed and then never used, so the
   * card never explained its own target — which is the entire reason
   * `targetModelSource` is sent by the Host.
   */
  const targetLabel = pool.targetModelSource === 'preferred'
    ? t('row.poolTargetPreferred', { model: pool.targetModelId ?? '' })
    : pool.targetModelSource === 'free'
      ? t('row.poolTargetFree', { model: pool.targetModelId ?? '' })
      : pool.targetModelSource === 'stale'
        ? t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' })
        : t('row.poolTargetNone')

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

  return h('section', { className: 'dsm-workbuddy-pool' },
    h('div', { className: 'dsm-workbuddy-pool-head' },
      h('div', null,
        h('h3', { className: 'dsm-workbuddy-pool-title' }, t('row.poolTitle')),
        h('p', { className: 'dsm-workbuddy-pool-summary' }, t('row.poolSummary', {
          count: effectiveMembers.length,
          // Never claim "auto" when no model could be resolved: the notice
          // below says there is none, and the two lines contradicted each other.
          model: pool.targetModelId
            ?? (pool.targetModelSource === 'stale'
              ? t('row.poolTargetStaleShort')
              : pool.targetModelSource === 'none'
                ? t('row.poolTargetNoneShort')
                : t('row.poolTargetAuto')),
        })),
      ),
      // Which account is serving, stated in the header rather than left to a row
      // tint the user has to go looking for. The pool's whole job is deciding who
      // gets billed, so "who is it right now" belongs where the eye lands first —
      // and once failover exists it is the question a reader actually has.
      currentName === undefined
        ? null
        : h('div', { className: 'dsm-workbuddy-pool-current' },
            h('span', { className: 'dsm-workbuddy-pool-current-badge' },
              t('row.poolCurrentHeader', { account: currentName })),
            h('span', { className: 'dsm-workbuddy-pool-current-hint' },
              t('row.poolCurrentHint')),
          ),
    ),

    // The batch buttons. Testing is disabled when no free model resolved, so a
    // press cannot silently bill a paid model. The check-in button exists only
    // where the region HAS a check-in: the international region has none, and a
    // button whose only outcome is a refusal is worse than no button.
    h('div', { className: 'dsm-workbuddy-pool-actions' },
      pool.checkinSupported
        ? h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn-primary',
            // Disabled with an EMPTY pool too: the buttons act on checked
            // accounts only, and an enabled-with-nothing-checked pool has
            // nothing to run.
            disabled: busy !== undefined || !active.enabled || effectiveMembers.length === 0,
            onClick: () => { void runAction('checkin') },
          }, busy === 'checkin' ? t('row.poolCheckingIn') : t('row.poolCheckinAll'))
        : null,
      h('button', {
        type: 'button',
        className: 'dsm-btn dsm-btn-outline',
        disabled: busy !== undefined
          || !active.enabled
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
      busy === undefined ? null
        : h('span', { className: 'dsm-workbuddy-pool-hint' }, t('row.poolBusyHint')),
    ),

    h('p', { className: 'dsm-workbuddy-pool-note' }, targetLabel),

    !active.enabled
      ? h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolEnabledHint'))
      : null,

    // Failover needs somewhere to go. With every member measured unusable (or
    // none checked at all) a failure is reported instead of retried, so say so
    // rather than leaving the user to infer it from a failed request.
    active.enabled && usable.length === 0
      ? h('p', { className: 'dsm-workbuddy-pool-warn', role: 'status' },
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
      h('div', { className: 'dsm-workbuddy-pool-table' },
        h('div', { className: 'dsm-workbuddy-pool-row dsm-workbuddy-pool-row-head' },
          h('span', null, t('row.poolColumnAccount')),
          h('span', null, t('row.poolColumnCredits')),
          h('span', null, t('row.poolColumnProbe')),
          pool.checkinSupported ? h('span', null, t('row.poolColumnCheckin')) : null,
        ),
        ...pool.accounts.map(account => renderAccountRow({
          t,
          account,
          checked: active.memberAccountIds.includes(account.accountId),
          canEdit: canEditPool,
          checkinSupported: pool.checkinSupported,
          onToggle: next => toggleMember(account.accountId, next),
        })),
      ),
      effectiveMembers.length === 0
        ? h('p', { className: 'dsm-workbuddy-pool-warn', role: 'status' },
            `${t('row.poolNoneSelected')} ${t('row.poolNoneSelectedHint')}`)
        : null,
      // State the discrepancy instead of silently ignoring the stale ids: the
      // user's saved list still contains them, and they need to know why the
      // pool behaves as if they were absent.
      ghostMembers.length === 0
        ? null
        : h('p', { className: 'dsm-workbuddy-pool-warn', role: 'status' },
            t('row.poolGhostMembers', { count: ghostMembers.length })),
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
      saveError, settingsScope,
      onEdit: editDraft, onSave: () => { void save() }, onDiscard: discard,
      appendLog,
    }),

    h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolRegionNote')),

    renderLog({ t, log, busy: busy !== undefined, onClear: () => { logStore.set(region, []); setLog([]) } }),
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
}): ReturnType<typeof h> {
  const { t, account, checked, canEdit, checkinSupported, onToggle } = input
  const name = account.accountName === '' ? t('row.accountUnnamed') : account.accountName
  const excluded = exclusionText(t, account)
  const probe = account.probe
  const probeLine = probe === undefined
    ? t('row.poolNeverTested')
    : probe.retryAtMs !== undefined
      ? `${outcomeText(t, probe.outcome)} · ${t('row.poolRetryAt', { at: formatShort(probe.retryAtMs) })}`
      // A limited account with NO stated time says exactly that. Rendering the
      // bare outcome would leave the user unable to tell "the upstream gave no
      // time" apart from "this plugin forgot to show it" — and the honest
      // absence is the same contract `cooldownOf()` already keeps.
      : probe.outcome === 'rate-limited' || probe.outcome === 'out-of-credit'
        ? `${outcomeText(t, probe.outcome)} · ${t('row.poolRetryUnknown')}`
        : outcomeText(t, probe.outcome)

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
        // Which account is serving, in WORDS. The row tint alone is a 7%-opacity
        // background: enough to spot when you already know to look, and no help
        // at all when the question is "which one is it?".
        account.current
          ? h('span', { className: 'dsm-workbuddy-pool-current-tag' }, t('row.poolCurrentBadge'))
          : null,
        // Membership is stated on every row, because an unchecked account's
        // empty credit/probe columns are otherwise indistinguishable from a
        // checked account that simply has no data yet.
        h('span', {
          className: checked
            ? 'dsm-workbuddy-pool-member'
            : 'dsm-workbuddy-pool-not-member',
        }, checked ? t('row.poolMember') : t('row.poolNotMember')),
        excluded === undefined
          ? probe === undefined ? null : h('span', null, t('row.poolTestedAt', { at: formatShort(probe.atMs) }))
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
              t('row.poolCreditNearest', { at: formatShort(account.nearestExpiryMs) })),
    ),
    h('span', { className: 'dsm-workbuddy-pool-probe' }, probeLine),
    checkinSupported
      ? h('span', { className: 'dsm-workbuddy-pool-checkin' },
          // Three states, not two: an unread account says nothing rather than
          // claiming "not checked in", which would contradict a check-in the user
          // just watched succeed.
          account.checkedInToday === undefined
            ? h('span', { className: 'dsm-workbuddy-pool-unknown', title: t('row.poolNeverTested') },
                t('row.poolCheckinUnknown'))
            : account.checkedInToday
              ? h('span', { className: 'dsm-workbuddy-pool-checked' }, t('row.poolCheckedIn'))
              : t('row.poolNotCheckedIn'),
        )
      // Absent entirely where the region has no check-in: an empty column would
      // still imply the state exists and is merely unknown.
      : null,
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
  settingsScope: WorkBuddyAccountScope | undefined
  onEdit: (edit: (current: PoolPreferences) => PoolPreferences) => void
  onSave: () => void
  onDiscard: () => void
  appendLog: (text: string, tone: PoolLogEntry['tone']) => void
}): ReturnType<typeof h> {
  const {
    t, pool, active, dirty, saving, siblingBusy,
    saveError, settingsScope,
    onEdit, onSave, onDiscard,
  } = input
  const canEdit = settingsScope !== undefined

  const toggle = (
    label: string,
    hint: string,
    checked: boolean,
    onChange: (next: boolean) => void,
    disabled = false,
  ): ReturnType<typeof h> => h('div', { className: 'dsm-workbuddy-pool-set' },
    h('span', { className: 'dsm-workbuddy-pool-set-copy' },
      h('b', null, label),
      h('span', null, hint),
    ),
    h('span', { className: 'dsm-workbuddy-pool-set-ctl' },
      h('label', { className: 'sw' },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: disabled || !canEdit,
          onChange: (event: { currentTarget: { checked: boolean } }) => onChange(event.currentTarget.checked),
        }),
        h('span', { className: 'sw-track' }),
      ),
    ),
  )

  return h('div', { className: 'dsm-workbuddy-pool-settings-wrap' },
    h('div', { className: 'dsm-workbuddy-pool-head' },
      h('h3', { className: 'dsm-workbuddy-pool-title' }, t('row.poolSettingsTitle')),
      dirty ? h('span', { className: 'dsm-workbuddy-pool-dirty' }, t('row.poolDirty')) : null,
    ),
    h('p', { className: 'dsm-workbuddy-pool-note' }, t('row.poolSettingsHint')),

    h('div', { className: 'dsm-workbuddy-pool-settings' },
      toggle(
        t('row.poolEnabled'),
        t('row.poolEnabledHint'),
        active.enabled,
        next => onEdit(current => ({ ...current, enabled: next })),
      ),
      h('div', { className: 'dsm-workbuddy-pool-set' },
        h('span', { className: 'dsm-workbuddy-pool-set-copy' },
          h('b', null, t('row.poolTargetLabel')),
          h('span', null, t('row.poolTargetHint')),
        ),
        h('span', { className: 'dsm-workbuddy-pool-set-ctl' },
          h('select', {
            className: 'dsm-workbuddy-pool-select',
            value: active.targetModelId,
            disabled: !active.enabled || !canEdit,
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
    ),

    h('div', { className: 'dsm-workbuddy-pool-save-bar' },
      h('button', {
        type: 'button',
        className: 'dsm-btn dsm-btn-primary',
        disabled: !dirty || saving || siblingBusy || !canEdit,
        onClick: onSave,
      }, saving ? t('row.poolSaving') : t('row.poolSaved')),
      h('button', {
        type: 'button',
        className: 'dsm-btn dsm-btn-outline',
        disabled: !dirty || saving || siblingBusy,
        onClick: onDiscard,
      }, t('row.poolDiscard')),
      h('span', { className: 'dsm-workbuddy-pool-hint' },
        dirty ? t('row.poolSaveDirty') : t('row.poolSaveIdle')),
    ),

    saveError === undefined
      ? null
      : h('p', { className: 'dsm-workbuddy-pool-error', role: 'alert' },
          t('row.poolSaveFailed', { message: saveError })),
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
