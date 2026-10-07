/**
 * The card's account-transfer section: batch export / import of the region's
 * stored credentials, in the file format shared with sibling credential
 * managers for the same upstream.
 *
 * 参考：扫码登录小节（OAuthSignIn）的组件形态 —— 单个 section、就地管理
 *   全部状态（busy / 结果行 / 错误）、零跨组件往返。导出弹框的交互（多选
 *   账号 → 下载 JSON）与导入弹框（选文件 → 脱敏预览 → 勾选 → 导入）沿用
 *   通行实现的步骤划分；预览只含展示字段与 hasToken 布尔量，token 明文
 *   永不进入浏览器。
 *
 * 导出用 <a download> Blob：卡片运行在设置页 iframe 里，无宿主保存对话框
 *   可用；a[download] 同源下载是沙箱内最可靠的方式。
 *
 * @module dsh-connect-workbuddy/client/AccountTransfer
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { WORKBUDDY_TRANSFER_PATH, withWorkBuddyRegion } from '../status-paths.ts'
import type { WorkBuddyWebRegion, WorkBuddyTransferPreview } from '../status-paths.ts'
import type { Translate } from './searched-paths.ts'

/** Props: the region tab, the card's copy, and the accounts the Host knows. */
export interface AccountTransferProps {
  t: Translate
  region: WorkBuddyWebRegion
  /** The region's accounts (id + name), token-free, from the usage snapshot. */
  accounts: readonly { id: string, accountName: string }[]
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'exporting' }
  | { kind: 'importing' }
  | { kind: 'done', message: string }
  | { kind: 'error', message: string }

/** Build the default export file name: workbuddy-accounts-YYYY-MM-DD.json. */
function exportFileName(): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const d = new Date()
  return `workbuddy-accounts-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`
}

/** Download a JSON array as a local file (no host save dialog inside the iframe). */
function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** The section. Rendered on both sign-in states — a signed-out machine can
 * still import a file exported elsewhere; export without accounts answers
 * the error line. */
