import { useRef, useState } from 'react'
import { useInRouterContext, useNavigate } from 'react-router-dom'
import Button from './Button'
import { engineApi } from '../api/client'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import { useChatListStore } from '../stores/chatSessionStore'
import { saveDraft } from '../utils/chatDraft'

// Settings also renders in isolated component previews without a router.
export default function CustomEngineOnboardingButton({ onStarted }: { onStarted?: () => void }) {
  const routed = useInRouterContext()
  return routed ? <RoutedButton onStarted={onStarted} /> : <OnboardingButton onStarted={onStarted} navigate={(url) => window.location.assign(url)} />
}
function RoutedButton({ onStarted }: { onStarted?: () => void }) {
  const navigate = useNavigate()
  return <OnboardingButton onStarted={onStarted} navigate={navigate} />
}
function OnboardingButton({ onStarted, navigate }: { onStarted?: () => void; navigate: (url: string) => void }) {
  const { t } = useI18n()
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'create' | 'import' | ''>('')
  const [error, setError] = useState('')
  const start = async (file?: File) => {
    if (busy) return
    setBusy(file ? 'import' : 'create'); setError('')
    try {
      const result = file ? await engineApi.customImport(file) : await engineApi.customOnboarding()
      saveDraft(result.session_id, file ? result.prompt : t('settings.customEngineOnboardingPrompt', { workspace: result.workspace_path }))
      useChatListStore.getState().refreshSessions(result.project_id)
      await useProjectStore.getState().fetchProjects()
      navigate(`/chat?${new URLSearchParams({ project: result.project_name, session: result.session_id })}`)
      onStarted?.()
    } catch (err) { setError(err instanceof Error ? err.message : t('settings.saveFailed')) }
    finally { setBusy('') }
  }
  return <div className="custom-engine-control">
    <Button onClick={() => void start()} loading={busy === 'create'} disabled={!!busy}>{t('settings.customEngineOnboarding')}</Button>
    <Button onClick={() => fileInput.current?.click()} loading={busy === 'import'} disabled={!!busy} title={t('settings.customEngineImportHint')}>{t('settings.customEngineImport')}</Button>
    <input ref={fileInput} type="file" accept=".zip,application/zip" hidden disabled={!!busy} aria-label={t('settings.customEngineImport')} onChange={(event) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file) void start(file)
    }} />
    {error && <span role="alert" className="engine-settings-error">{error}</span>}
  </div>
}
