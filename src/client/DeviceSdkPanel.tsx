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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { fetchDeviceSdk, refreshDeviceSdk, revealDeviceSdk } from './device-sdk.ts'
import type { DeviceSdkReport } from './device-sdk.ts'
import { fetchDeviceSettings, putDeviceEnabled, putDeviceSdk } from './device-profile.ts'
import type { WorkBuddySettingsKey } from './locales.ts'
import type { Translate } from './searched-paths.ts'

export interface DeviceSdkPanelProps {
  t: Translate
  /** Host 的路由；空字符串 = 这个版本没有这条路由，整块不渲染。 */
  path: string
  /**
   * 设备设置的读/写路由（{@link putDeviceSdk} 用它保存目录与回退开关）。
   *
   * 与 `path` 分开：SDK 路由读的是"现在能不能取到"，设置路由读写的是"应该去哪
   * 里找"。两者在老 Host 上会分别缺席，所以各自判空——一个有一个没有时，能用的
   * 那半仍然该渲染。
   */
  settingsPath: string
  /**
   * 总开关保存之后回调一次（用户意见）。
   *
   * 卡片另一头的「虚拟值 / 真实值」行也要跟着消失或出现，否则关掉之后那一排
   * 齿轮还在，用户会以为自己关的只是这一页。
   */
  onEnabledChange?: (enabled: boolean) => void
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
  const { t, path, settingsPath, onEnabledChange } = props
  const [report, setReport] = useState<DeviceSdkReport | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 完整值：只在用户点过「显示」或「复制」之后才在内存里存在。 */
  const [value, setValue] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  /**
   * 设置里的 SDK 目录与回退开关（作者意见 #1 / #2）。
   *
   * `undefined` = 还没读回来（或这个 Host 没有设置路由）。两种情况都按"不渲染编辑
   * 控件"处理：一个初值为空串的输入框看起来像"用户清空过目录"，而那与实际状态
   * （走自动发现）相反。
   */
  /**
   * 总开关（用户意见）。
   *
   * 与目录一起从设置路由读：关着的时候这一页只剩一个开关和一句说明，状态行、
   * token、目录全部不渲染——它们讲的是"开着的时候会怎样"。
   */
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined)
  const [savingEnabled, setSavingEnabled] = useState(false)
  const [sdkDir, setSdkDir] = useState<string | undefined>(undefined)
  const [fallback, setFallback] = useState<boolean | undefined>(undefined)
  const [draftDir, setDraftDir] = useState('')
  const [savingDir, setSavingDir] = useState(false)
  const [savingFallback, setSavingFallback] = useState(false)
  const [savedNote, setSavedNote] = useState(false)

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

  /**
   * 读设置。与 SDK 状态**分两次**取，理由与 `settingsPath` 分开一样：两者可以
   * 各自缺席，而合成一次请求会让"设置路由没有"顺带把 SDK 状态也变成错误。
   */
  const loadSettings = useCallback(async () => {
    if (settingsPath === '') return
    try {
      const settings = await fetchDeviceSettings(settingsPath)
      if (settings === undefined) return
      setEnabled(settings.enabled)
      setSdkDir(settings.sdkDir)
      setFallback(settings.sdkFallbackToVirtual)
      setDraftDir(settings.sdkDir)
    } catch {
      // 设置读不到不该挡住状态显示：面板的主要问题"能不能取到 token"仍然可读。
    }
  }, [settingsPath])

  /**
   * 关着就不去问 SDK 状态：那一次 GET 会让 Host 起一个 probe 子进程——一个关掉的
   * 功能还在后台起进程，正是这一次要消掉的东西。打开时这一个依赖变化会重新拉。
   */
  useEffect(() => {
    if (enabled === false) return
    void load(false)
  }, [load, enabled])
  useEffect(() => { void loadSettings() }, [loadSettings])

  /**
   * 「已加载、没取过」不该停在屏幕上。
   *
   * 启动时的后台预热要起一个子进程再等一次网络（约几百毫秒），而这一页是在用户
   * 点开标签时挂载的——两者偶尔会撞在一起，那一瞬间读到的就是 idle。这里做有限次
   * 复查（最多 5 次、每次 1.2 秒）：预热一落地，这一行自己变成"可用"，而不是要用户
   * 手动点一次「重新获取」。上限是必须的——预热真的失败时，无限轮询只是一台一直
   * 发 GET 的机器。
   */
  const idlePolls = useRef(0)
  useEffect(() => {
    if (path === '' || enabled === false) return
    if (report?.sdk.state !== 'ready' || report.token.state !== 'idle') return
    if (idlePolls.current >= 5) return
    idlePolls.current += 1
    // 静默复查：只更新快照，不动 `busy` / `value` / `error`——后台的一次 GET 不该
    // 让「重新获取」按钮闪成"取数中"，也不该把用户已经展开的完整值收起来。
    const timer = window.setTimeout(() => {
      void fetchDeviceSdk(path).then(next => {
        if (next !== undefined) setReport(next)
      }).catch(() => { /* 一次静默复查失败不打扰用户：上面那行仍然显示原因 */ })
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [path, report, enabled])

  if (path === '') return null
  // 关着的时候 `load()` 根本没跑过，`loading` 永远停在 true——照旧返回"正在询问"
  // 会让一个关掉的功能一直显示在忙。
  if (loading && enabled !== false) return <p className="dsm-workbuddy-panel-note">{t('sdk.loading')}</p>
  // Host 没有这条路由（老版本，或构建时裁掉了 native/）：给一句话，而不是一块
  // 空白面板——空白会被读成"我点坏了"。标签页本身保留，因为"这个 Host 没有 SDK"
  // 也是用户需要知道的事实。
  if (enabled !== false && report === undefined && error === undefined) {
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

  /**
   * 保存目录：写盘之后**立刻重探一次**。
   *
   * 只写不重探会让用户看见"已保存"而状态行还是旧的——那正是这条意见要消掉的
   * 迷雾（`dirSource` 让新目录下一次 `probe` 就生效，所以这里必须主动触发那一次）。
   */
  const saveDir = async (): Promise<void> => {
    if (settingsPath === '') return
    setSavingDir(true)
    setError(undefined)
    setSavedNote(false)
    try {
      const next = await putDeviceSdk(settingsPath, { sdkDir: draftDir.trim() })
      setSdkDir(next.sdkDir)
      setDraftDir(next.sdkDir)
      setSavedNote(true)
      await load(true)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSavingDir(false)
    }
  }

  const saveFallback = async (value: boolean): Promise<void> => {
    if (settingsPath === '') return
    setSavingFallback(true)
    setError(undefined)
    try {
      const next = await putDeviceSdk(settingsPath, { sdkFallbackToVirtual: value })
      setFallback(next.sdkFallbackToVirtual)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSavingFallback(false)
    }
  }

  const saveEnabled = async (next: boolean): Promise<void> => {
    if (settingsPath === '') return
    setSavingEnabled(true)
    setError(undefined)
    try {
      const saved = await putDeviceEnabled(settingsPath, next)
      setEnabled(saved.enabled)
      onEnabledChange?.(saved.enabled)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSavingEnabled(false)
    }
  }

  const sdk = report?.sdk
  const token = report?.token
  const stateKey: WorkBuddySettingsKey = sdk?.state === 'ready'
    ? (token?.state === 'ok' ? 'sdk.statusReady' : token?.state === 'stale' ? 'sdk.statusStale' : 'sdk.statusNoToken')
    : sdk?.state === 'missing' ? 'sdk.statusMissing' : sdk?.state === 'unsupported' ? 'sdk.statusUnsupported' : 'sdk.statusError'
  const stateOk = sdk?.state === 'ready' && token?.state === 'ok'
  /**
   * 本平台没有「真实值」档（macOS / Linux）。这一页在那种机器上只剩"为什么"：
   * 不加载 SDK、没有 token 可取，所以 token 区、目录输入、回退开关全部不画——
   * 一个连上了却永远拿不到 token 的面板，比一句说明更让人困惑。
   */
  const tierAbsent = sdk?.state === 'unsupported'

  /**
   * 总开关。放在这一页最前面：它是"这一页讲的东西到底存不存在"的前提，其余每一
   * 行都只在开着时才成立。设置路由缺席（老 Host）时不渲染——一个写不回去的开关
   * 比没有开关更坏。
   */
  const switchBlock = settingsPath === '' || enabled === undefined
    ? null
    : (
        <>
          <div className="dsm-workbuddy-device-random-row">
            <label className="dsm-workbuddy-sdk-switch">
              <input
                type="checkbox"
                role="switch"
                checked={enabled}
                disabled={savingEnabled}
                onChange={event => { void saveEnabled(event.target.checked) }}
              />
              <span>{t('sdk.enabledLabel')}</span>
            </label>
          </div>
          <p className="dsm-workbuddy-hint">{t('sdk.enabledHint')}</p>
        </>
      )

  if (enabled === false) {
    return (
      <>
        {switchBlock}
        <p className="dsm-workbuddy-panel-note">{t('sdk.disabledNote')}</p>
        {error === undefined ? null : <p className="dsm-workbuddy-device-error">{error}</p>}
      </>
    )
  }

  return (
    <>
      {switchBlock}
      {/* 没有真实值档的平台不能沿用上面那段说明：它描述的是"两档之间发不发"，
          而这里根本没有那一档。换成一句"这里没有它"。 */}
      <p className="dsm-workbuddy-panel-note">{t(tierAbsent ? 'sdk.hintNoTier' : 'sdk.hint')}</p>
      <div className="dsm-workbuddy-diag">
        {/* 平台是这一屏的第一件事：同一个面板在 macOS 与 Windows 上的能力不同，
            先说平台，再说状态——否则用户会拿 Windows 截图对照 mac，把"取不到
            token"当成坏了。 */}
        <Row label={t('sdk.platform')}>
          {sdk === undefined
            ? t('sdk.unknown')
            : sdk.platform === 'darwin'
              ? t('sdk.platformMac')
              : sdk.platform === 'win32'
                ? t('sdk.platformWindows')
                : t('sdk.platformOther', { platform: sdk.platform })}
        </Row>
        <Row label={t('sdk.state')}>
          <span className={`dsm-workbuddy-sdk-dot${stateOk ? ' dsm-workbuddy-sdk-dot-ok' : ''}`} aria-hidden="true" />
          {t(stateKey)}
        </Row>
        {/* 没有这一档的平台不加载 SDK：目录与运行时没有意义，画出来只会让人
            去关心一个不会被启动的东西。 */}
        {tierAbsent ? null : <>
        <Row label={t('sdk.bundle')} mono>
          {sdk === undefined || sdk.bundle === '' ? t('sdk.unknown') : `${sdk.bundle} · ${sdk.path}`}
        </Row>
        <Row label={t('sdk.runtime')} mono>
          {sdk === undefined || sdk.runtime === '' ? t('sdk.unknown') : sdk.runtime}
        </Row>
        </>}
        {tierAbsent ? null : <>
        <Row label={t('sdk.fetched')}>
          {token?.fetchedAtMs === undefined
            ? t('sdk.never')
            : `${new Date(token.fetchedAtMs).toLocaleTimeString()} (${describeAge(t, Date.now() - token.fetchedAtMs)})`}
        </Row>
        <Row label={t('sdk.tier')}>
          {report?.tier === 'real' ? t('sdk.tierReal') : t('sdk.tierVirtual')}
        </Row>
        </>}
      </div>

      {sdk !== undefined && sdk.reason !== undefined
        ? <p className="dsm-workbuddy-device-error">{sdk.reason}</p>
        : null}
      {token !== undefined && token.reason !== undefined && !tierAbsent
        ? <p className="dsm-workbuddy-device-error">{token.reason}</p>
        : null}

      {/* macOS 的平台限制（作者意见 #3「mac 上好像工作不正常」）：
          这一台机器上取不到 token 是**结构性的**，不是等待或配置能解决的问题。
          把它写成"再看看"，用户会一直重试；写清楚之后，同一行下面的
          「真实值档在这里一个头都不发」才是可预期的行为。只在 darwin 且确实
          取不到时出现——能取到的地方多一句话都是噪音。 */}
      {/* 没有这一档时上面那句已经说完了；再补一段只会把"不支持"讲两遍。 */}

      {/* 真实值块：默认一行星号。`value` 只在用户点开之后才有内容，关掉即丢弃。 */}
      {tierAbsent ? null : <>
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

      </>}

      {/* ── 设置：SDK 目录（作者意见 #1） ────────────────────────────────
          一个输入框 + 一个「保存」，而不是"猜"或"再装一遍"。发现链已经在跑
          （这一页的全部状态就是它的输出），但它只在桌面端装在标准位置时才命中；
          装在别的盘、或是另一份副本时，用户需要一条不用改环境变量的路。

          空值 = 回到自动发现，所以占位文字写清楚"留空即自动"，而不是一个空框
          让人以为必须填。 */}
      {settingsPath === '' || sdkDir === undefined || tierAbsent
        ? null
        : <>
            <div className="dsm-workbuddy-device-field">
              <span className="dsm-workbuddy-device-field-label">{t('sdk.dirLabel')}</span>
              <div className="dsm-workbuddy-sdk-dir-row">
                <input
                  type="text"
                  className="dsm-workbuddy-device-input dsm-workbuddy-sdk-dir-input"
                  value={draftDir}
                  placeholder={t('sdk.dirPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t('sdk.dirLabel')}
                  onChange={event => { setDraftDir(event.target.value); setSavedNote(false) }}
                />
                <button
                  type="button"
                  className="dsm-btn dsm-btn-outline"
                  disabled={savingDir || draftDir.trim() === sdkDir}
                  onClick={() => { void saveDir() }}
                >
                  {savingDir ? t('sdk.dirSaving') : t('sdk.dirSave')}
                </button>
                {sdkDir === '' ? null : (
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-outline"
                    disabled={savingDir}
                    onClick={() => { setDraftDir(''); void (async () => {
                      setSavingDir(true)
                      setError(undefined)
                      try {
                        const next = await putDeviceSdk(settingsPath, { sdkDir: '' })
                        setSdkDir(next.sdkDir)
                        setDraftDir('')
                        setSavedNote(true)
                        await load(true)
                      } catch (cause: unknown) {
                        setError(cause instanceof Error ? cause.message : String(cause))
                      } finally {
                        setSavingDir(false)
                      }
                    })() }}
                  >
                    {t('sdk.dirClear')}
                  </button>
                )}
              </div>
            </div>
            <p className="dsm-workbuddy-hint">
              {savedNote ? `${t('sdk.dirSaved')} ` : ''}
              {t('sdk.dirHint')}
            </p>

            <div className="dsm-workbuddy-device-random-row">
              <label className="dsm-workbuddy-sdk-switch">
                <input
                  type="checkbox"
                  checked={fallback ?? true}
                  disabled={savingFallback || fallback === undefined}
                  onChange={event => { void saveFallback(event.target.checked) }}
                />
                <span>{t('sdk.fallbackLabel')}</span>
              </label>
            </div>
            <p className="dsm-workbuddy-hint">{t('sdk.fallbackHint')}</p>
          </>}
      {error === undefined ? null : <p className="dsm-workbuddy-device-error">{error}</p>}
    </>
  )
}
