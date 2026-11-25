/**
 * The card's OAuth QR sign-in section: one resting bar row plus a dialog
 * opened by the sign-in button.
 *
 * 参考：workbuddy2api-panel 的「添加账号」弹窗交互形态 —— 静态入口一行，
 *   点开后弹窗内分步走：获取授权链接 → 自动打开浏览器 → 弹窗内显示链接
 *   与等待状态 → 完成/失败回填结果。本实现沿用该步骤划分；弹窗样式直接
 *   用本项目导出/导入弹框的类（dsm-workbuddy-transfer-dialog），不引入
 *   第二套视觉。
 * 改动：自动打开浏览器。弹窗拦截的规避方式是「用户手势内同步 window.open
 *   占位，拿到授权 URL 后再导航」——点击「获取授权链接」的那一刻浏览器
 *   仍认定这是用户激活的手势链，占位窗口不会被拦；若 Host 环境连占位都
 *   拦（返回 null），降级为弹窗内手动「打开登录页」链接，功能不损失。
 *
 * 轮询循环压成一个组件内 effect：按 `OAUTH_POLL_INTERVAL_MS` 节奏问 Host
 *   「完成了吗」，完成即停。所有状态就地管理，零跨组件往返；Host 重启
 *   导致 loginId 失效会得到 done+error，与超时同一条文案路径。
 *
 * @module dsh-connect-workbuddy/client/OAuthSignIn
 */

import { resolveRequestUrl } from './request-url.ts'
import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { OAUTH_POLL_INTERVAL_MS, WORKBUDDY_OAUTH_PATH, withWorkBuddyRouteAction } from '../status-paths.ts'
import type { WorkBuddyWebRegion } from '../status-paths.ts'
import type { Translate } from './searched-paths.ts'
import { BusyOverlay } from './BusyOverlay.tsx'

/** Props: the region tab the section is rendered on, and the card's copy. */
export interface OAuthSignInProps {
  t: Translate
  region: WorkBuddyWebRegion
  /**
   * Called once the Host has stored the credential, so the CARD can re-read
   * its snapshot and show the new account immediately.
   *
   * The account only reaches the table through the usage route; without this
   * the row appeared on the next poll, and on a region that had no account
   * before the sign-in there was no poll at all — the new account showed up
   * only after the card was closed and reopened.
   */
  onAdded?: () => void | Promise<unknown>
}

/** One poll's body as the Host's route answers it. */
type PollBody =
  | { done: false }
  | { done: true, accountName?: string, accountId?: string, error?: string }

type Phase =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'waiting', loginId: string, verificationUri: string, startedAtMs: number, expiresAtMs: number }
  /** The Host stored the credential; the card's re-read is still in flight. */
  | { kind: 'syncing', accountName: string }
  | { kind: 'finished', message: 'added' | 'cancelled' | 'error', accountName?: string, error?: string }

/** Seconds since the login started, for the waiting line. */
function elapsedSeconds(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / 1000))
}

/**
 * How long the `syncing` phase may hold the veil before it lets go (issue #51).
 *
 * Shorter than a poll interval would be pointless; a few seconds is far longer
 * than a healthy loopback re-read takes, and anything past that is
 * indistinguishable from "never".
 *
 * What sits below this decision is an asymmetry worth spelling out. The
 * `waiting` phase has its own local deadline (see the waiting-clock effect), so
 * a login whose `loginId` died still ends. The `syncing` phase reached the veil
 * and awaited the card's re-read with NEITHER a deadline NOR a `catch` — and the
 * veil's visibility is `phase.kind === 'syncing'` and nothing else. So a re-read
 * that never settled held the veil up forever, while the credential was already
 * in the vault: reopening the card (or force-quitting DSH) showed the account,
 * which is exactly the "half usable" report — sign-in succeeded, the screen
 * never said so.
 */
const SYNC_SETTLE_TIMEOUT_MS = 5_000

/**
 * Await `work` but give up after `timeoutMs`; resolves `false` on timeout.
 *
 * The timer is cleared in a `finally`, so the common case (the re-read settles
 * first) leaves no pending timer holding the event loop — the reason this is a
 * race with an explicit cleanup rather than `Promise.race` alone.
 *
 * The timeout arm never rejects: a re-read that FAILS is not a failed sign-in,
 * and the caller must not be able to confuse the two. Rejection and timeout
 * stand for the same thing here — "the list did not prove it refreshed" — so
 * they take the same path.
 *
 * EXPORTED because `AccountTransfer`'s veil awaits the same card re-read and had
 * the same unbounded wait; sharing one implementation is what stops the two
 * veils from drifting apart again.
 */
