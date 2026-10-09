import { useState } from 'react'
import { useInRouterContext, useNavigate } from 'react-router-dom'
import Button from './Button'
import { engineApi } from '../api/client'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = async () => {
    setBusy(true); setError('')
    try {
      const result = await engineApi.customOnboarding()
      saveDraft(result.session_id, t('settings.customEngineOnboardingPrompt', { workspace: result.workspace_path }))
      await useProjectStore.getState().fetchProjects()
      navigate(`/chat?${new URLSearchParams({ project: result.project_name, session: result.session_id })}`)
      onStarted?.()
    } catch (err) { setError(err instanceof Error ? err.message : t('settings.saveFailed')) }
    finally { setBusy(false) }
  }
  return <div className="custom-engine-control">
    <Button onClick={() => void start()} loading={busy} disabled={busy}>{t('settings.customEngineOnboarding')}</Button>
    {error && <span role="alert" className="engine-settings-error">{error}</span>}
  </div>
}
