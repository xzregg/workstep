import { useEffect, useState } from 'react'
import type { ChatSessionHandoffInput } from '../api/client'
import { useI18n } from '../i18n'
import type { ForkContextMode } from '../utils/chatSessionFork'
import ChatHandoffOptions from './ChatHandoffOptions'
import ConfirmDialog from './ConfirmDialog'

export interface HandoffEndpoint {
  engine: string
  providerId: string
}

interface Props {
  open: boolean
  projectId: string
  source: HandoffEndpoint
  target: HandoffEndpoint
  messageCount: number
  permissionMode: string
  /** Display labels for the provider endpoints ('' provider = engine default). */
  sourceProviderLabel?: string
  targetProviderLabel?: string
  loading?: boolean
  error?: string
  onConfirm: (input: ChatSessionHandoffInput) => void
  onCancel: () => void
}

const modes: ForkContextMode[] = ['smart', 'full', 'none']

export default function ChatEngineHandoffDialog({
  open,
  projectId,
  source,
  target,
  messageCount,
  permissionMode,
  sourceProviderLabel = '',
  targetProviderLabel = '',
  loading = false,
  error = '',
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<ForkContextMode>('smart')
  const providerOnly = Boolean(
    source.engine
    && source.engine === target.engine
    && source.providerId !== target.providerId,
  )

  useEffect(() => {
    if (open) setMode('smart')
  }, [open, target.engine, target.providerId])

  const title = providerOnly
    ? t('chatSession.handoffProviderTitle')
    : t('chatSession.handoffTitle')
  const message = providerOnly
    ? t('chatSession.handoffProviderMessage', {
      engine: source.engine,
      source: sourceProviderLabel || source.providerId || t('chatSession.providerDefaultLabel'),
      target: targetProviderLabel || target.providerId || t('chatSession.providerDefaultLabel'),
    })
    : t('chatSession.handoffMessage', {
      source: source.engine,
      target: target.engine,
    })

  return (
    <ConfirmDialog
      open={open}
      title={title}
      message={message}
      confirmText={t('chatSession.handoffConfirm')}
      loading={loading}
      width={620}
      zIndex={2300}
      onCancel={onCancel}
      onConfirm={() => onConfirm({
        project_id: projectId,
        engine: target.engine,
        context_mode: mode as ChatSessionHandoffInput['context_mode'],
        provider_id: target.providerId,
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
