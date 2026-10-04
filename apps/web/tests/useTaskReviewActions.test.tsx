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
