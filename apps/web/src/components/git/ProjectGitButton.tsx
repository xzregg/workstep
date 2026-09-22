import { useLocation, useNavigate } from 'react-router-dom'
import type { Project } from '../../api/client'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'

export default function ProjectGitButton({ project }: { project: Project | null }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useI18n()
  if (!project || project.type === 'remote') return null
  return <Button variant="ghost" size="sm" title={t('git.title')} style={{ padding: '4px 8px', gap: 5 }} onClick={() => navigate(`/git?project_id=${encodeURIComponent(project.id)}`, { state: { returnTo: location.pathname + location.search } })}><Icon name="git-fork" size={13} />{t('git.entry')}</Button>
}
