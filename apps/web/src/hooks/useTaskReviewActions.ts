import { useCallback, useEffect, useRef, useState } from 'react'
import { taskApi, type ReviewRun } from '../api/client'
import type { ReviewDecisionAction } from '../components/ReviewDecisionActions'
import { useI18n } from '../i18n'
import { manualReviewInitialComment } from '../pages/taskReviewRules'

type PendingCompletion =
  | { kind: 'review'; review: ReviewRun; stepKey: string }
  | { kind: 'execution'; messageId: string; artifactRound: number }

interface Options {
  historyMessages?: Parameters<typeof manualReviewInitialComment>[2]
  snapshot?: ReviewRun[]
  taskId: string
  projectId: string
  updatedAt?: string | null
  reviewEventSignal: string
  fetchTasks: (projectId: string) => Promise<unknown>
  refreshTask: (taskId: string, projectId: string) => Promise<unknown>
  onError: (message: string) => void
}

/** Owns review decisions and failed-execution completion, including the downstream choice. */
export function useTaskReviewActions({
  taskId, projectId, updatedAt, reviewEventSignal, fetchTasks, refreshTask, onError, snapshot, historyMessages = [],
}: Options) {
  const { t } = useI18n()
  const [reviews, setReviews] = useState<ReviewRun[]>([])
  const [pending, setPending] = useState(false)
  const busyRef = useRef(false)
  const [pendingCompletion, setPendingCompletion] = useState<PendingCompletion | null>(null)
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const selectedReview = reviews[0]
  const commentKey = useCallback((review?: ReviewRun) =>
    JSON.stringify([projectId, taskId, review?.id ?? '']), [projectId, taskId])
  const commentFor = useCallback((review?: ReviewRun) => commentDrafts[commentKey(review)]
    ?? manualReviewInitialComment(review, reviews, historyMessages),
    [commentDrafts, commentKey, reviews, historyMessages])
  const reviewComment = commentFor(selectedReview)
  const setReviewComment = (value: string, review = selectedReview) => {
    setCommentDrafts((current) => ({ ...current, [commentKey(review)]: value }))
  }

  const loadReviews = useCallback(async () => {
    if (!taskId || !projectId) {
      setReviews([])
      return
    }
    try {
      const result = await taskApi.reviews(taskId, projectId)
      setReviews(result.reviews || [])
    } catch {
      setReviews([])
    }
  }, [taskId, projectId])

  useEffect(() => { if (snapshot) setReviews(snapshot); else void loadReviews() }, [loadReviews, updatedAt, reviewEventSignal, snapshot])

  const decideReview = useCallback(async (
    decision: ReviewDecisionAction, review?: ReviewRun, stepKey?: string,
    scheduleDownstream?: boolean,
  ) => {
    if (!review || !stepKey || !taskId || !projectId || busyRef.current) return
    if (decision === 'set-complete' && scheduleDownstream === undefined) {
      setPendingCompletion({ kind: 'review', review, stepKey })
      return
    }
    busyRef.current = true
    setPending(true)
    try {
      await taskApi.decideReview(taskId, stepKey, review.id, decision, projectId,
        commentFor(review).trim() || undefined, scheduleDownstream)
      setCommentDrafts((current) => ({ ...current, [commentKey(review)]: '' }))
      const [result] = await Promise.all([
        taskApi.reviews(taskId, projectId), fetchTasks(projectId), refreshTask(taskId, projectId),
      ])
      setReviews(result.reviews || [])
      setPendingCompletion(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('taskDetail.reviewActionFailed'))
    } finally {
      busyRef.current = false
      setPending(false)
    }
  }, [taskId, projectId, commentFor, commentKey, fetchTasks, refreshTask, onError, t])

  const requestFailedExecutionComplete = useCallback((messageId: string, artifactRound: number) => {
    setPendingCompletion({ kind: 'execution', messageId, artifactRound })
  }, [])

  const completeFailedExecution = useCallback(async (
    messageId: string, artifactRound: number, scheduleDownstream: boolean,
  ) => {
    if (!taskId || !projectId || busyRef.current) return
    busyRef.current = true
    setPending(true)
    try {
      await taskApi.completeFailedMessage(taskId, messageId, artifactRound, scheduleDownstream, projectId)
      await Promise.all([fetchTasks(projectId), refreshTask(taskId, projectId)])
      setPendingCompletion(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('taskDetail.reviewActionFailed'))
    } finally {
      busyRef.current = false
      setPending(false)
    }
  }, [taskId, projectId, fetchTasks, refreshTask, onError, t])

  const confirmCompletion = useCallback(async (scheduleDownstream: boolean) => {
    if (pendingCompletion?.kind === 'review') {
      await decideReview('set-complete', pendingCompletion.review,
        pendingCompletion.stepKey, scheduleDownstream)
    } else if (pendingCompletion?.kind === 'execution') {
      await completeFailedExecution(pendingCompletion.messageId,
        pendingCompletion.artifactRound, scheduleDownstream)
    }
  }, [pendingCompletion, decideReview, completeFailedExecution])

  const cancelCompletion = useCallback(() => {
    if (!busyRef.current) setPendingCompletion(null)
  }, [])

  return {
    reviews, pending, pendingCompletion, reviewComment, setReviewComment, getReviewComment: commentFor,
    decideReview, requestFailedExecutionComplete, confirmCompletion, cancelCompletion,
  }
}
