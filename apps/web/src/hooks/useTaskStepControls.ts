import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { taskApi } from '../api/client'
import { useI18n } from '../i18n'
import { useTaskStore } from '../stores/taskStore'

interface Options {
  taskId: string
  projectId: string
  onHistoryRefresh: (messages: any[]) => void
  onError: (message: string) => void
  onFollow: () => void
}

/** Owns stop, fresh-session restart, and failed-message retry state. */
export function useTaskStepControls({ taskId, projectId, onHistoryRefresh, onError, onFollow }: Options) {
  const { t } = useI18n()
  const refreshTask = useTaskStore((state) => state.refreshTask)
  const [stoppingStepKeys, setStoppingStepKeys] = useState<string[]>([])
  const [restartingStepKeys, setRestartingStepKeys] = useState<string[]>([])
  const [retryingFailedMessageIds, setRetryingFailedMessageIds] = useState<string[]>([])
  const pending = useRef(new Set<string>())

  const begin = (kind: string, id: string, update: Dispatch<SetStateAction<string[]>>) => {
    const key = `${kind}:${id}`
    if (!taskId || !projectId || pending.current.has(key)) return false
    pending.current.add(key)
    onError('')
    update((current) => [...current, id])
    return true
  }
  const end = (kind: string, id: string, update: Dispatch<SetStateAction<string[]>>) => {
    pending.current.delete(`${kind}:${id}`)
    update((current) => current.filter((value) => value !== id))
  }

  const stopStep = async (stepKey: string) => {
    if (!begin('stop', stepKey, setStoppingStepKeys)) return
    try {
      await taskApi.cancelStep(taskId, stepKey, projectId)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      end('stop', stepKey, setStoppingStepKeys)
    }
  }

  const restartStepWithFreshSession = async (stepKey: string) => {
    if (!begin('restart', stepKey, setRestartingStepKeys)) return
    try {
      await taskApi.restartStepWithFreshSession(taskId, stepKey, projectId)
      onFollow()
      await refreshTask(taskId, projectId)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t('taskDetail.lostSessionRestartFailed'))
    } finally {
      end('restart', stepKey, setRestartingStepKeys)
    }
  }

  const retryFailedMessage = async (messageId: string) => {
    if (!begin('retry', messageId, setRetryingFailedMessageIds)) return
    try {
      await taskApi.retryFailedMessage(taskId, messageId, projectId)
      onFollow()
      await refreshTask(taskId, projectId)
      const result = await taskApi.history(taskId, projectId)
      onHistoryRefresh(result.messages || [])
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t('taskDetail.lostSessionRestartFailed'))
    } finally {
      end('retry', messageId, setRetryingFailedMessageIds)
    }
  }

  return { stoppingStepKeys, restartingStepKeys, retryingFailedMessageIds,
    stopStep, restartStepWithFreshSession, retryFailedMessage }
}
