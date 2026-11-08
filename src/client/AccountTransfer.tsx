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
import { WORKBUDDY_TRANSFER_PATH, withWorkBuddyRouteAction } from '../status-paths.ts'
import type { WorkBuddyWebRegion, WorkBuddyTransferPreview } from '../status-paths.ts'
import type { Translate } from './searched-paths.ts'
import { BusyOverlay } from './BusyOverlay.tsx'
import { settlesWithin } from './OAuthSignIn.tsx'

/** Props: the region tab, the card's copy, and the accounts the Host knows. */
export interface AccountTransferProps {
  t: Translate
  region: WorkBuddyWebRegion
  /** The region's accounts (id + name), token-free, from the usage snapshot. */
  accounts: readonly { id: string, accountName: string }[]
  /**
   * Called after an import actually added something, so the CARD can re-read
   * its snapshot.
   *
   * Without this the import was invisible: the freshly written vault entry
   * only reaches the account table on the card's next usage poll — and when
   * the region had NO account before the import, that poll is not even
   * running (it starts only once a region is signed in), so the new account
   * appeared only after the settings page was closed and reopened. That is
   * the exact "imported but still not listed" the veil below now narrates.
   *
   * Resolves when the re-read has landed; the veil stays up until it does,
   * which is what turns the old silent gap into a visible step — but only up to
   * {@link REFRESH_SETTLE_TIMEOUT_MS}, because a re-read that never settles
   * must not be able to hold the veil forever (issue #51).
   */
  onChanged?: () => void | Promise<unknown>
}

/**
 * How long the veil may wait on the card's re-read before it comes down.
 *
 * Same ceiling and same reasoning as the sign-in path's
 * `SYNC_SETTLE_TIMEOUT_MS` (issue #51): the veil is the only feedback this
 * operation gives, so its exit condition must not be a promise that can stay
 * pending. The `refreshing` phase has no other way out — no deadline, no
 * failure branch — so an unsettled re-read left the operator staring at
 * 「正在导入…」 over an import that had already succeeded.
 */
const REFRESH_SETTLE_TIMEOUT_MS = 5_000

