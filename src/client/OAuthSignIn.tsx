/**
 * The card's OAuth QR sign-in section.
 *
 * 参考：扫码登录的通行形态 —— 发起登录 → 打开授权页 →
 *   轮询到完成为止 → 展示结果。本实现把轮询循环压成一个组件内 effect：
 *   打开授权页的是用户点击的链接（浏览器标签页，非弹窗），组件只负责
 *   按 `OAUTH_POLL_INTERVAL_MS` 节奏问 Host「完成了吗」，完成即停。
 *
 * 为什么不用 window.open：卡片运行在 Harness 的设置页 iframe/沙箱里，弹窗
 *   会被拦截；把授权 URL 渲染成普通链接（target=_blank rel=noopener）是
 *   沙箱内最可靠的方式，用户也可以复制链接到手机上继续（URL 即登录态）。
 *
 * 所有状态就地管理，零跨组件往返：取消 = 停止轮询 + 清理 loginId；
 * Host 重启导致 loginId 失效会得到 done+error，与超时同一条文案路径。
 *
 * @module dsh-connect-workbuddy/client/OAuthSignIn
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { OAUTH_POLL_INTERVAL_MS, WORKBUDDY_OAUTH_PATH, withWorkBuddyRegion } from '../status-paths.ts'
import type { WorkBuddyWebRegion } from '../status-paths.ts'
import type { Translate } from './searched-paths.ts'

/** Props: the region tab the section is rendered on, and the card's copy. */
export interface OAuthSignInProps {
  t: Translate
  region: WorkBuddyWebRegion
}

/** One poll's body as the Host's route answers it. */
type PollBody =
  | { done: false }
  | { done: true, accountName?: string, accountId?: string, error?: string }

type Phase =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'waiting', loginId: string, verificationUri: string, startedAtMs: number, expiresAtMs: number }
  | { kind: 'finished', message: 'added' | 'cancelled' | 'error', accountName?: string, error?: string }

/** Seconds since the login started, for the waiting line. */
function elapsedSeconds(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / 1000))
}

/**
 * The section. Rendered on BOTH sign-in states: a signed-out machine gains
 * its first account here; a signed-in one can add another without leaving
 * the card.
 */
export function OAuthSignIn({ t, region }: OAuthSignInProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [pollTick, setPollTick] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
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
  }, [waiting, phase])

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
          const response = await fetch(withWorkBuddyRegion(WORKBUDDY_OAUTH_PATH, region), {
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
            setPhase({
              kind: 'finished',
              message: 'added',
              accountName: body.accountName ?? '',
            })
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
  }, [phase, pollTick, region])

  const start = async (): Promise<void> => {
    setPhase({ kind: 'opening' })
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_OAUTH_PATH, region), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json() as
        | { loginId?: string, verificationUri?: string, expiresIn?: number, error?: string }
      if (!mounted.current) return
      if (!response.ok || typeof body.loginId !== 'string' || typeof body.verificationUri !== 'string') {
        setPhase({ kind: 'finished', message: 'error', error: body.error ?? `HTTP ${response.status}` })
        return
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
      if (mounted.current) {
        setPhase({ kind: 'finished', message: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  if (phase.kind === 'finished') {
    const text = phase.message === 'added'
      ? t('row.oauthDone', { accountName: phase.accountName === '' || phase.accountName === undefined ? t('row.accountUnnamed') : phase.accountName })
      : phase.message === 'cancelled'
        ? t('row.oauthCancelled')
        : t('row.oauthError', { message: phase.error ?? '' })
    return (
      <section className="dsm-workbuddy-oauth" aria-label={t('row.oauthTitle')}>
        <p className={phase.message === 'added' ? 'dsm-workbuddy-oauth-ok' : 'dsm-workbuddy-oauth-error'}>{text}</p>
        <button type="button" className="dsm-btn dsm-btn-outline" onClick={() => { setPhase({ kind: 'idle' }) }}>
          {t('row.oauthStart')}
        </button>
      </section>
    )
  }

  return (
    <section className="dsm-workbuddy-oauth" aria-label={t('row.oauthTitle')}>
      <p className="dsm-workbuddy-oauth-title">{t('row.oauthTitle')}</p>
      {phase.kind === 'waiting'
        ? <>
            <p>
              <a href={phase.verificationUri} target="_blank" rel="noopener noreferrer">{t('row.oauthOpen')}</a>
              {' — '}{t('row.oauthOpened')}
            </p>
            <p className="dsm-workbuddy-oauth-hint">
              {t('row.oauthWaiting', { seconds: elapsedSeconds(phase.startedAtMs, nowMs) })}
              {' '}
              {t('row.oauthExpires', { minutes: Math.max(1, Math.round((phase.expiresAtMs - nowMs) / 60_000)) })}
            </p>
            <button
              type="button"
              className="dsm-btn dsm-btn-outline"
              onClick={() => { setPhase({ kind: 'finished', message: 'cancelled' }) }}
            >
              {t('row.oauthCancel')}
            </button>
          </>
        : <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={phase.kind === 'opening'}
            onClick={() => { void start() }}
          >
            {phase.kind === 'opening' ? t('row.oauthStarting') : t('row.oauthStart')}
          </button>}
    </section>
  )
}
