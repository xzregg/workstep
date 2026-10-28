import type { Task } from '../api/task'
import { useI18n, type TKey } from '../i18n'

const REASONS: Record<string, TKey> = {
  manual_review: 'status.awaiting_review', tool_approval: 'status.tool_approval', user_input: 'status.user_input',
}

/** Parallel execution can continue while another branch needs a decision. */
export default function TaskPendingConfirmations({ task }: { task: Pick<Task, 'status' | 'pending_confirmations'> }) {
  const { t } = useI18n()
  const pending = task.pending_confirmations || []
  if (task.status !== 'running' || !pending.length) return null
  return <span className="task-pending-confirmations"
    title={pending.map((item) => `${item.step_key}: ${t(REASONS[item.reason] || 'status.waiting')}`).join('\n')}>
    {` · ${t('status.pending_confirmations', { count: pending.length })}`}
  </span>
}
