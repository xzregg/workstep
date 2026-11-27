import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'
import DeleteTaskConfirmation from './DeleteTaskConfirmation'
import ArchiveWorkspaceChoice from './ArchiveWorkspaceChoice'

export interface TaskBulkActionsProps {
  readOnly?: boolean
  canArchive: boolean
  canDelete: boolean
  canCleanWorkspace: boolean
  onArchiveTask: (taskId: string, deleteWorkspace?: boolean) => Promise<void>
  onDeleteTask: (taskId: string, deleteWorkspace: boolean) => Promise<void>
  onError: (message: string) => void
}

/** Shared PC/mobile selection, confirmation and execution rules. */
export function useTaskBulkActions(actionableIds: string[], {
  readOnly = false, canArchive, canDelete, canCleanWorkspace,
  onArchiveTask, onDeleteTask, onError,
}: TaskBulkActionsProps) {
  const { t } = useI18n()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [pendingAction, setPendingAction] = useState<'archive' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [archiveWorkspace, setArchiveWorkspace] = useState(true)
  useEffect(() => {
    const actionable = new Set(actionableIds)
    setSelectedIds((current) => current.filter((id) => actionable.has(id)))
  }, [actionableIds])

  const allSelected = actionableIds.length > 0 && actionableIds.every((id) => selectedIds.includes(id))
  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : actionableIds)
  }
  const toggleTask = (taskId: string) => {
    setSelectedIds((current) => current.includes(taskId)
      ? current.filter((id) => id !== taskId)
      : [...current, taskId])
  }

  const runBulkAction = async (deleteWorkspace = false) => {
    if (!pendingAction || (pendingAction === 'archive' ? (readOnly || !canArchive) : !canDelete) || selectedIds.length === 0 || busy) return
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      // Wait for every submitted request even if one fails, keeping retry locked.
      const results = await Promise.allSettled(selectedIds.map(id => pendingAction === 'archive'
        ? onArchiveTask(id, canCleanWorkspace && archiveWorkspace)
        : onDeleteTask(id, deleteWorkspace)))
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      setSelectedIds([])
      setPendingAction(null)
    } catch (error) {
      onError(t(
        pendingAction === 'archive' ? 'taskList.bulkArchiveFailed' : 'taskList.bulkDeleteFailed',
        { error: error instanceof Error ? error.message : t('common.unknownError') },
      ))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return { selectedIds, setSelectedIds, allSelected, toggleAll, toggleTask, busy, setPendingAction, setArchiveWorkspace, dialogs: <>
      <ConfirmDialog
        open={pendingAction === 'archive'}
        title={t('taskList.bulkArchiveTitle')}
        message={t('taskList.bulkArchiveMessage', { count: selectedIds.length })}
        confirmText={t('taskList.bulkArchive')}
        loading={busy}
        onConfirm={() => void runBulkAction()}
        onCancel={() => { if (!busy) setPendingAction(null) }}
      >{canCleanWorkspace && <ArchiveWorkspaceChoice checked={archiveWorkspace} disabled={busy} onChange={setArchiveWorkspace} />}</ConfirmDialog>
      <DeleteTaskConfirmation
        open={pendingAction === 'delete'}
        count={selectedIds.length}
        busy={busy}
        onConfirm={choice => void runBulkAction(choice)}
        onCancel={() => setPendingAction(null)}
      />
  </> }
}
