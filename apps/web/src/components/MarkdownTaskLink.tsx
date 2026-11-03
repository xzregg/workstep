import { useRef, useState, type ReactNode } from 'react'
import { useInRouterContext, useNavigate } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useTaskStore } from '../stores/taskStore'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useI18n } from '../i18n'
import type { TaskDetailLink } from '../utils/taskDetailLink'
import Button from './Button'
import './MarkdownTaskLink.css'

interface Props { target: TaskDetailLink; children: ReactNode; disabled?: boolean }

function TaskButton({ target, children, disabled }: Props) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { can } = useGatewayProjectPermissions(target.projectId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const open = async () => {
    if (pending.current || disabled || !can('task.read')) return
    pending.current = true; setLoading(true); setError('')
    try {
      // Resolve against the scoped API, rather than trusting a model-made route.
      const task = await useTaskStore.getState().refreshTask(target.taskId, target.projectId)
      const store = useProjectStore.getState()
      let project = store.projects.find(item => item.id === target.projectId)
        || (store.activeProject?.id === target.projectId ? store.activeProject : undefined)
      if (!project || (task.workflow_id && !project.workflows?.some(item => item.id === task.workflow_id))) {
        await store.fetchProjects()
        project = useProjectStore.getState().projects.find(item => item.id === target.projectId)
      }
      if (!project || task.id !== target.taskId) throw new Error(t('chatInput.taskLinkUnavailable'))
      const params = new URLSearchParams({ project: project.name, task: task.id })
      if (task.workflow_id) params.set('workflow', task.workflow_id)
      navigate(`/tasks?${params}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('chatInput.taskLinkUnavailable'))
    } finally { pending.current = false; setLoading(false) }
  }
  return <span className="markdown-task-link-container">
    <Button className="markdown-task-link chat-message-action" size="sm" loading={loading}
      disabled={disabled || !can('task.read')} onClick={() => void open()}>{children}</Button>
    {error && <span className="markdown-task-link-error" role="alert">{error}</span>}
  </span>
}

export default function MarkdownTaskLink(props: Props) {
  const inRouter = useInRouterContext()
  return inRouter ? <TaskButton {...props} /> : <span>{props.children}</span>
}
