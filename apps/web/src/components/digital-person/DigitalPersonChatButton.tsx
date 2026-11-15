import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Project } from '../../api/client'
import { useProjectStore } from '../../stores/projectStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'

export default function DigitalPersonChatButton({ workspace, onClose, label, sidebar = false }: { workspace?: Project; onClose: () => void; label?: string; sidebar?: boolean }) {
  const { t } = useI18n(), navigate = useNavigate()
  const [opening, setOpening] = useState(false), [error, setError] = useState('')
  const active = useRef(true), busy = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const open = async () => {
    if (!workspace || busy.current) return
    busy.current = true; setOpening(true); setError('')
    try {
      if (!active.current) return
      useProjectStore.getState().setActiveProject(workspace)
      navigate('/companion')
      onClose()
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      busy.current = false
      if (active.current) setOpening(false)
    }
  }
  return <div className={`digital-person-chat-action${sidebar ? ' digital-person-sidebar-entry' : ''}`}>
    <Button variant={sidebar ? 'ghost' : 'primary'} disabled={!workspace} loading={opening} onClick={() => void open()}>
      {sidebar && !opening && <span className="digital-person-entry-avatar" aria-hidden="true"><Icon name="bot" size={16} /></span>}
      <span className={sidebar ? 'digital-person-entry-label' : undefined}>{label || t('digitalPerson.chat')}</span>
      {sidebar && <span className="digital-person-entry-arrow" aria-hidden="true"><Icon name="chevron-right" size={14} /></span>}
    </Button>
    {error && <p role="alert" className="digital-person-error">{error}</p>}
  </div>
}
