import { useEffect, useState } from 'react'
import type { ChatSessionHandoffInput } from '../api/client'
import { useI18n } from '../i18n'
import type { ForkContextMode } from '../utils/chatSessionFork'
import ChatHandoffOptions from './ChatHandoffOptions'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  open: boolean
  projectId: string
  sourceEngine: string
  targetEngine: string
  messageCount: number
  permissionMode: string
  loading?: boolean
  error?: string
  onConfirm: (input: ChatSessionHandoffInput) => void
  onCancel: () => void
}

const modes: ForkContextMode[] = ['smart', 'full', 'none']

export default function ChatEngineHandoffDialog({
  open,
  projectId,
  sourceEngine,
  targetEngine,
  messageCount,
  permissionMode,
  loading = false,
  error = '',
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<ForkContextMode>('smart')

  useEffect(() => {
    if (open) setMode('smart')
  }, [open, targetEngine])

  return (
    <ConfirmDialog
      open={open}
      title={t('chatSession.handoffTitle')}
      message={t('chatSession.handoffMessage', { source: sourceEngine, target: targetEngine })}
      confirmText={t('chatSession.handoffConfirm')}
      loading={loading}
      width={620}
      onCancel={onCancel}
      onConfirm={() => onConfirm({
        project_id: projectId,
        engine: targetEngine,
        context_mode: mode as ChatSessionHandoffInput['context_mode'],
        permission_mode: permissionMode || undefined,
      })}
    >
      <div style={{ paddingTop: 18, paddingRight: 2 }}>
        <ChatHandoffOptions
          modes={modes}
          value={mode}
          messageCount={messageCount}
          disabled={loading}
          name="engine-handoff-context-mode"
          onChange={setMode}
        />
        {error && (
          <div role="alert" style={{ marginTop: 12, color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>
            {error}
          </div>
        )}
      </div>
    </ConfirmDialog>
  )
}
