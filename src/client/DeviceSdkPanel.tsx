/**
 * 卡片「SDK」分区：这台机器能不能取到真实设备参数，以及取到的是什么。
 *
 * ## 为什么它单独一页，而不是塞进「诊断」
 *
 * 诊断页是"出问题时贴给开发看的一屏事实"，只读、不含操作。这一页有操作（重取、
 * 显示、复制），而且用户会在**没出问题**的时候来看它——切到「真实值」之后第一件
 * 事就是确认"真的连上了吗、值是什么"。把这两种意图混在一页，诊断页就再也没法
 * 保持"只读"这条约定。
 *
 * ## 为什么默认是星号
 *
 * 完整 token 能代表这台机器。这一页会被截图、会被贴进 issue，所以默认只给掩码；
 * 「显示」与「复制」各要一次点击，Host 也只为这两次点击返回完整值
 * （`POST ?action=reveal`，见 `src/status-paths.ts`）。
 *
 * @module dsh-connect-workbuddy/client/DeviceSdkPanel
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { fetchDeviceSdk, refreshDeviceSdk, revealDeviceSdk } from './device-sdk.ts'
import type { DeviceSdkReport } from './device-sdk.ts'
import type { WorkBuddySettingsKey } from './locales.ts'
import type { Translate } from './searched-paths.ts'

export interface DeviceSdkPanelProps {
  t: Translate
  /** Host 的路由；空字符串 = 这个版本没有这条路由，整块不渲染。 */
  path: string
}

/** How one row reads: the label on the left, the value on the right. */
function Row(props: { label: string, children: ReactNode, mono?: boolean }): ReactElement {
  return (
    <div className="dsm-workbuddy-diag-row">
      <span className="dsm-workbuddy-diag-label">{props.label}</span>
      <span className={`dsm-workbuddy-diag-value${props.mono === true ? ' dsm-workbuddy-diag-mono' : ''}`}>
        {props.children}
      </span>
    </div>
  )
}

/** `12m ago` / `just now`, in the card's existing style. */
function describeAge(t: Translate, ageMs: number): string {
  if (ageMs < 60_000) return t('sdk.ageJustNow')
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 60) return t('sdk.ageMinutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  return t('sdk.ageHours', { count: hours, rest: minutes % 60 })
}

export function DeviceSdkPanel(props: DeviceSdkPanelProps): ReactElement | null {
  const { t, path } = props
  const [report, setReport] = useState<DeviceSdkReport | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 完整值：只在用户点过「显示」或「复制」之后才在内存里存在。 */
  const [value, setValue] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    if (path === '') return
    setBusy(true)
    setError(undefined)
    try {
      const next = refresh ? await refreshDeviceSdk(path) : await fetchDeviceSdk(path)
      setReport(next)
      // 重取会换一枚 token，之前显示的那份已经不是它了。
      if (refresh) { setValue(undefined); setCopied(false) }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      setLoading(false)
    }
  }, [path])

  useEffect(() => { void load(false) }, [load])

  if (path === '') return null
  if (loading) return <p className="dsm-workbuddy-panel-note">{t('sdk.loading')}</p>
  // Host 没有这条路由（老版本，或构建时裁掉了 native/）：给一句话，而不是一块
  // 空白面板——空白会被读成"我点坏了"。标签页本身保留，因为"这个 Host 没有 SDK"
  // 也是用户需要知道的事实。
  if (report === undefined && error === undefined) {
    return <p className="dsm-workbuddy-panel-note">{t('sdk.unavailable')}</p>
  }

  const toggle = async (): Promise<void> => {
    if (value !== undefined) { setValue(undefined); return }
    setError(undefined)
    try {
      const full = await revealDeviceSdk(path)
      if (full === undefined) setError(t('sdk.noValue'))
      else setValue(full)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const copy = async (): Promise<void> => {
    setError(undefined)
    try {
      const full = value ?? await revealDeviceSdk(path)
      if (full === undefined) { setError(t('sdk.noValue')); return }
      await navigator.clipboard.writeText(full)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 2000)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const sdk = report?.sdk
  const token = report?.token
  const stateKey: WorkBuddySettingsKey = sdk?.state === 'ready'
    ? (token?.state === 'ok' ? 'sdk.statusReady' : token?.state === 'stale' ? 'sdk.statusStale' : 'sdk.statusNoToken')
    : sdk?.state === 'missing' ? 'sdk.statusMissing' : sdk?.state === 'unsupported' ? 'sdk.statusUnsupported' : 'sdk.statusError'
  const stateOk = sdk?.state === 'ready' && token?.state === 'ok'

  return (
    <>
      <p className="dsm-workbuddy-panel-note">{t('sdk.hint')}</p>
      <div className="dsm-workbuddy-diag">
        <Row label={t('sdk.state')}>
          <span className={`dsm-workbuddy-sdk-dot${stateOk ? ' dsm-workbuddy-sdk-dot-ok' : ''}`} aria-hidden="true" />
          {t(stateKey)}
        </Row>
        <Row label={t('sdk.bundle')} mono>
          {sdk === undefined || sdk.bundle === '' ? t('sdk.unknown') : `${sdk.bundle} · ${sdk.path}`}
        </Row>
        <Row label={t('sdk.runtime')} mono>
          {sdk === undefined || sdk.runtime === '' ? t('sdk.unknown') : sdk.runtime}
        </Row>
        <Row label={t('sdk.fetched')}>
          {token?.fetchedAtMs === undefined
            ? t('sdk.never')
            : `${new Date(token.fetchedAtMs).toLocaleTimeString()} (${describeAge(t, Date.now() - token.fetchedAtMs)})`}
        </Row>
        <Row label={t('sdk.tier')}>
          {report?.tier === 'real' ? t('sdk.tierReal') : t('sdk.tierVirtual')}
        </Row>
      </div>

      {sdk !== undefined && sdk.reason !== undefined
        ? <p className="dsm-workbuddy-device-error">{sdk.reason}</p>
        : null}
      {token !== undefined && token.reason !== undefined
        ? <p className="dsm-workbuddy-device-error">{token.reason}</p>
        : null}

      {/* 真实值块：默认一行星号。`value` 只在用户点开之后才有内容，关掉即丢弃。 */}
      <div className="dsm-workbuddy-device-field">
        <span className="dsm-workbuddy-device-field-label">{t('sdk.valueLabel')}</span>
        <code className="dsm-workbuddy-sdk-value" aria-label={t('sdk.valueLabel')}>
          {token === undefined || token.length === 0
            ? t('sdk.noValue')
            : value ?? `${token.masked}${token.length === 0 ? '' : ` (${t('sdk.length', { count: token.length })})`}`}
        </code>
      </div>
      <div className="dsm-workbuddy-device-random-row">
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy || token === undefined || token.length === 0}
          onClick={() => { void toggle() }}
        >
          {value === undefined ? t('sdk.reveal') : t('sdk.hide')}
        </button>
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy || token === undefined || token.length === 0}
          onClick={() => { void copy() }}
        >
          {copied ? t('sdk.copied') : t('sdk.copy')}
        </button>
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy}
          onClick={() => { void load(true) }}
        >
          {busy ? t('sdk.refreshing') : t('sdk.refresh')}
        </button>
      </div>
      {error === undefined ? null : <p className="dsm-workbuddy-device-error">{error}</p>}
    </>
  )
}
