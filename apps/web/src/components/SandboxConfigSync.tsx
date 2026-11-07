import { useState } from 'react'
import { useI18n } from '../i18n'
import type { SandboxBridge, SandboxConfigImport, SandboxStatus } from '../utils/desktopSandbox'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'

export default function SandboxConfigSync({ bridge, status, disabled, onBusyChange, onSynced }: {
  bridge: SandboxBridge
  status: SandboxStatus
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onSynced: (status: SandboxStatus) => void
}) {
  const { t } = useI18n()
  const [selection, setSelection] = useState<{ input: SandboxConfigImport; source?: string; name?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function working(value: boolean) { setBusy(value); onBusyChange(value) }
  async function chooseOther() {
    working(true); setError('')
    try {
      if (!status.configSyncVersion || typeof bridge.chooseConfigDirectory !== 'function') throw new Error(t('sandbox.desktopRestartRequired'))
      const chosen = await bridge.chooseConfigDirectory()
      if (chosen) setSelection({ input: { source: chosen.source }, ...chosen })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { working(false) }
  }
  async function sync() {
    if (!selection || busy) return
    working(true); setError('')
    try {
      if (status.running && !status.configSyncVersion) throw new Error(t('sandbox.desktopRestartRequired'))
      onSynced(await bridge.importConfig(selection.input)); setSelection(null)
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { working(false) }
  }
  return <details className="sandbox-advanced">
    <summary>{t('sandbox.importTitle')}</summary>
    <p>{t('sandbox.importDescription')}</p>
    <div className="sandbox-actions">
      {(['codex', 'claude', 'agents'] as const).map(kind => <Button key={kind} disabled={disabled || busy} onClick={() => { setError(''); setSelection({ input: kind }) }}>{t(`sandbox.import.${kind}`)}</Button>)}
      <Button disabled={disabled || busy} onClick={() => void chooseOther()}>{t('sandbox.import.other')}</Button>
    </div>
    {!selection && error && <p className="sandbox-error" role="alert">{error}</p>}
    <ConfirmDialog open={Boolean(selection)} title={t('sandbox.importTitle')} message={t('sandbox.importConfirm')} loading={busy}
      confirmDisabled={disabled && !busy} onConfirm={() => void sync()} onCancel={() => { if (!busy) { setSelection(null); setError('') } }}>
      {selection?.source && <dl className="sandbox-sync-paths"><dt>{t('sandbox.importSource')}</dt><dd>{selection.source}</dd><dt>{t('sandbox.importTarget')}</dt><dd>{`/root/${selection.name}`}</dd></dl>}
      {error && <p className="sandbox-error" role="alert">{error}</p>}
    </ConfirmDialog>
  </details>
}
