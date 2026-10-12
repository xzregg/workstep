import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { skillApi } from '../api/client'
import { useProjectStore } from '../stores/projectStore'
import { saveDraft } from '../utils/chatDraft'
import { useI18n } from '../i18n'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import Button from './Button'
import Icon from './Icon'

export default function SkillDraftCreateButton({ onStarted }: { onStarted?: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (isGatewayRemoteBrowser()) return null
  const start = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await skillApi.onboarding()
      saveDraft(result.session_id, result.prompt)
      await useProjectStore.getState().fetchProjects()
      navigate(`/chat?${new URLSearchParams({ project: result.project_name, session: result.session_id })}`)
      onStarted?.()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <div className="skill-draft-create"><Button onClick={() => void start()} loading={busy} disabled={busy}><Icon name="sparkles" size={14} />{t('skillCenter.createDraft')}</Button>{error && <p role="alert" className="skill-draft-error">{error}</p>}</div>
}