type Phase =
  | { kind: 'idle' }
  | { kind: 'exporting' }
  | { kind: 'importing' }
  /** The write landed; the list re-read is still in flight. */
  | { kind: 'refreshing', message: string }
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
export function AccountTransfer({ t, region, accounts, onChanged }: AccountTransferProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dialog, setDialog] = useState<'export' | 'import' | undefined>(undefined)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = useState<WorkBuddyTransferPreview | undefined>(undefined)
  const [importSelected, setImportSelected] = useState<ReadonlySet<number>>(new Set())
  const fileInput = useRef<HTMLInputElement | null>(null)
  /**
   * The text of the file the user just picked.
   *
   * Held here rather than re-read from the input at import time: the picker
   * is a bare system dialog that closes immediately (see the import button),
   * so between preview and confirm there is no dialog on screen holding the
   * File. Re-reading `fileInput.current.files` would also break the moment
   * anything clears the input — and it must be cleared after every pick, or
   * choosing the SAME file twice fires no change event.
   */
  const importText = useRef('')
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
      const response = await fetch(withWorkBuddyRouteAction(WORKBUDDY_TRANSFER_PATH, region, 'export'), {
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

  /**
   * Turn a transport-level failure into something a person can act on.
   *
   * `fetch()` rejects with a bare `TypeError: Failed to fetch` whenever no HTTP
   * response arrives at all — the connection was reset, or the text could not be
   * posted. Rendered verbatim that reads like a bug in the plugin (issue #229:
   * the user saw "传输失败：Failed to fetch" and had nothing to go on). The two
   * causes worth naming are a file too large to upload and a local service that
   * is not answering; anything else keeps its own message, which is more
   * informative than a generic one.
   *
   * Note this is the CLIENT's guess: the server now answers 413 for an oversized
   * body, so a size problem usually arrives as a normal error response and never
   * reaches here. This path is what is left when the request dies before an
   * answer — which is also what a half-open local port looks like.
   */
  const transportMessage = (error: unknown, text: string): string => {
    if (!(error instanceof TypeError)) return error instanceof Error ? error.message : String(error)
    const kilobytes = Math.round(new Blob([text]).size / 1024)
    // One message naming BOTH plausible causes and the file's own size: the
    // client cannot tell a reset connection from a service that is not up, and
    // guessing between them would be worse than naming both.
    return t('row.transferNoService', { size: String(kilobytes) })
  }

  const readImportFile = async (file: File): Promise<void> => {
    setPhase({ kind: 'importing' })
    try {
      const text = await file.text()
      importText.current = text
      const response = await fetch(withWorkBuddyRouteAction(WORKBUDDY_TRANSFER_PATH, region, 'preview'), {
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
      if (mounted.current) setPhase({ kind: 'error', message: transportMessage(error, importText.current) })
    }
  }

  const runImport = async (): Promise<void> => {
    if (preview === undefined || importSelected.size === 0 || importText.current === '') return
    setPhase({ kind: 'importing' })
    try {
      const text = importText.current
      const response = await fetch(withWorkBuddyRouteAction(WORKBUDDY_TRANSFER_PATH, region, 'import'), {
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
      const message = t('row.transferImported', { imported: body.imported, skipped: body.skipped ?? 0 })
      // Hold the veil across the re-read, not just across the write. The write
      // is the fast half; the account table is what the user is looking at, and
      // it only changes once the fresh snapshot lands.
      setPhase({ kind: 'refreshing', message })
      // Bounded, exactly as the sign-in path is (see REFRESH_SETTLE_TIMEOUT_MS):
      // both veils wait on the same card re-read, so both need the same ceiling.
      await settlesWithin(Promise.resolve(onChanged?.()), REFRESH_SETTLE_TIMEOUT_MS)
      if (!mounted.current) return
      setPhase({ kind: 'done', message })
    } catch (error: unknown) {
      if (mounted.current) {
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const busy = phase.kind === 'exporting' || phase.kind === 'importing' || phase.kind === 'refreshing'
  /** The veil's scenario line: what is happening, in the user's terms. */
  const veilMessage = phase.kind === 'exporting'
    ? t('row.transferExporting')
    : phase.kind === 'importing' || phase.kind === 'refreshing'
      ? t('row.transferImporting')
      : ''

  return (
    // No visible caption: the two buttons are named 「导出账号」/「导入账号」, so a
    // heading reading 「导出 / 导入账号」 above them was the same sentence twice.
    // The title survives as the section's accessible name only.
    <section className="dsm-workbuddy-bar" aria-label={t('row.transferTitle')}>
      {/* The hint is passed only when there IS a veil: `exactOptionalPropertyTypes`
          treats an explicit `undefined` as a different type from an absent prop. */}
      <BusyOverlay visible={busy} message={veilMessage} {...busy ? { hint: t('row.veilHintList') } : {}} />
      {phase.kind === 'done'
        ? <p className="dsm-workbuddy-bar-status dsm-workbuddy-bar-ok">{phase.message}</p>
        : phase.kind === 'error'
          ? <p className="dsm-workbuddy-bar-status dsm-workbuddy-bar-error">{t('row.transferError', { message: phase.message })}</p>
          : null}
      <div className="dsm-workbuddy-bar-actions">
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy || accounts.length === 0}
          onClick={() => { setSelected(new Set()); setDialog('export') }}
        >
          {t('row.transferExport')}
        </button>
        {/*
          The import button opens the SYSTEM file picker directly. It used to
          open a one-line dialog first ("choose a JSON file exported by this
          plugin or a sibling tool") whose only content was that sentence and
          a file input — one click of ceremony in front of a dialog the OS is
          about to show anyway. The preview dialog still appears, with the
          parsed entries to confirm, which is the step that actually needs
          the user's attention.
        */}
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={busy}
          onClick={() => { fileInput.current?.click() }}
        >
          {t('row.transferImport')}
        </button>
      </div>
      {/* The picker's input is mounted with the section, not inside the preview
          dialog: the button must be able to open it before any dialog exists,
          and `value=""` after every pick lets the same file be chosen twice. */}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="dsm-workbuddy-transfer-file"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) {
            setPreview(undefined)
            setImportSelected(new Set())
            setDialog('import')
            void readImportFile(file)
          }
        }}
      />
      {dialog === 'export'
        ? <div className="dsm-workbuddy-transfer-dialog" role="dialog" aria-label={t('row.transferExport')}>
            <p>{t('row.transferExportPick', { total: accounts.length })}</p>
            {/* The privacy note lives here rather than on the resting bar: it
                matters at the moment credentials leave the machine, and on the
                bar it would cost a third of a line to repeat forever. */}
            <p className="dsm-workbuddy-hint">{t('row.transferHint')}</p>
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
            {/* Only the CONFIRMATION lives here: the file was already chosen
                (the system picker opened straight from the button), so this
                dialog shows what was found and which entries will be written.
                While the preview is in flight it says so instead of showing an
                empty box. */}
            {preview === undefined
              ? <p>{t('row.transferPreviewing')}</p>
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
