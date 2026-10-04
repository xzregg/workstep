import assert from "node:assert/strict"
import test from "node:test"
import { canCompleteStoppedReview, findActionablePendingReview,
  isManualReviewMessage, isMessageReviewActionable, isReviewActionable,
  resolveMessageReview, reviewActorLabel } from "../src/pages/taskReviewRules.ts"

test('terminated manual review can be completed for a stopped step with output', () => {
  const review = {
    id: 'review-2', step_key: 'build', workflow_run_id: 'run-2',
    mode: 'manual', status: 'terminated', artifact_round: 2,
  }
  const reviews = [
    { ...review, started_at: '2026-01-02' },
    { ...review, id: 'review-1', artifact_round: 1, started_at: '2026-01-01' },
  ]
  const artifacts = [{ step_key: 'build', round: 2 }]
  const eligible = (candidate = review, files = artifacts, status = 'cancelled') =>
    canCompleteStoppedReview(candidate, reviews, files, 'stopped', 'run-2', status)
  assert.equal(eligible(), true)
  assert.equal(eligible(review, [], 'cancelled'), false)
  assert.equal(eligible({ ...review, id: 'review-1', artifact_round: 1 }), false)
  assert.equal(eligible({ ...review, workflow_run_id: 'old-run' }), true)
  assert.equal(eligible(review, artifacts, 'passed'), false)
})

test('stopped automatic review with output can be marked complete, ordinary failure cannot', () => {
  const review = {
    id: 'auto-1', step_key: 'build', workflow_run_id: 'run-1',
    mode: 'auto', status: 'failed', error: '手动停止', artifact_round: 1,
  }
  const artifacts = [{ step_key: 'build', round: 1 }]
  assert.equal(canCompleteStoppedReview(
    review, [review], artifacts, 'paused', 'run-1', 'cancelled',
  ), true)
  assert.equal(canCompleteStoppedReview(
    { ...review, error: '审核引擎失败' }, [review], artifacts,
    'paused', 'run-1', 'cancelled',
  ), false)
  assert.equal(canCompleteStoppedReview(
    review, [review], [], 'paused', 'run-1', 'cancelled',
  ), false)
})

test('stopped review remains completable after an accidental rerun if its output still exists', () => {
  const stopped = {
    id: 'review-old', step_key: 'backend', workflow_run_id: 'run-old',
    mode: 'auto', status: 'failed', error: '手动停止', artifact_round: 3,
  }
  const newer = {
    ...stopped, id: 'review-new', workflow_run_id: 'run-new',
    error: 'Review agent returned invalid JSON', started_at: '2026-09-24',
  }
  assert.equal(canCompleteStoppedReview(
    stopped, [newer, stopped], [{ step_key: 'backend', round: 3 }],
    'stopped', 'run-new', 'failed',
  ), true)
  assert.equal(canCompleteStoppedReview(
    stopped, [newer, stopped], [{ step_key: 'backend', round: 3 }],
    'running', 'run-new', 'running',
  ), false)
})

test('only exposes a pending review while its step is currently awaiting review', () => {
  const reviews = [
    { id: 'old-pending', step_key: 'develop', status: 'pending', started_at: '2026-09-17T10:00:00Z' },
  ]

  assert.equal(findActionablePendingReview(reviews, [
    { step_key: 'develop', status: 'cancelled' },
  ]), undefined)
  assert.equal(findActionablePendingReview(reviews, [
    { step_key: 'develop', status: 'awaiting_review' },
  ])?.id, 'old-pending')
})

test('ignores an old pending review when a newer review attempt already finished', () => {
  const reviews = [
    { id: 'old-pending', step_key: 'develop', status: 'pending', started_at: '2026-09-17T10:00:00Z' },
    { id: 'new-passed', step_key: 'develop', status: 'passed', started_at: '2026-09-17T11:00:00Z' },
  ]

  assert.equal(findActionablePendingReview(reviews, [
    { step_key: 'develop', status: 'awaiting_review' },
  ]), undefined)
})

