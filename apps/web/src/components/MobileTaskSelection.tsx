import { useMemo, useState, type ReactNode } from 'react'
import type { Task } from '../api/client'
import { useI18n } from '../i18n'
import { hasActiveTaskExecution } from '../utils/taskDisplayStatus'
import Button from './Button'
import Icon from './Icon'
import TaskCopyButton from './TaskCopyButton'
import { useTaskBulkActions, type TaskBulkActionsProps } from './useTaskBulkActions'
import './MobileTaskSelection.css'

interface Selection {
  active: boolean
  selectedIds: string[]
  disabled: boolean
  select: (taskId: string) => void
}

export default function MobileTaskSelection({ projectId, tasks, showArchived, children, ...actions }: TaskBulkActionsProps & {
  projectId?: string
  tasks: Task[]
  showArchived: boolean
  children: (selection: Selection) => ReactNode
}) {
  const { t } = useI18n()
  const [active, setActive] = useState(false)
  const actionableIds = useMemo(() => tasks.filter(task => !hasActiveTaskExecution(task)).map(task => task.id), [tasks])
  const bulk = useTaskBulkActions(actionableIds, actions)
  const [copying, setCopying] = useState(false)
  const busy = bulk.busy || copying
  const selectedTask = tasks.find(task => task.id === bulk.selectedIds[0])
  const select = (id: string) => {
    if (busy) return
    setActive(true)
    if (actionableIds.includes(id)) bulk.toggleTask(id)
  }
  return <div className="mobile-task-selection">
    {active && <div className="mobile-task-selection-header">
      <span role="status">{t('taskList.selectedTasks', { count: bulk.selectedIds.length })}</span>
      <Button variant="ghost" disabled={busy || actionableIds.length === 0} onClick={bulk.toggleAll}
        aria-label={t('taskList.selectAllTasks')} aria-pressed={bulk.allSelected}>{t('taskList.selectAll')}</Button>
      <Button data-selection-action="cancel" variant="ghost" disabled={busy} onClick={() => {
        setActive(false); bulk.setSelectedIds([]); bulk.setPendingAction(null)
      }}>{t('common.cancel')}</Button>
    </div>}
    {children({ active, selectedIds: bulk.selectedIds, disabled: busy, select })}
    {active && <div className="mobile-task-bulk-actions" role="toolbar" aria-label={t('taskList.selectTasks')}>
      {projectId && <TaskCopyButton key={selectedTask?.id || 'none'} projectId={projectId} taskId={selectedTask?.id || ''} title={selectedTask?.title || ''}
        presentation="toolbar" disabled={busy || bulk.selectedIds.length !== 1 || !selectedTask}
        onBusyChange={setCopying} />}
      {actions.canArchive && !showArchived && <Button data-task-action="archive" variant="ghost"
        disabled={actions.readOnly || busy || bulk.selectedIds.length === 0} loading={bulk.busy}
        onClick={() => { bulk.setArchiveWorkspace(true); bulk.setPendingAction('archive') }}>
        <Icon name="archive" size={16} />{t('taskList.bulkArchive')}
      </Button>}
      {actions.canDelete && <Button data-task-action="delete" variant="ghost" className="mobile-task-delete"
        disabled={busy || bulk.selectedIds.length === 0} loading={bulk.busy}
        onClick={() => bulk.setPendingAction('delete')}>
        <Icon name="trash" size={16} />{t('taskList.bulkDelete')}
      </Button>}
    </div>}
    {bulk.dialogs}
  </div>
}
