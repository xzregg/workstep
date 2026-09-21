import React, { useEffect, useMemo, useState } from 'react'
import type { Task } from '../api/client'
import { useI18n, type TKey } from '../i18n'
import { formatDuration, toMilliseconds } from '../utils/datetime'
import { isTaskCompleted } from '../pages/taskDetailChat'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'

interface Lane {
  key: string
  label: string
  color: string
}

interface TaskTableViewProps {
  lanes: Lane[]
  tasksByLane: Record<string, Task[]>
  showArchived: boolean
  durationNowMs: number
  onOpenTask: (taskId: string) => void
  onAddTask: (laneKey: string) => void
  onArchiveTask: (taskId: string) => Promise<void>
  onDeleteTask: (taskId: string) => Promise<void>
  onError: (message: string) => void
}

const STATUS_LABEL_KEYS: Record<string, TKey> = {
  ready: 'status.ready', running: 'status.running', paused: 'status.paused', stopped: 'status.stopped',
  queued: 'status.queued', done: 'status.done', reviewing: 'status.reviewing',
  awaiting_review: 'status.awaiting_review', retrying: 'status.retrying', rejected: 'status.rejected',
  cancelled: 'status.cancelled', rework: 'status.rework', rework_waiting: 'status.rework_waiting',
}

const STATUS_COLORS: Record<string, string> = {
  ready: 'var(--status-ready)', running: 'var(--status-running)', paused: 'var(--status-paused)',
  stopped: 'var(--status-stopped)', queued: '#a16207', done: 'var(--status-done)',
  passed: 'var(--status-done)', failed: 'var(--status-failed)', reviewing: 'var(--accent)',
  awaiting_review: 'var(--status-paused)', retrying: 'var(--warn)', rejected: 'var(--status-failed)',
  cancelled: '#d97706', rework: 'var(--warn)', rework_waiting: 'var(--warn)',
}

const TABLE_COLUMN_WIDTHS = ['5%', '35%', '14%', '13%', '15%', '18%']

function getDisplayInfo(task: Task, durationNowMs: number) {
  const status = task.status || 'ready'
  const taskCompleted = isTaskCompleted(task.steps || [])
  const stageStatus = ['reviewing', 'awaiting_review', 'retrying', 'rejected']
    .find((candidate) => (task.steps || []).some((step) => step.status === candidate))
  const displayStatus = taskCompleted ? 'done' : stageStatus || status
  const statusColor = STATUS_COLORS[displayStatus] || 'var(--status-ready)'
  const startedMs = toMilliseconds(task.first_message_at)
  const createdMs = toMilliseconds(task.created_at)
  let cardDurationMs: number | null = null
  if (status === 'running') {
    const startMs = startedMs ?? createdMs
    if (startMs !== null) cardDurationMs = Math.max(0, durationNowMs - startMs)
  } else if (task.duration_ms != null) {
    cardDurationMs = task.duration_ms
  } else if (startedMs !== null) {
    const endMs = toMilliseconds(task.updated_at) ?? durationNowMs
    cardDurationMs = Math.max(0, endMs - startedMs)
  }
  return { displayStatus, statusColor, stageStatus, cardDurationMs }
}

