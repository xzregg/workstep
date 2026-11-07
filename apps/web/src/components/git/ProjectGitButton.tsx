import { useState } from 'react'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import GitWorkspaceWindow from './GitWorkspaceWindow'
import './git.css'
import { useLocation, useNavigate } from 'react-router-dom'
import type { Project } from '../../api/client'
import { useI18n } from '../../i18n'
import Button from '../Button'
import { useGatewayProjectPermissions } from '../../hooks/useGatewayProjectPermissions'
import Icon from '../Icon'

export default function ProjectGitButton({ project }: { project: Project | null }) {
  const [open, setOpen] = useState(false)
  const compact = useCompactLayout()
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useI18n()
  const { can } = useGatewayProjectPermissions(project?.id)
  if (!can('git.read')) return null
  if (!project) return null
  return <><Button variant="ghost" size="sm" title={t('git.title')} className="project-git-button" onClick={() => compact ? navigate(`/git?project_id=${encodeURIComponent(project.id)}`, { state: { returnTo: location.pathname + location.search + location.hash } }) : setOpen(true)}><Icon name="git-fork" size={13} />{t('git.entry')}</Button>{open && <GitWorkspaceWindow key={project.id} projectId={project.id} onClose={() => setOpen(false)} />}</>
}
