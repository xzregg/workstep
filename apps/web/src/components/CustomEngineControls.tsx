import { useState } from 'react'
import Button from './Button'
import { engineApi, type EngineInfo } from '../api/client'
import { useI18n } from '../i18n'
export default function CustomEngineControls({ engine, onChanged }: { engine: EngineInfo; onChanged: () => Promise<void> }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const run = async (action: string) => {
    setBusy(action); setMessage('')
    try {
      if (action === 'export') {
        const blob = await engineApi.customExport(engine.id)
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url; link.download = `${engine.id}.zip`; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 0)
      } else {
        const result = action === 'rollback' ? await engineApi.customRollback(engine.id)
          : await engineApi.customDisable(engine.id, !engine.disabled)
        if (result.restart_required) setMessage(t('settings.customEngineRestart'))
        await onChanged()
      }
    } catch (err) { setMessage(err instanceof Error ? err.message : t('settings.saveFailed')) }
    finally { setBusy('') }
  }
  return <div className="custom-engine-control">
    <Button variant="ghost" disabled={!!busy} loading={busy === 'export'} onClick={() => void run('export')}>{t('settings.customEngineExport')}</Button>
    <Button variant="ghost" disabled={!!busy} loading={busy === 'disable'} onClick={() => void run('disable')}>{t(engine.disabled ? 'settings.customEngineEnable' : 'settings.customEngineDisable')}</Button>
    <Button variant="ghost" disabled={!!busy} loading={busy === 'rollback'} onClick={() => void run('rollback')}>{t('settings.customEngineRollback')}</Button>
    {message && <span role="status">{message}</span>}
  </div>
}