export async function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(work).then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Copy the sign-in URL to the clipboard; true on success.
 */
async function copyUrl(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    return false
  }
}

/**
 * The section. Rendered on BOTH sign-in states: a signed-out machine gains
 * its first account here; a signed-in one can add another without leaving
 * the card.
 */
export function OAuthSignIn({ t, region, onAdded }: OAuthSignInProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pollTick, setPollTick] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
  /**
   * The account the Host just added, held for the sync effect.
   *
   * The poll that answers `done` names the account; the effect that ends the
   * `syncing` phase needs that name to write the success line, and it cannot
   * read it off the phase because the phase is what it is about to replace.
   * State rather than a ref: the effect is keyed on it, so a second sign-in
   * (adding a second account) re-arms the deadline properly instead of reusing
   * a stale closure value.
   */
  const [addedAccountName, setAddedAccountName] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // The waiting clock: one tick a second only while a login is in flight. A
  // login that runs PAST its stated expiry turns into a local timeout — the
  // Host's session expires independently, and this stops the UI waiting on a
  // dead loginId even if a poll answer was lost.
  const waiting = phase.kind === 'waiting'
  useEffect(() => {
    if (!waiting || phase.kind !== 'waiting') return
    const expiresAtMs = phase.expiresAtMs
    const timer = setInterval(() => {
      if (!mounted.current) return
      const now = Date.now()
      setNowMs(now)
      if (now > expiresAtMs) setPhase({ kind: 'finished', message: 'error', error: t('row.oauthTimedOut') })
    }, 1000)
    return () => { clearInterval(timer) }
  }, [waiting, phase, t])

  // The poll loop: one request per interval while waiting, ending on done.
  // A pending answer bumps `pollTick`, which re-arms this effect for the next
  // interval — one in-flight poll at a time, no accumulating timers.
  useEffect(() => {
    if (phase.kind !== 'waiting') return
    const { loginId } = phase
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(resolveRequestUrl(withWorkBuddyRouteAction(WORKBUDDY_OAUTH_PATH, region, 'poll')), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ loginId }),
          })
          const body = await response.json() as PollBody
          if (cancelled || !mounted.current) return
          if (!response.ok || !body || typeof body !== 'object') {
            setPhase({ kind: 'finished', message: 'error', error: `HTTP ${response.status}` })
            return
          }
          if (!body.done) {
            setPollTick(tick => tick + 1)
            return
          }
          if (typeof body.error === 'string' && body.error !== '') {
            setPhase({ kind: 'finished', message: 'error', error: body.error })
          } else {
            const accountName = body.accountName ?? ''
            // Hold the veil across the re-read: the credential is stored, but
            // the account table changes only when the card's fresh snapshot
            // lands. Same reasoning as the import path in AccountTransfer.
            //
            // The wait itself lives in its own effect (the 'syncing' deadline
            // effect below) rather than here, and that placement IS the fix —
            // see the note on that effect for why awaiting it from THIS closure
            // cannot work.
            setPhase({ kind: 'syncing', accountName })
            setAddedAccountName(accountName)
          }
        } catch {
          // A transport blip is not a dead login; the next tick retries, and
          // the session deadline on the Host eventually ends a stuck login.
          setPollTick(tick => tick + 1)
        }
      })()
    }, OAUTH_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [onAdded, phase, pollTick, region])

  /**
   * End the `syncing` phase — on the re-read, or on the deadline, whichever
   * comes first (issue #51).
   *
   * ## Why this is a separate effect and not an `await` in the poll
   *
   * The first attempt at this fix put the race inside the poll's `done` branch:
   *
   *     setPhase({ kind: 'syncing', accountName })
   *     await settlesWithin(onAdded?.(), SYNC_SETTLE_TIMEOUT_MS)
   *     if (cancelled || !mounted.current) return
   *     setPhase({ kind: 'finished', … })
   *
   * and it did not work — measured, not assumed. `phase` is a dependency of the
   * poll effect, so `setPhase({kind:'syncing'})` re-runs that effect, and React
   * runs the PREVIOUS cleanup first. That cleanup sets the old closure's
   * `cancelled = true`. React commits the cleanup before the `await` it is
   * inside ever resumes, so the resume always sees `cancelled === true` and
   * returns: the veil stayed up exactly as it had before.
   *
   * This also explains why the defect was invisible in review. A FAST re-read
   * resolves inside the same microtask batch, before React commits the cleanup,
   * so it passes the guard and the success line appears. Only a re-read slow
   * enough to cross a React commit — i.e. the reported case — loses the race
   * against its own cleanup. The bug hid behind its own common path.
   *
   * Running the wait in an effect keyed on the phase sidesteps the whole
   * interaction: this effect's own cleanup runs when the phase LEAVES
   * `syncing`, which is after it has already done its job, so there is no
   * self-cancellation to lose.
   *
   * ## The two outcomes
   *
   * Both end in `finished`/`added` and the difference is deliberately not shown
   * to the user. The account IS added — the Host stored the credential before it
   * answered the poll — so the honest report is success either way; the deadline
   * only stops the screen from claiming otherwise indefinitely. (`refreshUsage`
   * already surfaces a failed re-read as `refreshError` on the card itself, so
   * a genuinely broken usage route is still reported, by the component that
   * owns that data.)
   */
  useEffect(() => {
    if (phase.kind !== 'syncing') return
    let cancelled = false
    const finish = (): void => {
      if (cancelled || !mounted.current) return
      setPhase({ kind: 'finished', message: 'added', accountName: addedAccountName })
    }
    void settlesWithin(Promise.resolve(onAdded?.()), SYNC_SETTLE_TIMEOUT_MS).then(finish)
    // The deadline is a floor under `finish`, not an alternative to it: if the
    // re-read never answers, nothing else would ever call it.
    const timer = setTimeout(finish, SYNC_SETTLE_TIMEOUT_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [addedAccountName, onAdded, phase])

  /**
   * Open a placeholder window WITHOUT `noopener`, and deliberately so.
   *
   * `noopener` is the correct feature for a link whose destination never needs
   * a handle — and that is exactly why it is wrong here. Per the spec, a
   * `window.open` call carrying `noopener` opens the tab but returns `null`
   * (MDN: "the new window will not have access to the originating window via
   * `Window.opener` and returns `null`"). The placeholder exists ONLY to be
   * navigated once the Host answers, so the handle IS the point: passing
   * `noopener` made `placeholder` null, the navigation was skipped, and every
   * sign-in left an empty `about:blank` tab behind instead of the sign-in page.
   *
   * The security property is kept, just established on the handle instead of
   * through the feature: `opener = null` is applied to the placeholder before
   * anything is loaded into it, so the destination still cannot reach back
   * through `window.opener`. `noreferrer` is dropped for the same reason —
   * the spec makes it imply `noopener`, so it would reintroduce the null.
   * Nothing is lost: the placeholder is same-origin and empty until navigated,
   * and the referrer would only ever have been the settings page.
   */
  function openPlaceholder(): Window | null {
    const placeholder = window.open('', '_blank')
    if (placeholder !== null) placeholder.opener = null
    return placeholder
  }

  /**
   * Fetch the authorization URL AND open the browser in one gesture chain.
   * The placeholder window is opened synchronously — inside the click's user
   * activation, before any await — so popup blocking cannot intervene; the
   * URL is navigated once the Host answers. A blocked placeholder (null)
   * degrades to the manual link inside the dialog, losing nothing but the
   * convenience.
   */
  const start = async (placeholder: Window | null): Promise<void> => {
    setPhase({ kind: 'opening' })
    setCopied(false)
    try {
      const response = await fetch(resolveRequestUrl(withWorkBuddyRouteAction(WORKBUDDY_OAUTH_PATH, region, 'start')), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json() as
        | { loginId?: string, verificationUri?: string, expiresIn?: number, error?: string }
      if (!mounted.current) { placeholder?.close(); return }
      if (!response.ok || typeof body.loginId !== 'string' || typeof body.verificationUri !== 'string') {
        placeholder?.close()
        setPhase({ kind: 'finished', message: 'error', error: body.error ?? `HTTP ${response.status}` })
        return
      }
      if (placeholder !== null) {
        placeholder.location.href = body.verificationUri
      }
      setPhase({
        kind: 'waiting',
        loginId: body.loginId,
        verificationUri: body.verificationUri,
        startedAtMs: Date.now(),
        // The route states the TTL in seconds; a Host that omits it gets the
        // documented 10 minutes rather than an invented longer window.
        expiresAtMs: Date.now() + (typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : 600) * 1000,
      })
      setNowMs(Date.now())
    } catch (error: unknown) {
      placeholder?.close()
      if (mounted.current) {
        setPhase({ kind: 'finished', message: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /** Open the dialog and begin the login in the same click: the placeholder
   * window must be created synchronously to count as a user gesture. */
  const beginSignIn = (): void => {
    setDialogOpen(true)
    void start(openPlaceholder())
  }

  /** Re-open the sign-in page from the waiting dialog (no new session).
   *
   * Here `noopener,noreferrer` IS right: this is a one-way navigation to a
   * third-party page and nothing needs a handle on it — the contrast with
   * {@link openPlaceholder} is the whole distinction. */
  const reopen = (): void => {
    if (phase.kind !== 'waiting') return
    window.open(phase.verificationUri, '_blank', 'noopener,noreferrer')
  }

  /**
   * The three strings that NAME the sign-in method, per region.
   *
   * CN signs in by scanning a QR code with the WorkBuddy app; the international
   * build signs in on a web page. Every other line in this section (waiting,
   * cancel, done, copy) is about the flow, not the method, so it stays shared —
   * splitting it too would let the two regions drift apart for no gain.
   */
  const titleKey = region === 'cn' ? 'row.oauthTitle' : 'row.oauthTitleGlobal'
  const startKey = region === 'cn' ? 'row.oauthStart' : 'row.oauthStartGlobal'

  /*
   * The title is this section's ACCESSIBLE NAME, not a visible line.
   *
   * It used to be printed above the button, which said the same thing twice in
   * one row of pixels (「扫码添加账号」 over 「扫码登录」; the two differ in
   * spelling, not in meaning) and cost a line of height for every bar. A
   * section that contains exactly one button does not need a caption naming
   * that button — the button IS the label. `aria-label` keeps the name for a
   * screen reader, where a lone 「扫码登录」 has no section to sit in.
   */

  const finishText = phase.kind === 'finished'
    ? phase.message === 'added'
      ? t('row.oauthDone', { accountName: phase.accountName === '' || phase.accountName === undefined ? t('row.accountUnnamed') : phase.accountName })
      : phase.message === 'cancelled'
        ? t('row.oauthCancelled')
        : t('row.oauthError', { message: phase.error ?? '' })
    : ''

  return (
    <section className="dsm-workbuddy-bar" aria-label={t(titleKey)}>
      {/* Sign-in writes a credential and the account table then re-reads; the
          veil covers the gap so the new row appears without a manual reopen. */}
      <BusyOverlay
        visible={phase.kind === 'syncing'}
        message={t('row.oauthSyncing')}
        hint={t('row.veilHintList')}
      />
      {phase.kind === 'finished'
        ? <p className={`dsm-workbuddy-bar-status ${phase.message === 'added' ? 'dsm-workbuddy-bar-ok' : 'dsm-workbuddy-bar-error'}`}>{finishText}</p>
        : phase.kind === 'waiting'
          ? <p className="dsm-workbuddy-bar-status">{t('row.oauthOpened')}</p>
          : null}
      <div className="dsm-workbuddy-bar-actions">
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={phase.kind === 'opening'}
          onClick={beginSignIn}
        >
          {phase.kind === 'opening' ? t('row.oauthStarting') : t(startKey)}
        </button>
      </div>
      {dialogOpen
        ? <div className="dsm-workbuddy-transfer-dialog" role="dialog" aria-label={t(titleKey)}>
            {phase.kind === 'opening'
              ? <p>{t('row.oauthStarting')}</p>
              : phase.kind === 'waiting'
                ? <>
                    <p>{t('row.oauthOpenHint')}</p>
                    <p className="dsm-workbuddy-oauth-url">
                      <a href={phase.verificationUri} target="_blank" rel="noopener noreferrer">{phase.verificationUri}</a>
                    </p>
                    <p className="dsm-workbuddy-hint">
                      {t('row.oauthWaiting', { seconds: elapsedSeconds(phase.startedAtMs, nowMs) })}
                      {' '}
                      {t('row.oauthExpires', { minutes: Math.max(1, Math.round((phase.expiresAtMs - nowMs) / 60_000)) })}
                    </p>
                    <div className="dsm-workbuddy-transfer-dialog-actions">
                      <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        onClick={() => { void copyUrl(phase.verificationUri).then(ok => { if (mounted.current) setCopied(ok) }) }}
                      >
                        {copied ? t('row.oauthCopied') : t('row.oauthCopy')}
                      </button>
                      <button type="button" className="dsm-btn dsm-btn-outline" onClick={reopen}>{t('row.oauthReopen')}</button>
                      <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        onClick={() => { setPhase({ kind: 'finished', message: 'cancelled' }) }}
                      >
                        {t('row.oauthCancel')}
                      </button>
                    </div>
                  </>
                : phase.kind === 'finished'
                  ? <>
                      <p className={`${phase.message === 'added' ? 'dsm-workbuddy-bar-ok' : phase.message === 'error' ? 'dsm-workbuddy-bar-error' : ''}`}>{finishText}</p>
                      <div className="dsm-workbuddy-transfer-dialog-actions">
                        <button type="button" className="dsm-btn dsm-btn-outline" onClick={() => { setDialogOpen(false) }}>
                          {t('row.oauthDialogClose')}
                        </button>
                      </div>
                    </>
                  : null}
          </div>
        : null}
    </section>
  )
}
