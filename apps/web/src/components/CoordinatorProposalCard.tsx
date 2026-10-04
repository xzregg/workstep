import { useState } from 'react'
import type { ActionProposal } from '../api/client'
import { taskApi } from '../api/task'
import { randomUuid } from '../utils/uuid'
import { useI18n } from '../i18n'
import Button from './Button'

export function CoordinatorProposalCard({
  proposal,
  taskId,
  projectId,
  onChanged,
}: {
  proposal: ActionProposal
  taskId: string
  projectId: string
  onChanged: (proposal: ActionProposal) => void
}) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const current = proposal
  const injectedPrompt = typeof current.payload.content === 'string'
    ? current.payload.content.trim()
    : ''
  const actionScript = current.type === 'create_workflow_action' && typeof current.payload.script_content === 'string'
    ? current.payload.script_content
    : ''
  const actionPath = actionScript
    ? `.workstep/artifacts/${current.payload.workflow_id}/actions/${current.payload.action_id}/${current.payload.script_path}`
    : ''
  const retryable = current.status === 'failed'
    && (current.type === 'rerun_from_step' || current.type === 'create_workflow_action')
  const overwriteRetry = current.status === 'failed'
    && current.type === 'create_workflow_action'
    && current.error?.includes('流程中已存在同名 Action')
  const canAct = (current.status === 'pending' || retryable) && !pending

  const confirm = async (overwrite = false) => {
    setPending(true)
    setError('')
    try {
      onChanged(
        await taskApi.confirmAction(
          taskId,
          current.id,
          projectId,
          randomUuid(),
          overwrite,
        ),
      )
    } catch (reason) {
      const fallbackError =
        reason instanceof Error
          ? reason.message
          : t('taskDetail.proposalConfirmFailed')
      try {
        const history = await taskApi.history(taskId, projectId)
        const latest = [...history.messages]
          .reverse()
          .flatMap((message) => message.proposals || [])
          .find((item) => item.id === current.id) as
          | ActionProposal
          | undefined
        if (latest && latest.status !== 'pending') {
          onChanged(latest)
          setError('')
        } else {
          setError(fallbackError)
        }
      } catch {
        setError(fallbackError)
      }
    } finally {
      setPending(false)
    }
  }

  const cancel = async () => {
    setPending(true)
    setError('')
    try {
      onChanged(await taskApi.cancelAction(taskId, current.id, projectId))
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('taskDetail.proposalCancelFailed'),
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 12,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 700 }}>
        {current.type === 'create_workflow_action'
          ? t(current.payload.overwrite === true ? 'taskDetail.proposalOverwriteActionTitle' : 'taskDetail.proposalCreateActionTitle')
          : t('taskDetail.proposalTitle', { type: current.type })}
      </div>
      <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--muted)' }}>
        {current.impact?.summary ||
          t('taskDetail.proposalTargetStep', {
            step: current.target_step_key || t('common.none'),
          })}
      </div>
      {actionScript && (
        <div style={{ border: '1px solid var(--border-soft)', borderRadius: 6, padding: 10, background: 'var(--surface)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{String(current.payload.label)} · {actionPath}</div>
          <div style={{ color: 'var(--meta)', marginBottom: 6 }}>
            {t('taskDetail.proposalActionCwd', { directory: String(current.payload.cwd_mode) })} · {t('taskDetail.proposalActionConfirmation', { value: t(current.payload.require_confirmation === false ? 'taskDetail.proposalActionNo' : 'taskDetail.proposalActionYes') })}
          </div>
          <pre style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{actionScript}</pre>
        </div>
      )}
      {injectedPrompt && (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid var(--border-soft)',
            background: 'var(--surface)',
          }}
        >
          <div
            style={{
              marginBottom: 4,
              color: 'var(--meta)',
              fontSize: 'calc(11px * var(--font-scale))',
              fontWeight: 600,
            }}
          >
            {t('taskDetail.proposalInjectedPrompt')}
          </div>
          <div
            style={{
              color: 'var(--text)',
              fontSize: 'calc(12px * var(--font-scale))',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {injectedPrompt}
          </div>
        </div>
      )}
      <div
        style={{
          fontSize: 'calc(11px * var(--font-scale))',
          color:
            current.status === 'failed' ? 'var(--danger)' : 'var(--meta)',
        }}
      >
        {t('taskDetail.proposalStatus', { status: current.status })}
        {current.error ? ` · ${current.error}` : ''}
      </div>
      {error && (
        <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--danger)' }}>{error}</div>
      )}
      {(current.status === 'pending' || retryable) && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="primary"
            disabled={!canAct}
            loading={pending}
            onClick={() => void confirm(Boolean(overwriteRetry))}
          >
            {overwriteRetry ? t('taskDetail.proposalOverwriteRetry') : retryable ? t('common.retry') : t('common.confirm')}
          </Button>
          {current.status === 'pending' && (
            <Button
              variant="ghost"
              disabled={!canAct}
              onClick={() => void cancel()}
            >
              {t('common.cancel')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
