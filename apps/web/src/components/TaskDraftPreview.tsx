import type { ReactNode } from 'react'
import type { TaskDraftResult } from '../stores/taskDraftStore'
import MarkdownMessage from './MarkdownMessage'
import './TaskDraftPreview.css'

export default function TaskDraftPreview({ draft, projectId, children }: {
  draft: TaskDraftResult
  projectId: string
  children?: ReactNode
}) {
  return <section className="task-draft-preview">
    {typeof draft.title === 'string' && draft.title.trim() && <h3 className="task-draft-preview-title">{draft.title}</h3>}
    <div className="task-draft-preview-content">
      <MarkdownMessage content={draft.description} projectId={projectId} />
    </div>
    {typeof draft.scheduled_start_at === 'string' && <time className="task-draft-preview-time" dateTime={draft.scheduled_start_at}>{new Date(draft.scheduled_start_at).toLocaleString()}</time>}
    {children && <div className="task-draft-preview-actions">{children}</div>}
  </section>
}