test('only exposes review actions while the step is awaiting that latest review', () => {
  const reviews = [
    { id: 'old-rejected', step_key: 'review', status: 'rejected', started_at: '2026-09-17T10:00:00Z' },
  ]

  assert.equal(isReviewActionable(reviews[0], reviews, 'failed'), false)
  assert.equal(isReviewActionable(reviews[0], reviews, 'awaiting_review'), true)

  const newerReviews = [
    ...reviews,
    { id: 'new-pending', step_key: 'review', status: 'pending', started_at: '2026-09-17T11:00:00Z' },
  ]
  assert.equal(isReviewActionable(reviews[0], newerReviews, 'awaiting_review'), false)
})

test('formats the person who completed a manual review', () => {
  assert.equal(reviewActorLabel({
    id: 'review-1',
    step_key: 'verify',
    reviewer_name: '张三',
    reviewer_device_name: 'MacBook',
  }), '张三 · MacBook')
  assert.equal(reviewActorLabel({
    id: 'review-2',
    step_key: 'verify',
    reviewer_name: '李四',
  }), '李四')
})

test('matches each historical review message to its own review attempt', () => {
  const reviews = [
    {
      id: 'review-pending', step_key: 'start', status: 'pending',
      started_at: '2026-08-11T08:59:03.640614+00:00',
    },
    {
      id: 'review-passed', step_key: 'start', status: 'passed',
      started_at: '2026-08-11T08:52:50.010814+00:00',
    },
    {
      id: 'review-rejected', step_key: 'start', status: 'rejected',
      started_at: '2026-08-11T08:42:39.779239+00:00',
    },
  ]

  assert.equal(resolveMessageReview({
    channel: 'review', step_key: 'start',
    started_at: '2026-08-11T08:42:39.779239+00:00',
  }, reviews)?.id, 'review-rejected')
  assert.equal(resolveMessageReview({
    channel: 'review', step_key: 'start',
    started_at: '2026-08-11T08:52:50.010814+00:00',
  }, reviews)?.id, 'review-passed')
  assert.equal(resolveMessageReview({
    channel: 'review', step_key: 'start',
    events: [{ type: 'review_context', data: { review_run_id: 'review-pending' } }],
  }, reviews)?.id, 'review-pending')

  assert.equal(isMessageReviewActionable({
    channel: 'review', step_key: 'start',
    started_at: '2026-08-11T08:42:39.779239+00:00',
  }, reviews, 'awaiting_review'), false)
  assert.equal(isMessageReviewActionable({
    channel: 'review', step_key: 'start',
    events: [{ type: 'review_context', data: { review_run_id: 'review-pending' } }],
  }, reviews, 'awaiting_review'), true)
})

test('flags manual review messages so they render without a thinking trace', () => {
  const reviews = [
    {
      id: 'review-manual', step_key: 'start', status: 'pending', mode: 'manual',
      started_at: '2026-08-11T08:59:03.640614+00:00',
    },
    {
      id: 'review-auto', step_key: 'impl', status: 'passed', mode: 'auto',
      started_at: '2026-08-11T08:52:50.010814+00:00',
    },
  ]

  assert.equal(isManualReviewMessage({
    channel: 'review', step_key: 'start',
    events: [{ type: 'review_context', data: { review_run_id: 'review-manual' } }],
  }, reviews), true)
  assert.equal(isManualReviewMessage({
    channel: 'review', step_key: 'impl',
    events: [{ type: 'review_context', data: { review_run_id: 'review-auto' } }],
  }, reviews), false)
  // 非审核消息不受影响
  assert.equal(isManualReviewMessage({
    channel: 'execution', step_key: 'start', engine: 'codex',
  }, reviews), false)
  // 旧数据没有匹配到审核记录时，按引擎缺失兜底（人工审核不跑引擎）
  assert.equal(isManualReviewMessage({
    channel: 'review', step_key: 'unknown', engine: null,
  }, reviews), true)
  assert.equal(isManualReviewMessage({
    channel: 'review', step_key: 'unknown', engine: 'codex',
  }, reviews), false)
})


test('channel reviewer source is displayed once for persisted channel identities', () => {
  for (const source of ['企业微信', '钉钉']) {
    assert.equal(reviewActorLabel({ id: 'review', step_key: 'build',
      reviewer_name: `${source} · 小陈`, reviewer_device_name: source,
    }), `${source} · 小陈`)
  }
})
