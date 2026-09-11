import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { taskApi, type StageExecutionConfig, type StageExecutionSelection } from '../api/client'
import { useEngineRevision } from '../stores/engineAvailabilityStore'
import { initialStageConfig } from '../utils/stageConfig'
import type { ChatInputEngineConfig } from './ChatInput'
import ChatEngineHandoffDialog from './ChatEngineHandoffDialog'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'

export interface TaskStageConfigState {
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
  children: (state: TaskStageConfigState) => ReactNode
}

export default function TaskStageConfigController({
  projectId,
  taskId,
  stepKey,
  running,
  children,
}: Props) {
  const { t } = useI18n()
  const engineRevision = useEngineRevision()
  const [detail, setDetail] = useState<StageExecutionConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [handoffTarget, setHandoffTarget] = useState<StageExecutionSelection | null>(null)
  const [fieldConfirmation, setFieldConfirmation] = useState<{
    label: string
    selection: StageExecutionSelection
  } | null>(null)

  // 阶段/任务切换时丢弃旧详情（引擎可用性变化时保留，避免下拉闪一下空白）。
  useEffect(() => {
    setDetail(null)
    setError('')
    setNotice('')
    setHandoffTarget(null)
    setFieldConfirmation(null)
  }, [projectId, taskId, stepKey])

  useEffect(() => {
    let active = true
    if (!projectId || !taskId || !stepKey) return () => { active = false }
    setLoading(true)
    taskApi.stageExecutionConfig(taskId, stepKey, projectId)
      .then((value) => { if (active) setDetail(value) })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // engineRevision：设置页改了引擎的安装/配置/测试状态后重新拉取，阶段引擎下拉即时跟随。
  }, [engineRevision, projectId, running, stepKey, taskId])

  const save = useCallback(async (
    selection: StageExecutionSelection,
    contextMode?: 'smart' | 'full' | 'none',
  ) => {
    if (!stepKey || running || !detail?.editable) return false
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const value = await taskApi.updateStageExecutionConfig(
        taskId, stepKey, projectId, selection, contextMode,
      )
      setDetail(value)
      setNotice(t('taskDetail.stageConfigSaved'))
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setSaving(false)
    }
  }, [detail?.editable, projectId, running, stepKey, t, taskId])

  const selection = detail?.resolved
  const stageFields = useMemo(() => detail?.available_engines.find(
    (engine) => engine.id === selection?.engine,
  )?.config?.stage_fields || [], [detail?.available_engines, selection?.engine])
  const providerOptionLabel = useCallback((providerId: string) => {
    if (!providerId) return t('chatSession.providerDefaultLabel')
    const field = stageFields.find((item) => item.key === 'provider_id')
    return field?.options?.find((option) => option.value === providerId)?.label || providerId
  }, [stageFields, t])

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
      providerId: selection.config.provider_id || '',
      allowDefault: false,
      requireCoordinator: false,
      stageFields,
      stageValues: selection.config,
      disabled,
      saving,
      error,
      notice,
      hint: t('taskDetail.stageConfigHint'),
      onEngineChange: (engine) => {
        if (!engine || engine === selection.engine) return
        const target = detail.available_engines.find((item) => item.id === engine)
        const next = {
          engine,
          model: target?.default_model || '',
          config: initialStageConfig(target?.config),
        }
        if (detail.has_history && engine !== detail.session_engine) {
          setHandoffTarget(next)
        } else {
          void save(next)
        }
      },
      onModelChange: (model) => void save({ ...selection, model }),
      onFastModelChange: () => undefined,
      onStageFieldChange: (key, value) => {
        const config = { ...selection.config }
        if (value === '') delete config[key]
        else config[key] = value
        const model = key === 'provider_id' ? '' : selection.model
        const next = { ...selection, model, config }
        const field = stageFields.find((item) => item.key === key)
        // 同引擎换供应商：旧引擎会话绑定在另一个供应商端点上，先确认交接方式。
        if (
          key === 'provider_id'
          && detail.has_history
          && (detail.session_provider ?? selection.config.provider_id ?? '') !== value
        ) {
          setHandoffTarget(next)
          return
        }
        if (field?.confirm_values?.includes(value)) {
          setFieldConfirmation({ label: field.label, selection: next })
        } else {
          void save(next)
        }
      },
      onReset: () => {
        if (disabled) return
        setSaving(true)
        setError('')
        taskApi.resetStageExecutionConfig(taskId, stepKey, projectId)
          .then((value) => {
            setDetail(value)
            setNotice(t('taskDetail.stageConfigReset'))
          })
          .catch((reason) => setError(
            reason instanceof Error ? reason.message : String(reason),
          ))
          .finally(() => setSaving(false))
      },
    }
  }, [detail, error, notice, projectId, running, save, saving, selection, stageFields, stepKey, t, taskId])

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
          providerId: detail?.session_provider || selection?.config.provider_id || '',
        }}
        target={{
          engine: handoffTarget?.engine || '',
          providerId: handoffTarget?.config.provider_id || '',
        }}
        sourceProviderLabel={providerOptionLabel(detail?.session_provider ?? '')}
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
      <ConfirmDialog
        open={fieldConfirmation !== null}
        title={fieldConfirmation
          ? t('engineForm.confirmTitle', { label: fieldConfirmation.label })
          : ''}
        message={fieldConfirmation
          ? t('engineForm.confirmMessage', { label: fieldConfirmation.label })
          : undefined}
        confirmText={t('engineForm.confirmSave')}
        loading={saving}
        onCancel={() => setFieldConfirmation(null)}
        onConfirm={() => {
          if (!fieldConfirmation) return
          void save(fieldConfirmation.selection).then((saved) => {
            if (saved) setFieldConfirmation(null)
          })
        }}
      />
    </>
  )
}
