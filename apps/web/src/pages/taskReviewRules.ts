import { toMilliseconds } from "../utils/datetime"

interface ReviewConversationMessage {
  channel?: string
  role?: string
  step_key?: string
  started_at?: string | null
  review_run_id?: string | null
  engine?: string | null
  events?: Array<{ type?: string; data?: Record<string, unknown> }>
}

interface MessageReview {
  id: string
  step_key: string
  status?: string
  mode?: string
  started_at?: string | null
  reviewer_name?: string | null
  reviewer_device_name?: string | null
}

export function reviewActorLabel(review: MessageReview): string | undefined {
  const name = review.reviewer_name?.trim()
  if (!name) return undefined
  const deviceName = review.reviewer_device_name?.trim()
  return deviceName && name !== deviceName && !name.startsWith(`${deviceName} · `)
    ? `${name} · ${deviceName}` : name
}

export function resolveMessageReview<T extends MessageReview>(
  message: ReviewConversationMessage,
  reviews: readonly T[],
): T | undefined {
  if (message.channel !== 'review' && message.role !== 'review') return undefined
  const eventReviewId = message.events?.find((event) => (
    event.type === 'review_context' && event.data?.review_run_id
  ))?.data?.review_run_id
  const reviewId = String(message.review_run_id || eventReviewId || '')
  if (reviewId) return reviews.find((review) => review.id === reviewId)

  const messageStartedAt = toMilliseconds(message.started_at)
  if (messageStartedAt !== null) {
    const timestampMatch = reviews.find((review) => (
      review.step_key === message.step_key
      && toMilliseconds(review.started_at) === messageStartedAt
    ))
    if (timestampMatch) return timestampMatch
  }

  const stepReviews = reviews.filter((review) => review.step_key === message.step_key)
  return stepReviews.length === 1 ? stepReviews[0] : undefined
}

export function isMessageReviewActionable<T extends MessageReview>(
  message: ReviewConversationMessage,
  reviews: readonly T[],
  stepStatus?: string,
): boolean {
  const review = resolveMessageReview(message, reviews)
  return isReviewActionable(review, reviews, stepStatus)
}

export function isReviewActionable<T extends MessageReview>(
  review: T | undefined,
  reviews: readonly T[],
  stepStatus?: string,
): boolean {
  if (stepStatus !== 'awaiting_review') return false
  if (!review || (review.status !== 'pending' && review.status !== 'rejected')) {
    return false
  }
  const stepReviews = reviews.filter((item) => item.step_key === review.step_key)
  const latest = stepReviews.reduce<T | undefined>((current, item) => {
    if (!current) return item
    const currentTime = toMilliseconds(current.started_at) ?? Number.NEGATIVE_INFINITY
    const itemTime = toMilliseconds(item.started_at) ?? Number.NEGATIVE_INFINITY
    return itemTime > currentTime ? item : current
  }, undefined)
  return latest?.id === review.id
}

export function canCompleteStoppedReview<T extends MessageReview & {
  workflow_run_id: string
  artifact_round: number | null
  error?: string | null
}>(
  review: T | undefined,
  reviews: readonly T[],
  artifacts: readonly { step_key: string; round: number }[],
  taskStatus?: string,
  activeRunId?: string | null,
  stepStatus?: string,
): boolean {
  const stoppedManual = review?.mode === 'manual'
    && review.status === 'terminated'
  const stoppedAuto = review?.mode === 'auto'
    && review.status === 'failed' && review.error === '手动停止'
  if (!review || (!stoppedManual && !stoppedAuto)
    || !['stopped', 'paused'].includes(taskStatus || '')
    || !['cancelled', 'failed', 'pending'].includes(stepStatus || '')
    || !activeRunId
    || !review.artifact_round
    || !artifacts.some((artifact) => artifact.step_key === review.step_key
      && artifact.round === review.artifact_round)) return false
  return reviews.some((item) => item.id === review.id)
}

export function isManualReviewMessage<T extends MessageReview>(
  message: ReviewConversationMessage,
  reviews: readonly T[],
): boolean {
  if (message.channel !== 'review' && message.role !== 'review') return false
  const review = resolveMessageReview(message, reviews)
  if (review) return review.mode === 'manual'
  // 无匹配审核记录的旧数据兜底：人工审核不运行引擎，消息无引擎字段。
  return !message.engine
}

interface PendingReviewCandidate {
  id: string
  step_key: string
  status: string
  started_at?: string | null
}

interface ReviewStepState {
  step_key?: string
  status?: string
}

/**
 * 移动端审核入口只代表“当前可操作的审核”，不能被历史 pending 记录触发。
 */
export function findActionablePendingReview<T extends PendingReviewCandidate>(
  reviews: readonly T[],
  steps: readonly ReviewStepState[],
): T | undefined {
  for (const step of steps) {
    if (!step.step_key || step.status !== 'awaiting_review') continue
    const stepReviews = reviews.filter((review) => review.step_key === step.step_key)
    const latest = stepReviews.reduce<T | undefined>((current, review) => {
      if (!current) return review
      const currentTime = toMilliseconds(current.started_at) ?? Number.NEGATIVE_INFINITY
      const reviewTime = toMilliseconds(review.started_at) ?? Number.NEGATIVE_INFINITY
      return reviewTime > currentTime ? review : current
    }, undefined)
    if (latest?.status === 'pending') return latest
  }
  return undefined
}
