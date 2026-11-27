import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi, type ReviewRun } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useTaskReviewActions } from '../src/hooks/useTaskReviewActions'

test('review actions confirm downstream scheduling, pass comments, and refresh task state', async () => {
  const { window } = installDomEnvironment()
  const originalReviews = taskApi.reviews
  const originalDecide = taskApi.decideReview
  const requests: unknown[][] = []
  let reviewLoads = 0
  const review = { id: 'review-1', step_key: 'build' } as ReviewRun
  taskApi.reviews = async () => { reviewLoads++; return { reviews: [review] } }
  taskApi.decideReview = async (...args) => {
    requests.push(args)
    return { decision: 'set-complete', resumed: false, run_id: null }
  }
  const refreshed: string[] = []
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let actions!: ReturnType<typeof useTaskReviewActions>
  function Harness() {
    actions = useTaskReviewActions({ taskId: 'task-1', projectId: 'project-1',
      updatedAt: 'now', reviewEventSignal: '',
      fetchTasks: async () => { refreshed.push('list') },
      refreshTask: async () => { refreshed.push('task') },
      onError: (message) => { throw new Error(message) },
    })
    return <div>{actions.reviews.length}</div>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.equal(reviewLoads, 1)
    await act(async () => actions.setReviewComment('  ready  '))
    await act(async () => actions.decideReview('set-complete', review, 'build'))
    assert.equal(actions.pendingCompletion?.kind, 'review')
    assert.equal(requests.length, 0)
    await act(async () => actions.confirmCompletion(true))
    assert.deepEqual(requests[0], ['task-1', 'build', 'review-1', 'set-complete', 'project-1', 'ready', true])
    assert.deepEqual(refreshed, ['list', 'task'])
    assert.equal(actions.pendingCompletion, null)
    assert.equal(actions.reviewComment, '')
    assert.equal(reviewLoads, 2)
    await act(async () => actions.decideReview('terminate', review, 'build'))
    assert.deepEqual(requests[1], ['task-1', 'build', 'review-1', 'terminate', 'project-1', undefined, undefined])
  } finally {
    await act(async () => root.unmount())
    taskApi.reviews = originalReviews
    taskApi.decideReview = originalDecide
    container.remove()
    await window.happyDOM.close()
  }
})

test('failed execution completion waits for choice and leaves dialog open after a failed request', async () => {
  const { window } = installDomEnvironment()
  const originalReviews = taskApi.reviews
  const originalComplete = taskApi.completeFailedMessage
  taskApi.reviews = async () => ({ reviews: [] })
  const requests: unknown[][] = []
  taskApi.completeFailedMessage = async (...args) => {
    requests.push(args)
    throw new Error('server unavailable')
  }
  const errors: string[] = []
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let actions!: ReturnType<typeof useTaskReviewActions>
  function Harness() {
    actions = useTaskReviewActions({ taskId: 'task-1', projectId: 'project-1',
      updatedAt: '', reviewEventSignal: '', fetchTasks: async () => {},
      refreshTask: async () => {}, onError: (message) => errors.push(message) })
    return <div />
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => actions.requestFailedExecutionComplete('message-1', 2))
    assert.equal(actions.pendingCompletion?.kind, 'execution')
    await act(async () => actions.confirmCompletion(false))
    assert.deepEqual(requests[0], ['task-1', 'message-1', 2, false, 'project-1'])
    assert.deepEqual(errors, ['server unavailable'])
    assert.equal(actions.pendingCompletion?.kind, 'execution')
    assert.equal(actions.pending, false)
    await act(async () => actions.cancelCompletion())
    assert.equal(actions.pendingCompletion, null)
  } finally {
    await act(async () => root.unmount())
    taskApi.reviews = originalReviews
    taskApi.completeFailedMessage = originalComplete
    container.remove()
    await window.happyDOM.close()
  }
})


test('manual fallback drafts use the last automatic review body and preserve edits and clearing across refreshes', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalDecide = taskApi.decideReview
  const requests: unknown[][] = []
  taskApi.decideReview = async (...args) => { requests.push(args); throw new Error('offline') }
  const review = (id: string, mode: 'auto' | 'manual', time: number, stepRun = 'step-run') => ({
    id, mode, step_key: 'build', step_run_id: stepRun, workflow_run_id: 'run',
    status: mode === 'manual' ? 'pending' : 'rejected', started_at: `2026-11-27T00:00:0${time}Z`,
  } as ReviewRun)
  const first = review('auto-1', 'auto', 1)
  const last = review('auto-2', 'auto', 2)
  const manual = review('manual', 'manual', 3)
  const unrelated = { ...review('other', 'auto', 4), step_key: 'test' }
  const old = review('old', 'auto', 0, 'old-step-run')
  let snapshot = [manual, unrelated, first, old, last]
  const body = '**审核结果：未通过**\n## 最后一轮\n完整正文\n- 问题 → 修改建议\n'
  let historyMessages = [old, first, last, unrelated].map(item => ({
    channel: 'review', role: 'assistant', step_key: item.step_key, review_run_id: item.id,
    content: item.id === last.id ? body : item.id, started_at: item.started_at,
  }))
  let actions!: ReturnType<typeof useTaskReviewActions>
  function Harness() {
    actions = useTaskReviewActions({ taskId: 'task', projectId: 'project',
      snapshot, historyMessages, reviewEventSignal: '', fetchTasks: async () => {},
      refreshTask: async () => {}, onError: () => {} })
    return <div />
  }
  const render = async () => act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
  try {
    await render()
    assert.equal(actions.reviewComment, body)
    await act(async () => actions.setReviewComment('用户编辑'))
    snapshot = [...snapshot]
    historyMessages = historyMessages.map(message => ({ ...message }))
    await render()
    assert.equal(actions.reviewComment, '用户编辑')
    await act(async () => actions.decideReview('reject', manual, 'build'))
    assert.equal(requests[0][5], '用户编辑')
    await act(async () => actions.setReviewComment(''))
    historyMessages = historyMessages.map(message => ({ ...message, content: message.content + '\n刷新正文' }))
    await render()
    assert.equal(actions.reviewComment, '')
    await act(async () => actions.decideReview('approve', manual, 'build'))
    assert.equal(requests[1][5], undefined)
    await act(async () => actions.setReviewComment('另一步骤草稿', unrelated))
    assert.equal(actions.getReviewComment(unrelated), '另一步骤草稿')
    assert.equal(actions.getReviewComment(manual), '')
    const next = review('manual-next', 'manual', 5, 'next-step-run')
    snapshot = [next, ...snapshot]
    await render()
    assert.equal(actions.reviewComment, '')
    await act(async () => actions.setReviewComment('重新填写'))
    await render()
    await act(async () => actions.decideReview('approve', next, 'build'))
    assert.equal(requests[2][5], '重新填写')
  } finally {
    taskApi.decideReview = originalDecide
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
