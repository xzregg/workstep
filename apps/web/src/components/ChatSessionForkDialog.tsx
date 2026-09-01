import { useEffect, useMemo, useState } from 'react'
import type {
  ChatSessionForkInput,
  CoordinatorEngineSummary,
  ProviderInfo,
} from '../api/client'
import { useI18n } from '../i18n'
import { resolveForkContextMode, type ForkContextMode } from '../utils/chatSessionFork'
import ChatHandoffOptions from './ChatHandoffOptions'
import ConfirmDialog from './ConfirmDialog'
import CoordinatorConfigBar from './CoordinatorConfigBar'
import Input from './Input'


interface Props {
  open: boolean
  projectId: string
  sourceTitle: string
  sourceEngine: string
  sourceModel: string
  sourceFastModel: string
  sourceVisionModel: string
  sourceProviderId: string
  permissionMode: string
  messageCount: number
  forkMessageId?: string | null
  forkAtTail?: boolean
  engines: CoordinatorEngineSummary[]
  providers: ProviderInfo[]
  defaultEngine: string
  initialTargetEngine?: string
  loading?: boolean
  error?: string
  onConfirm: (input: ChatSessionForkInput) => void
  onCancel: () => void
}

const modeOrder: ForkContextMode[] = ['native', 'smart', 'full', 'none']

export default function ChatSessionForkDialog({
  open,
  projectId,
  sourceTitle,
  sourceEngine,
  sourceModel,
  sourceFastModel,
  sourceVisionModel,
  sourceProviderId,
  permissionMode,
  messageCount,
  forkMessageId,
  forkAtTail = true,
  engines,
  providers,
  defaultEngine,
  initialTargetEngine,
  loading = false,
  error = '',
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [engine, setEngine] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [fastModel, setFastModel] = useState('')
  const [visionModel, setVisionModel] = useState('')
  const [mode, setMode] = useState<ForkContextMode>('smart')

  const effectiveEngine = engine || defaultEngine
  const engineInfo = engines.find((item) => item.id === effectiveEngine)
  const nativeAvailable = (
    forkAtTail
    && effectiveEngine === sourceEngine
    && Boolean(engineInfo?.supports_session_fork)
  )

  useEffect(() => {
    if (!open) return
    const targetEngine = initialTargetEngine || sourceEngine
    const target = engines.find((item) => item.id === targetEngine)
    setTitle(t('chatSession.forkDefaultTitle', { title: sourceTitle }))
    setEngine(targetEngine)
    setProviderId(targetEngine === sourceEngine ? sourceProviderId : '')
    setModel(targetEngine === sourceEngine ? sourceModel : '')
    setFastModel(targetEngine === sourceEngine ? sourceFastModel : '')
    setVisionModel(targetEngine === sourceEngine ? sourceVisionModel : '')
    setMode(resolveForkContextMode(
      sourceEngine,
      targetEngine,
      Boolean(target?.supports_session_fork),
      forkAtTail,
    ))
  }, [open, initialTargetEngine, sourceEngine, sourceTitle, sourceProviderId, sourceModel, sourceFastModel, sourceVisionModel, engines, forkAtTail, t])

  const availableModes = useMemo(
    () => modeOrder.filter((item) => item !== 'native' || nativeAvailable),
    [nativeAvailable],
  )

  const changeEngine = (nextEngine: string) => {
    const targetEngine = nextEngine || defaultEngine
    const target = engines.find((item) => item.id === targetEngine)
    setEngine(nextEngine)
    setProviderId('')
    setModel('')
    setFastModel('')
    setVisionModel('')
    setMode(resolveForkContextMode(
      sourceEngine,
      targetEngine,
      Boolean(target?.supports_session_fork),
      forkAtTail,
    ))
  }

  return (
    <ConfirmDialog
      open={open}
      title={t('chatSession.forkTitle')}
      message={t('chatSession.forkMessage')}
      confirmText={t('chatSession.forkConfirm')}
      loading={loading}
      confirmDisabled={!title.trim() || !effectiveEngine}
      width={620}
      onCancel={onCancel}
      onConfirm={() => onConfirm({
        project_id: projectId,
        title: title.trim(),
        engine: effectiveEngine,
        context_mode: mode,
        provider_id: providerId || undefined,
        model: model || undefined,
        fast_model: fastModel || undefined,
        vision_model: visionModel || undefined,
        permission_mode: permissionMode || undefined,
        fork_message_id: forkMessageId || undefined,
      })}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 18, paddingRight: 2 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span className="field-label">{t('chatSession.forkName')}</span>
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('chatSession.renamePlaceholder')}
          />
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span className="field-label">{t('chatSession.forkTarget')}</span>
          <div style={{ padding: '8px 10px', border: '1px solid var(--border-soft)', borderRadius: 12, background: 'var(--bg-soft)' }}>
            <CoordinatorConfigBar
              variant="menu"
              projectId={projectId}
              engines={engines}
              engine={engine}
              defaultEngine={defaultEngine}
              providers={providers}
              providerId={providerId}
              model={model}
              fastModel={fastModel}
              visionModel={visionModel}
              showVision
              disabled={loading}
              onEngineChange={changeEngine}
              onProviderChange={(value) => {
                setProviderId(value)
                setModel('')
                setFastModel('')
                setVisionModel('')
              }}
              onModelChange={setModel}
              onFastModelChange={setFastModel}
              onVisionModelChange={setVisionModel}
            />
          </div>
        </div>

        <ChatHandoffOptions
          modes={availableModes}
          value={mode}
          messageCount={messageCount}
          disabled={loading}
          name="fork-context-mode"
          onChange={setMode}
        />

        {error && (
          <div role="alert" style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>
            {error}
          </div>
        )}
      </div>
    </ConfirmDialog>
  )
}
