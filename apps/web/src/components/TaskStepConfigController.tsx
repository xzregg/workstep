import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { taskApi, type StepExecutionConfig, type StepExecutionSelection } from '../api/client'
import { useEngineRevision } from '../stores/engineAvailabilityStore'
import { initialStepConfig } from '../utils/stepConfig'
import type { ChatInputEngineConfig } from './ChatInput'
import ChatEngineHandoffDialog from './ChatEngineHandoffDialog'
import { useI18n } from '../i18n'

export interface TaskStepConfigState {
  inputConfig: ChatInputEngineConfig | null
  effectiveEngine: string
  loading: boolean
  error: string
}

interface Props {
  projectId: string
  taskId: string
  stepKey: string | null
  running: boolean
  children: (state: TaskStepConfigState) => ReactNode
}

export default function TaskStepConfigController({
  projectId,
  taskId,
  stepKey,
  running,
  children,
}: Props) {
  const { t } = useI18n()
  const engineRevision = useEngineRevision()
  const [detail, setDetail] = useState<StepExecutionConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [handoffTarget, setHandoffTarget] = useState<StepExecutionSelection | null>(null)

  // 步骤/任务切换时丢弃旧详情（引擎可用性变化时保留，避免下拉闪一下空白）。
  useEffect(() => {
    setDetail(null)
    setError('')
    setNotice('')
    setHandoffTarget(null)
  }, [projectId, taskId, stepKey])

  useEffect(() => {
    let active = true
    if (!projectId || !taskId || !stepKey) return () => { active = false }
    setLoading(true)
    taskApi.stepExecutionConfig(taskId, stepKey, projectId)
      .then((value) => { if (active) setDetail(value) })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // engineRevision：设置页改了引擎的安装/配置/测试状态后重新拉取，步骤引擎下拉即时跟随。
  }, [engineRevision, projectId, running, stepKey, taskId])

  const save = useCallback(async (
    selection: StepExecutionSelection,
    contextMode?: 'smart' | 'full' | 'none',
  ) => {
    if (!stepKey || running || !detail?.editable) return false
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const value = await taskApi.updateStepExecutionConfig(
        taskId, stepKey, projectId, selection, contextMode,
      )
      setDetail(value)
      setNotice(t('taskDetail.stepConfigSaved'))
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setSaving(false)
    }
  }, [detail?.editable, projectId, running, stepKey, t, taskId])

  const selection = detail?.resolved
  // 无可复用会话时也保留开始选择时的供应商，不能把每次保存当作新会话。
  const endpointKey = JSON.stringify([projectId, taskId, stepKey, detail?.message_count, detail?.session_engine])
  const [conversationEndpoint, setConversationEndpoint] = useState({
    key: endpointKey, providerId: '',
  })
  if (conversationEndpoint.key !== endpointKey) {
    setConversationEndpoint({
      key: endpointKey,
      providerId: detail?.session_provider ?? selection?.config.provider_id ?? '',
    })
  }
  const sourceProvider = detail?.session_provider ?? conversationEndpoint.providerId
  const stepFields = useMemo(() => detail?.available_engines.find(
    (engine) => engine.id === selection?.engine,
  )?.config?.step_fields || [], [detail?.available_engines, selection?.engine])
  const providerOptionLabel = useCallback((providerId: string) => {
    if (!providerId) return t('chatSession.providerDefaultLabel')
    const field = stepFields.find((item) => item.key === 'provider_id')
    return field?.options?.find((option) => option.value === providerId)?.label || providerId
  }, [stepFields, t])

  const inputConfig = useMemo<ChatInputEngineConfig | null>(() => {
    if (!detail || !selection || !stepKey) return null
    const disabled = running || !detail.editable || saving
    return {
      projectId,
      engines: detail.available_engines,
      engine: selection.engine,
      defaultEngine: selection.engine,
      model: selection.model,
      fastModel: '',
      thinkingEffort: (
        selection.config.model_reasoning_effort
        || selection.config.thinking_effort
        || ''
      ),
      providerId: selection.config.provider_id || '',
      allowDefault: false,
      requireCoordinator: false,
      stepFields,
      stepValues: selection.config,
      disabled,
      saving,
      error,
      notice,
      hint: t('taskDetail.stepConfigHint'),
      onEngineChange: (engine) => {
        if (!engine || engine === selection.engine) return
        const target = detail.available_engines.find((item) => item.id === engine)
        const next = {
          engine,
          model: target?.default_model || '',
          config: initialStepConfig(target?.config),
        }
        if (detail.has_history && engine !== detail.session_engine) {
          setHandoffTarget(next)
        } else {
          void save(next)
        }
      },
      onModelChange: (model) => void save({ ...selection, model }),
      onFastModelChange: () => undefined,
      onStepFieldChange: (key, value) => {
        const config = { ...selection.config }
        if (value === '') delete config[key]
        else config[key] = value
        const model = key === 'provider_id' ? '' : selection.model
        const next = { ...selection, model, config }
        // 同引擎换供应商：旧引擎会话绑定在另一个供应商端点上，先确认交接方式。
        if (
          key === 'provider_id'
          && detail.has_history
          && sourceProvider !== value
        ) {
          setHandoffTarget(next)
          return
        }
        void save(next)
      },
      onReset: () => {
        if (disabled) return
        setSaving(true)
        setError('')
        taskApi.resetStepExecutionConfig(taskId, stepKey, projectId)
          .then((value) => {
            setDetail(value)
            setNotice(t('taskDetail.stepConfigReset'))
          })
          .catch((reason) => setError(
            reason instanceof Error ? reason.message : String(reason),
          ))
          .finally(() => setSaving(false))
      },
    }
  }, [detail, error, notice, projectId, running, save, saving, selection, sourceProvider, stepFields, stepKey, t, taskId])

  return (
    <>
      {children({
        inputConfig,
        effectiveEngine: selection?.engine || '',
        loading,
        error,
      })}
      <ChatEngineHandoffDialog
        open={handoffTarget !== null}
        projectId={projectId}
        source={{
          engine: detail?.session_engine || selection?.engine || '',
          providerId: sourceProvider,
        }}
        target={{
          engine: handoffTarget?.engine || '',
          providerId: handoffTarget?.config.provider_id || '',
        }}
        sourceProviderLabel={providerOptionLabel(sourceProvider)}
        targetProviderLabel={providerOptionLabel(handoffTarget?.config.provider_id ?? '')}
        messageCount={detail?.message_count || 0}
        permissionMode=""
        loading={saving}
        error={error}
        onCancel={() => setHandoffTarget(null)}
        onConfirm={(input) => {
          if (!handoffTarget) return
          void save(handoffTarget, input.context_mode).then((saved) => {
            if (saved) setHandoffTarget(null)
          })
        }}
      />
    </>
  )
}
