/**
 * 一个账号的"虚拟设备参数"弹窗（设置里齿轮点开的那个）。
 *
 * ## 为什么是弹窗，而不是行内展开
 *
 * 每行已经有「测试 / 移除」两个按钮和一段探针文本，再展开两块输入框会把表格
 * 挤成表单。这里改的是"这台机器对外声称自己是谁"，属于低频但高影响的编辑，
 * 适合一个能一眼看完、且必须显式确认的面板。
 *
 * ## 为什么字段是"可清空"的
 *
 * 留空 = 按本机盐自动派生。清空某一项就恢复自动，而不是要求用户先记住原来的
 * 派生值——派生值本来就是不可逆推的 36 位十六进制，让人"填回去"是不可能的。
 *
 * ## P3 的那一行为什么现在就出现
 *
 * 真实设备 Token 的取值链（Turing Shield SDK / 文件）与档位互斥规则都还没实现，
 * 但入口要预留：用户在看到「真实值（P3）」这个选项时，需要在这个弹窗里看到
 * "它将来的位置在哪"。禁用 + 一句说明，比一个将来突然冒出来的输入框诚实。
 *
 * @module dsh-connect-workbuddy/client/DeviceProfileDialog
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { isDeviceId, randomDeviceId } from './device-profile.ts'
import type { Translate } from './searched-paths.ts'

export interface DeviceProfileDialogProps {
  t: Translate
  /** Shown in the title and the aria-label; the id itself never reaches the DOM. */
  accountName: string
  /** The values the Host currently holds; '' means "not overridden". */
  saved: { machineId: string, sessionId: string }
  saving: boolean
  /** A Host error, already localized by the caller. */
  error?: string
  onCancel: () => void
  /** Called with the two raw field values; '' means "clear this override". */
  onSave: (values: { machineId: string, sessionId: string }) => void
}

export function DeviceProfileDialog(props: DeviceProfileDialogProps): ReactElement {
  const { t, accountName, saved, saving, error, onCancel, onSave } = props
  const [machineId, setMachineId] = useState(saved.machineId)
  const [sessionId, setSessionId] = useState(saved.sessionId)
  const firstField = useRef<HTMLInputElement | null>(null)

  // Esc closes. The card lives in an iframe, so there is no browser-level dialog
  // to inherit this from — without it the only way out is the Cancel button.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  // Focus the first field on open: the dialog exists to be edited, and a form
  // that opens with focus on the page behind it makes the user click twice.
  useEffect(() => {
    firstField.current?.focus()
  }, [])

  const machineInvalid = machineId !== '' && !isDeviceId(machineId)
  const sessionInvalid = sessionId !== '' && !isDeviceId(sessionId)
  const canSave = !saving && !machineInvalid && !sessionInvalid

  const field = (
    labelKey: 'row.deviceMachineLabel' | 'row.deviceSessionLabel',
    value: string,
    onChange: (next: string) => void,
    invalid: boolean,
    ref?: typeof firstField,
  ) => (
    <label className="dsm-workbuddy-device-field">
      <span className="dsm-workbuddy-device-field-label">{t(labelKey)}</span>
      <input
        ref={ref}
        type="text"
        className={`dsm-workbuddy-device-input${invalid ? ' dsm-workbuddy-device-input-bad' : ''}`}
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={t('row.deviceFieldPlaceholder')}
        aria-invalid={invalid ? true : undefined}
        onChange={event => onChange(event.target.value.trim().toLowerCase())}
      />
      {invalid ? <span className="dsm-workbuddy-device-error">{t('row.deviceInvalid')}</span> : null}
    </label>
  )

  return (
    <div
      className="dsm-workbuddy-device-backdrop"
      role="presentation"
      // 只有点在遮罩本身才关：点在面板内部的任意位置（包括拖选文本拖到外面
      // 再松手时 target 仍是 input）不该把用户填了一半的表单丢掉。
      onClick={event => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="dsm-workbuddy-device-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('row.deviceDialogTitle', { accountName })}
      >
        <h4 className="dsm-workbuddy-device-title">{t('row.deviceDialogTitle', { accountName })}</h4>
        <p className="dsm-workbuddy-hint">{t('row.deviceDialogIntro')}</p>
        {field('row.deviceMachineLabel', machineId, setMachineId, machineInvalid, firstField)}
        {field('row.deviceSessionLabel', sessionId, setSessionId, sessionInvalid)}
        <div className="dsm-workbuddy-device-random-row">
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            // 一次填两个：它们描述的是同一台"设备"，只随机一半会让这个账号看起来
            // 像两台机器拼出来的。
            onClick={() => {
              setMachineId(randomDeviceId())
              setSessionId(randomDeviceId())
            }}
          >
            {t('row.deviceRandom')}
          </button>
          <span className="dsm-workbuddy-hint">{t('row.deviceRandomHint')}</span>
        </div>
        <div className="dsm-workbuddy-device-p3">
          <span className="dsm-workbuddy-device-p3-label">{t('row.deviceDialogP3')}</span>
          <span className="dsm-workbuddy-hint">{t('row.deviceDialogP3Hint')}</span>
        </div>
        {error === undefined ? null : <p className="dsm-workbuddy-device-error">{error}</p>}
        <div className="dsm-workbuddy-device-dialog-actions">
          <button type="button" className="dsm-btn dsm-btn-outline" onClick={onCancel} disabled={saving}>
            {t('row.deviceDialogCancel')}
          </button>
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={!canSave}
            onClick={() => onSave({ machineId, sessionId })}
          >
            {saving ? t('row.deviceDialogSaving') : t('row.deviceDialogSave')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 「真实值」档下点齿轮时看到的那一句话。
 *
 * 为什么齿轮仍然可点：一个真正 `disabled` 的按钮点不动，用户只会以为是界面坏了；
 * 这里要回答的是"为什么不让我改"——那必须有一次点击才能说出口。视觉上置灰
 * （`dsm-workbuddy-device-gear-off`）表达"现在用不了"，点击表达"原因是什么"。
 */
export function DeviceModeBlockedDialog(props: { t: Translate, onClose: () => void }): ReactElement {
  const { t, onClose } = props
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="dsm-workbuddy-device-backdrop"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="dsm-workbuddy-device-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('row.deviceModeRealBlockedTitle')}
      >
        <h4 className="dsm-workbuddy-device-title">{t('row.deviceModeRealBlockedTitle')}</h4>
        <p className="dsm-workbuddy-hint">{t('row.deviceModeRealBlocked')}</p>
        <div className="dsm-workbuddy-device-dialog-actions">
          <button type="button" className="dsm-btn dsm-btn-outline" onClick={onClose}>
            {t('row.deviceDialogCancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
