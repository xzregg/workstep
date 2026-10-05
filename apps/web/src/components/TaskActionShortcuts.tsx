import { useState } from 'react'
import { type ActionRun, type TaskQuickButton } from '../api/client'
import { useTaskActions } from './useActionRuns'
import { useI18n } from '../i18n'
import Button from './Button'
import ActionConfirmDialog from './ActionConfirmDialog'
import Icon from './Icon'
import QuickPromptButton from './QuickPromptButton'
import ChatMessageBubble from './ChatMessageBubble'
import MobileSheet from './MobileSheet'
import { formatConversationDateTime } from '../utils/datetime'

const isActive = (status: string) => ['preparing', 'running', 'stopping'].includes(status)

type State = ReturnType<typeof useTaskActions>

export function ActionConversationMessage({ message, run, onStop }: {
  message: { id: string; role: string; content: string; created_at?: string }
  run?: ActionRun
  onStop?: (runId: string) => void
}) {
  const { t, locale } = useI18n()
  const isUser = message.role === 'user'
  const statusLabel = (status: string) => ({
    preparing: t('actionShortcuts.launching'),
    running: t('actionShortcuts.running'),
    stopping: t('actionShortcuts.stopping'),
    succeeded: t('actionShortcuts.succeeded'),
    stopped: t('actionShortcuts.stopped'),
    failed: t('actionShortcuts.failed'),
    timed_out: t('actionShortcuts.timedOut'),
    interrupted: t('actionShortcuts.interrupted'),
  }[status] || t('actionShortcuts.interrupted'))
  const output = run?.output || message.content || (run && isActive(run.status) ? t('actionShortcuts.launching') : t('actionShortcuts.noOutput'))
  return <ChatMessageBubble
    role={isUser ? 'user' : 'assistant'}
    sender={isUser ? t('aiFlow.me') : t('actionShortcuts.quickButtons')}
    initials={isUser ? t('aiFlow.me').slice(0, 2) : 'A'}
    color={isUser ? 'var(--accent)' : 'var(--ai-assistant)'}
    content={isUser ? message.content : ''}
    header={isUser ? (message.created_at ? formatConversationDateTime(message.created_at, Date.now(), locale) : undefined) : run ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        {isActive(run.status) && <Icon name="loader-circle" className="git-spin" size={13} />}
        {t('actionShortcuts.runTitle', { title: run.title })} · {statusLabel(run.status)} · {run.cwd}
      </span>
      {onStop && isActive(run.status) && <Button variant="ghost" className="chat-message-action" disabled={run.status === 'stopping'} onClick={() => onStop(run.run_id)}><Icon name={run.status === 'stopping' ? 'loader-circle' : 'stop'} className={run.status === 'stopping' ? 'git-spin' : undefined} size={14} />{run.status === 'stopping' ? t('actionShortcuts.stopping') : t('actionShortcuts.stop')}</Button>}
    </div> : undefined}
  >
    {!isUser && <pre className="action-conversation-output">{output}</pre>}
    {!isUser && run?.exit_code !== null && run?.exit_code !== undefined && <small style={{ color: 'var(--muted)' }}>{t('actionShortcuts.exitCode', { code: run.exit_code })}</small>}
  </ChatMessageBubble>
}

export function TaskActionButtons({ state, onFillPrompt, onSendPrompt, compact = false }: { state: State; onFillPrompt?: (value: string) => void; onSendPrompt?: (value: string) => void; compact?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const renderButton = (button: TaskQuickButton, inSheet: boolean) => {
    const actionRunning = button.kind === 'action' && state.runs.some((run) => run.action_id === button.action_id && isActive(run.status))
    return <QuickPromptButton
      key={`${button.source}:${button.id}`}
      label={button.label}
      prompt={button.kind === 'action' ? button.id : button.prompt || ''}
      disabled={Boolean(actionRunning || (button.kind === 'action' && state.busy))}
      displayOnly={button.kind === 'display'}
      displayContent={button.content}
      onSelect={() => {
        if (inSheet) setOpen(false)
        if (button.kind === 'action') { void state.run(button); return }
        if (button.kind === 'prompt') {
          if (button.immediate_send) onSendPrompt?.(button.prompt)
          else onFillPrompt?.(button.prompt)
        }
      }}
      style={inSheet ? { justifyContent: 'flex-start', width: '100%' } : { flexShrink: 0, borderRadius: 999, whiteSpace: 'nowrap' }}
    />
  }
  return <>
    {state.buttons.length > 0 && (compact ? <>
      <button type="button" className="chat-quick-bolt" onClick={() => setOpen(true)} aria-label={t('actionShortcuts.quickButtons')}
        style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', color: 'var(--meta)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 'calc(14px * var(--font-scale))', padding: 0 }}>⚡</button>
      <MobileSheet open={open} title={t('actionShortcuts.quickButtons')} onClose={() => setOpen(false)}>
        {state.buttons.map((button) => renderButton(button, true))}
      </MobileSheet>
    </> : <div className="chat-quick-prompts" role="group" aria-label={t('actionShortcuts.quickButtons')} style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 1px 8px' }}>
      {state.buttons.map((button) => renderButton(button, false))}
    </div>)}
    {state.error && !compact && <span role="alert" style={{ color: 'var(--danger)' }}>{state.error}</span>}
    <ActionConfirmDialog
      button={state.pending} directory={state.pending?.cwd_mode || 'task'} loading={state.busy}
      onCancel={() => state.setPending(null)}
      onConfirm={(input) => { if (state.pending) void state.run(state.pending, true, input) }}
    />
  </>
}