export default function TaskTableView({
  lanes,
  tasksByLane,
  showArchived,
  durationNowMs,
  onOpenTask,
  onAddTask,
  onArchiveTask,
  onDeleteTask,
  onError,
}: TaskTableViewProps) {
  const { t, locale } = useI18n()
  const [collapsedLanes, setCollapsedLanes] = useState<Record<string, boolean>>({})
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [pendingAction, setPendingAction] = useState<'archive' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const actionableIds = useMemo(
    () => lanes.flatMap((lane) => tasksByLane[lane.key] || [])
      .filter((task) => task.status !== 'running')
      .map((task) => task.id),
    [lanes, tasksByLane],
  )

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

  const runBulkAction = async () => {
    if (!pendingAction || selectedIds.length === 0 || busy) return
    setBusy(true)
    try {
      if (pendingAction === 'archive') {
        await Promise.all(selectedIds.map(onArchiveTask))
      } else {
        await Promise.all(selectedIds.map(onDeleteTask))
      }
      setSelectedIds([])
      setPendingAction(null)
    } catch (error) {
      onError(t(
        pendingAction === 'archive' ? 'taskList.bulkArchiveFailed' : 'taskList.bulkDeleteFailed',
        { error: error instanceof Error ? error.message : t('common.unknownError') },
      ))
    } finally {
      setBusy(false)
    }
  }

  const cellStyle: React.CSSProperties = {
    padding: '9px 14px', borderTop: '1px solid var(--border-soft)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--fg-2)',
  }

  return (
    <>
      <div style={{
        minHeight: 42, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
        padding: '6px 10px', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-md)',
        background: 'var(--surface)',
      }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--fg-2)', fontSize: 'calc(13px * var(--font-scale))' }}>
          <input
            type="checkbox"
            aria-label={t('taskList.selectAllTasks')}
            checked={allSelected}
            disabled={actionableIds.length === 0 || busy}
            onChange={() => toggleAll()}
          />
          {t('taskList.selectAll')}
        </label>
        <span style={{ color: 'var(--meta)', fontSize: 'calc(12px * var(--font-scale))' }}>
          {t('taskList.selectedTasks', { count: selectedIds.length })}
        </span>
        <span style={{ flex: 1 }} />
        {!showArchived && (
          <Button
            variant="ghost"
            disabled={selectedIds.length === 0 || busy}
            onClick={() => setPendingAction('archive')}
            style={{ gap: 5 }}
          >
            <Icon name="archive" size={13} strokeWidth={2} />
            {t('taskList.bulkArchive')}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={selectedIds.length === 0 || busy}
          onClick={() => setPendingAction('delete')}
          style={{ gap: 5, color: 'var(--danger)' }}
        >
          <Icon name="x" size={13} strokeWidth={2} />
          {t('taskList.bulkDelete')}
        </Button>
      </div>

      {lanes.map((lane) => {
        const laneTasks = tasksByLane[lane.key] || []
        const isCollapsed = !!collapsedLanes[lane.key]
        return (
          <div key={lane.key} style={{ border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-md)', marginBottom: 14, overflow: 'hidden' }}>
            <div
              role="button"
              tabIndex={0}
              title={isCollapsed ? t('taskList.expand') : t('taskList.collapse')}
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsedLanes((prev) => ({ ...prev, [lane.key]: !prev[lane.key] }))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setCollapsedLanes((prev) => ({ ...prev, [lane.key]: !prev[lane.key] }))
                }
              }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 14px', background: 'var(--surface)', borderLeft: `3px solid ${lane.color}`,
                fontFamily: 'inherit', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600,
                color: 'var(--fg)', cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: lane.color, flexShrink: 0 }} />
              {lane.label}
              <span style={{ color: 'var(--meta)', fontWeight: 400, fontSize: 'calc(12px * var(--font-scale))' }}>
                {t('taskList.taskCount', { count: laneTasks.length })}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {!showArchived && (
                  <Button
                    variant="ghost"
                    aria-label={t('taskList.addTaskToLane', { lane: lane.label })}
                    title={t('taskList.addTaskToLane', { lane: lane.label })}
                    onClick={(event) => { event.stopPropagation(); onAddTask(lane.key) }}
                    style={{ height: 24, padding: '0 7px', fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0 }}
                  >
                    {t('taskList.add')}
                  </Button>
                )}
                <span style={{ color: 'var(--meta)', fontWeight: 400, fontSize: 'calc(12px * var(--font-scale))' }}>
                  {isCollapsed ? `${t('taskList.expand')} ▾` : `${t('taskList.collapse')} ▴`}
                </span>
              </span>
            </div>
            {!isCollapsed && (laneTasks.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(13px * var(--font-scale))', tableLayout: 'fixed' }}>
                <colgroup>
                  {TABLE_COLUMN_WIDTHS.map((width, index) => <col key={index} style={{ width }} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th aria-label={t('taskList.selectTasks')} style={{ padding: '6px 14px' }} />
                    {[t('taskList.tableTask'), t('taskList.tableStatus'), t('taskList.creator'), t('taskList.duration'), t('taskList.tableUpdatedAt')].map((label) => (
                      <th key={label} style={{ position: 'sticky', top: 0, background: 'var(--bg)', textAlign: 'left', fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600, color: 'var(--meta)', padding: '6px 14px' }}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {laneTasks.map((task) => {
                    const info = getDisplayInfo(task, durationNowMs)
                    const updatedLabel = new Date(task.updated_at || task.created_at).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                    const isActionable = task.status !== 'running'
                    return (
                      <tr
                        key={task.id}
                        onClick={() => onOpenTask(task.id)}
                        onMouseEnter={(event) => { (event.currentTarget as HTMLElement).style.background = 'var(--accent-light)' }}
                        onMouseLeave={(event) => { (event.currentTarget as HTMLElement).style.background = '' }}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ ...cellStyle, paddingRight: 0 }}>
                          <input
                            type="checkbox"
                            aria-label={t('taskList.selectTask', { title: task.title })}
                            checked={selectedIds.includes(task.id)}
                            disabled={!isActionable}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleTask(task.id)}
                          />
                        </td>
                        <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--fg)' }} title={task.title}>{task.title}</td>
                        <td style={{ ...cellStyle, overflow: 'visible' }}>
                          <span className="status-badge" data-s={info.displayStatus} style={info.stageStatus ? { color: info.statusColor, background: `color-mix(in oklab, ${info.statusColor}, transparent 86%)` } : undefined}>
                            {(info.displayStatus === 'running' || info.displayStatus === 'reviewing') && <span className="task-status-spinner" aria-hidden="true" />}
                            {t(STATUS_LABEL_KEYS[info.displayStatus] ?? (info.displayStatus as TKey))}
                          </span>
                        </td>
                        <td style={cellStyle}>{task.creator_name || '—'}</td>
                        <td style={{ ...cellStyle, color: 'var(--meta)', fontVariantNumeric: 'tabular-nums' }}>
                          {info.cardDurationMs !== null && info.cardDurationMs > 0 ? formatDuration(info.cardDurationMs, t) : '—'}
                        </td>
                        <td style={{ ...cellStyle, color: 'var(--meta)', fontVariantNumeric: 'tabular-nums' }}>{updatedLabel}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <div style={{ padding: '18px 14px', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)' }}>
                {t('taskList.emptyGroup')}
              </div>
            ))}
          </div>
        )
      })}

      <ConfirmDialog
        open={pendingAction !== null}
        title={t(pendingAction === 'archive' ? 'taskList.bulkArchiveTitle' : 'taskList.bulkDeleteTitle')}
        message={t(pendingAction === 'archive' ? 'taskList.bulkArchiveMessage' : 'taskList.bulkDeleteMessage', { count: selectedIds.length })}
        confirmText={t(pendingAction === 'archive' ? 'taskList.bulkArchive' : 'taskList.bulkDelete')}
        danger={pendingAction === 'delete'}
        loading={busy}
        onConfirm={() => void runBulkAction()}
        onCancel={() => { if (!busy) setPendingAction(null) }}
      />
    </>
  )
}
