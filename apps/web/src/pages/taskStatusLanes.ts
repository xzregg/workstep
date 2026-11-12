import type { TFunction } from '../i18n'
import type { TaskLane } from './taskListLane'

export function getTaskStatusLanes(t: TFunction): TaskLane[] {
  return [
    { key: 'ready', label: t('status.ready'), color: 'var(--status-ready)' },
    { key: 'running', label: t('taskList.statusLaneRunning'), color: 'var(--status-running)' },
    { key: 'waiting', label: t('status.waiting'), color: 'var(--status-paused)' },
    { key: 'interrupted', label: t('taskList.statusLaneInterrupted'), color: 'var(--status-failed)' },
    { key: 'completed', label: t('status.done'), color: 'var(--status-done)' },
  ]
}

/** Group by the aggregate task state; step details stay on the card. */
export function taskStatusLane(status: string): string {
  switch (status) {
    case 'running':
    case 'waiting':
    case 'completed': return status
    // Old paused snapshots are displayed as failures by taskDisplayStatus.
    case 'paused':
    case 'stopped':
    case 'failed': return 'interrupted'
    default: return 'ready'
  }
}