export function AccountTransfer({ t, region, accounts }: AccountTransferProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dialog, setDialog] = useState<'export' | 'import' | undefined>(undefined)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = useState<WorkBuddyTransferPreview | undefined>(undefined)
  const [importSelected, setImportSelected] = useState<ReadonlySet<number>>(new Set())
  const fileInput = useRef<HTMLInputElement | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const closeDialog = (): void => {
    setDialog(undefined)
    setSelected(new Set())
    setPreview(undefined)
    setImportSelected(new Set())
  }

  const runExport = async (): Promise<void> => {
    if (selected.size === 0) return
    setPhase({ kind: 'exporting' })
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_TRANSFER_PATH, region), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accountIds: [...selected] }),
      })
      const body = await response.json() as { accounts?: unknown, error?: string }
      if (!mounted.current) return
      if (!response.ok || !Array.isArray(body.accounts)) {
        setPhase({ kind: 'error', message: body.error ?? `HTTP ${response.status}` })
        return
      }
      downloadJson(exportFileName(), body.accounts)
      closeDialog()
      setPhase({ kind: 'done', message: t('row.transferExported', { count: body.accounts.length, fileName: exportFileName() }) })
    } catch (error: unknown) {
      if (mounted.current) {
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const readImportFile = async (file: File): Promise<void> => {
    setPhase({ kind: 'importing' })
    try {
      const text = await file.text()
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_TRANSFER_PATH, region), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text }),
      })
      const body = await response.json() as WorkBuddyTransferPreview & { error?: string }
      if (!mounted.current) return
      if (!response.ok || !Array.isArray(body.accounts)) {
        setPhase({ kind: 'error', message: body.error ?? `HTTP ${response.status}` })
        return
      }
      setPreview(body)
      setImportSelected(new Set(body.accounts.filter(entry => entry.hasToken).map(entry => entry.index)))
      setPhase({ kind: 'idle' })
    } catch (error: unknown) {
      if (mounted.current) {
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const runImport = async (): Promise<void> => {
    if (preview === undefined || importSelected.size === 0 || fileInput.current?.files?.[0] === undefined) return
    setPhase({ kind: 'importing' })
    try {
      const text = await fileInput.current.files[0].text()
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY_TRANSFER_PATH, region), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text, indexes: [...importSelected] }),
      })
      const body = await response.json() as { imported?: number, skipped?: number, error?: string }
      if (!mounted.current) return
      if (!response.ok || typeof body.imported !== 'number') {
        setPhase({ kind: 'error', message: body.error ?? `HTTP ${response.status}` })
        return
      }
      closeDialog()
      setPhase({ kind: 'done', message: t('row.transferImported', { imported: body.imported, skipped: body.skipped ?? 0 }) })
    } catch (error: unknown) {
      if (mounted.current) {
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const busy = phase.kind === 'exporting' || phase.kind === 'importing'

  return (
    <section className="dsm-workbuddy-transfer" aria-label={t('row.transferTitle')}>
      <p className="dsm-workbuddy-transfer-title">{t('row.transferTitle')}</p>
      {phase.kind === 'done'
        ? <p className="dsm-workbuddy-transfer-ok">{phase.message}</p>
        : phase.kind === 'error'
          ? <p className="dsm-workbuddy-transfer-error">{t('row.transferError', { message: phase.message })}</p>
          : <p className="dsm-workbuddy-transfer-hint">{t('row.transferHint')}</p>}
      <div className="dsm-workbuddy-transfer-actions">
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy || accounts.length === 0}
          onClick={() => { setSelected(new Set()); setDialog('export') }}
        >
          {t('row.transferExport')}
        </button>
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy}
          onClick={() => { setPreview(undefined); setImportSelected(new Set()); setDialog('import') }}
        >
          {t('row.transferImport')}
        </button>
      </div>
      {dialog === 'export'
        ? <div className="dsm-workbuddy-transfer-dialog" role="dialog" aria-label={t('row.transferExport')}>
            <p>{t('row.transferExportPick', { total: accounts.length })}</p>
            <ul className="dsm-workbuddy-transfer-list">
              {accounts.map(account => (
                <li key={account.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(account.id)}
                      onChange={event => {
                        const next = new Set(selected)
                        if (event.target.checked) next.add(account.id)
                        else next.delete(account.id)
                        setSelected(next)
                      }}
                    />
                    {' '}{account.accountName === '' ? t('row.accountUnnamed') : account.accountName}
                  </label>
                </li>
              ))}
            </ul>
            <div className="dsm-workbuddy-transfer-dialog-actions">
              <button type="button" className="dsm-btn dsm-btn-outline" onClick={closeDialog}>{t('row.transferCancel')}</button>
              <button
                type="button"
                className="dsm-btn dsm-btn-outline"
                disabled={selected.size === 0 || phase.kind === 'exporting'}
                onClick={() => { void runExport() }}
              >
                {phase.kind === 'exporting' ? t('row.transferExporting') : t('row.transferExportConfirm', { count: selected.size })}
              </button>
            </div>
          </div>
        : null}
      {dialog === 'import'
        ? <div className="dsm-workbuddy-transfer-dialog" role="dialog" aria-label={t('row.transferImport')}>
            <p>{t('row.transferImportPick')}</p>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={event => {
                const file = event.target.files?.[0]
                if (file !== undefined) void readImportFile(file)
              }}
            />
            {preview === undefined
              ? null
              : <>
                  <p>{t('row.transferPreviewTotal', { total: preview.total })}</p>
                  <ul className="dsm-workbuddy-transfer-list">
                    {preview.accounts.map(entry => (
                      <li key={entry.index}>
                        <label>
                          <input
                            type="checkbox"
                            disabled={!entry.hasToken}
                            checked={importSelected.has(entry.index)}
                            onChange={event => {
                              const next = new Set(importSelected)
                              if (event.target.checked) next.add(entry.index)
                              else next.delete(entry.index)
                              setImportSelected(next)
                            }}
                          />
                          {' '}{entry.nickname !== '' ? entry.nickname : entry.email !== '' ? entry.email : entry.uid !== '' ? entry.uid : t('row.transferEntryUnknown')}
                          {entry.hasToken ? '' : ` — ${t('row.transferNoToken')}`}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="dsm-workbuddy-transfer-dialog-actions">
                    <button type="button" className="dsm-btn dsm-btn-outline" onClick={closeDialog}>{t('row.transferCancel')}</button>
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      disabled={importSelected.size === 0 || phase.kind === 'importing'}
                      onClick={() => { void runImport() }}
                    >
                      {phase.kind === 'importing' ? t('row.transferImporting') : t('row.transferImportConfirm', { count: importSelected.size })}
                    </button>
                  </div>
                </>}
          </div>
        : null}
    </section>
  )
}
