import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findActiveStepIndex,
  findActionablePendingReview,
  findLatestDispatchedTask,
  resolveStepRestartImpact,
  resolveStepDisplayStatus,
  isStepActiveForStop,
  mergeHistoryMessageWithLive,
  canRetryFailedExecutionMessage,
  canRestartStoppedExecutionMessage,
  latestMessageIdsByStep,
  latestExecutionMessageIdsByStep,
  failedExecutionCompletionRound,
  canCompleteStoppedReview,
  runningTaskMessageIds,
} from '../src/pages/taskDetailChat.ts'
import { artifactsForMessage, artifactsForStepRoundOutputs, findPreferredArtifact,
  findStepRoundInputArtifact, findStepRoundInputPort, groupStepOutputsByInput,
  downstreamInputsForOutput, hasStepIoContractChanged } from '../src/pages/taskArtifactRules.ts'
import { loadTaskHistoryWithRetry, mergeLoadedTaskMessageEvents,
  mergeRefreshedTaskHistory } from '../src/pages/taskHistoryModel.ts'

test('persisted coordinator stop clears stale live running state', () => {
  const history = [{ id: 'assistant-1', channel: 'coordinator', role: 'assistant', run_status: 'stopped' }]
  const live = { 'assistant-1': { id: 'assistant-1', channel: 'coordinator', role: 'assistant', status: 'running' } }

  assert.equal(runningTaskMessageIds(history, live, null).coordinator, undefined)
  assert.equal(runningTaskMessageIds(history, live, null).execution, undefined)
})

test('newer live completion clears a persisted running coordinator turn', () => {
  const history = [{ id: 'assistant-1', channel: 'coordinator', role: 'assistant', run_status: 'running' }]
  const live = { 'assistant-1': { id: 'assistant-1', channel: 'coordinator', role: 'assistant', status: 'failed' } }

  assert.equal(runningTaskMessageIds(history, live, null).coordinator, undefined)
})

test('retries a failed history request until the execution message is loaded', async () => {
  let attempts = 0
  const response = await loadTaskHistoryWithRetry(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('Failed to fetch')
    return { messages: [{ id: 'frontend-execution', sequence: 27 }] }
  }, new AbortController().signal, 0)

  assert.equal(attempts, 2)
  assert.deepEqual(response?.messages.map((message) => message.id), ['frontend-execution'])
})

test('stops retrying history when task detail closes', async () => {
  const controller = new AbortController()
  let attempts = 0
  const response = await loadTaskHistoryWithRetry(async () => {
    attempts += 1
    controller.abort()
    throw new Error('Failed to fetch')
  }, controller.signal, 0)

  assert.equal(response, undefined)
  assert.equal(attempts, 1)
})

test('only the final execution message with a step error can restart in place', () => {
  const failed = { id: 'failed', role: 'assistant', channel: 'execution', run_status: 'failed' }
  assert.equal(canRetryFailedExecutionMessage(failed, 'failed', 'failed', 'network error'), true)
  assert.equal(canRetryFailedExecutionMessage(failed, 'later-user', 'failed', 'network error'), false)
  assert.equal(canRetryFailedExecutionMessage(failed, 'failed', 'failed', ''), false)
  assert.equal(canRetryFailedExecutionMessage(failed, 'failed', 'passed', 'network error'), false)
})

test('a later message from another step does not hide restart on a failed step', () => {
  const latest = latestMessageIdsByStep([
    { id: 'ui-failure', step_key: 'ui' },
    { id: 'backend-failure', step_key: 'backend' },
  ])
  assert.equal(latest.get('ui'), 'ui-failure')
  assert.equal(canRetryFailedExecutionMessage(
    { id: 'ui-failure', role: 'assistant', channel: 'execution', run_status: 'failed' },
    latest.get('ui'), 'failed', '429 Too Many Requests',
  ), true)
})

test('a failed step offers completion using its existing output round', () => {
  const message = {
    id: 'ui-failure', role: 'assistant', channel: 'execution',
    run_status: 'failed', step_key: 'ui', artifact_round: 3,
  }
  const artifacts = [{ step_key: 'ui', round: 2 }, { step_key: 'ui', round: 3 }]
  assert.equal(failedExecutionCompletionRound(
    message, artifacts, 'ui-failure', 'paused', 'failed',
  ), 3)
  assert.equal(failedExecutionCompletionRound(
    message, artifacts, 'ui-failure', 'paused', 'passed',
  ), null)
  assert.equal(failedExecutionCompletionRound(
    message, [], 'ui-failure', 'paused', 'failed',
  ), null)
  assert.equal(failedExecutionCompletionRound(
    message, artifacts, 'newer-ui', 'paused', 'failed',
  ), null)
})

test('a stopped execution can restart and can use an existing output for completion', () => {
  const message = {
    id: 'test-stopped', role: 'assistant', channel: 'execution',
    run_status: 'cancelled', step_key: 'test', artifact_round: 3,
  }
  assert.equal(canRestartStoppedExecutionMessage(message, 'test-stopped', 'stopped', 'pending'), true)
  assert.equal(canRestartStoppedExecutionMessage(message, 'newer-test', 'stopped', 'pending'), false)
  assert.equal(canRestartStoppedExecutionMessage(message, 'test-stopped', 'running', 'pending'), false)
  assert.equal(failedExecutionCompletionRound(
    message, [{ step_key: 'test', round: 3 }], 'test-stopped', 'stopped', 'pending',
  ), 3)
  assert.equal(failedExecutionCompletionRound(
    message, [], 'test-stopped', 'stopped', 'pending',
  ), null)
})

test('later contextual messages do not hide actions on the latest stopped execution', () => {
  const latest = latestExecutionMessageIdsByStep([
    { id: 'execution-1', channel: 'execution', role: 'assistant', step_key: 'test' },
    { id: 'coordinator-2', channel: 'coordinator', role: 'assistant', step_key: 'test' },
    { id: 'execution-3', channel: 'execution', role: 'assistant', step_key: 'backend' },
  ])
  assert.equal(latest.get('test'), 'execution-1')
  assert.equal(latest.get('backend'), 'execution-3')
})

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

test('reused failed message shows its new attempt and discards loaded old trace', () => {
  const oldMessage = {
    id: 'same-id', role: 'assistant', run_status: 'failed', content: 'old failure',
    step_run_id: 'old-run', event_log_path: 'old.jsonl',
    event_detail: { loaded: true }, events: [{ type: 'old' }],
    created_at: '2026-01-01T00:00:00Z',
  }
  const live = {
    role: 'assistant', status: 'running', content: '', restarted: true,
    started_at: '2026-01-02T00:00:00Z', events: [{ type: 'TEXT_MESSAGE_START' }],
  }
  const running = mergeHistoryMessageWithLive(oldMessage, live)
  assert.equal(running.run_status, 'running')
  assert.equal(running.content, '')
  assert.deepEqual(running.events, live.events)
  assert.equal(running.started_at, live.started_at)
  assert.equal(running.created_at, oldMessage.created_at)

  const refreshed = mergeRefreshedTaskHistory([oldMessage], [{
    ...oldMessage, run_status: 'running', step_run_id: 'new-run',
    event_log_path: 'new.jsonl', events: [], event_detail: { loaded: false },
  }])
  assert.deepEqual(refreshed[0].events, [])
  assert.equal(refreshed[0].event_detail.loaded, false)
})

test('keeps the stop action available while an automatic review is running', () => {
  assert.equal(isStepActiveForStop('running'), true)
  assert.equal(isStepActiveForStop('reviewing'), true)
  assert.equal(isStepActiveForStop('awaiting_review'), false)
  assert.equal(isStepActiveForStop('passed'), false)
})

test('shows every solid downstream input connected to an output port', () => {
  const steps = [
    { key: 'req', nodeId: 1, label: '需求', inputs: [{ name: '业务需求' }], outputs: [{ name: 'PRD 文档' }, { name: 'SPEC 规范文档' }, { name: '分支名' }] },
    { key: 'ui', nodeId: 2, label: 'UI 设计', inputs: [{ name: 'PRD 文档' }] },
    { key: 'backend', nodeId: 4, label: '后端开发', inputs: [{ name: '后端功能开发' }] },
    { key: 'test', nodeId: 5, label: '测试', inputs: [{ name: '前端功能测试' }, { name: '后端功能测试' }, { name: 'PRD 文档' }] },
  ]
  const connections = [
    { from: 1, fromPort: 0, to: 2, toPort: 0, kind: 'solid' },
    { from: 1, fromPort: 0, to: 5, toPort: 2, kind: 'solid' },
    { from: 1, fromPort: 2, to: 4, toPort: 0, kind: 'solid' },
    { from: 5, fromPort: 0, to: 1, toPort: 0, kind: 'dashed' },
  ]

  assert.deepEqual(downstreamInputsForOutput(steps, connections, 'req', 0), [
    { stepKey: 'ui', stepLabel: 'UI 设计', inputName: 'PRD 文档' },
    { stepKey: 'test', stepLabel: '测试', inputName: 'PRD 文档' },
  ])
  assert.deepEqual(downstreamInputsForOutput(steps, connections, 'req', 1), [])
  assert.deepEqual(downstreamInputsForOutput(steps, connections, 'req', 2), [
    { stepKey: 'backend', stepLabel: '后端开发', inputName: '后端功能开发' },
  ])
})

test('separates active parallel steps from downstream steps during a restart', () => {
  const steps = [
    { key: 'a' },
    { key: 'b' },
    { key: 'c', dependsOn: ['a'] },
  ]
  const progress = [
    { step_key: 'a', status: 'passed' },
    { step_key: 'b', status: 'reviewing' },
    { step_key: 'c', status: 'running' },
  ]

  const fromA = resolveStepRestartImpact(steps, progress, 'a')
  assert.deepEqual(fromA.interrupted.map((step) => step.key), ['b', 'c'])
  assert.deepEqual(fromA.restarted.map((step) => step.key), ['c'])
  assert.deepEqual(fromA.cancelled.map((step) => step.key), ['b'])

  const fromC = resolveStepRestartImpact(steps, progress, 'c')
  assert.deepEqual(fromC.interrupted.map((step) => step.key), ['b', 'c'])
  assert.deepEqual(fromC.restarted.map((step) => step.key), ['c'])
  assert.deepEqual(fromC.cancelled.map((step) => step.key), ['b'])
})

test('uses the selected round manifest outputs instead of the workflow declaration', () => {
  const artifacts = [
    { step_key: 'feedback-eval', round: 4, declared_output: true, name: 'old.md', logical_name: 'old.md', is_latest: false, is_selected: false },
    { step_key: 'feedback-eval', round: 5, declared_output: true, name: 'score.md', logical_name: 'score.md', is_latest: true, is_selected: true },
    { step_key: 'feedback-eval', round: 5, declared_output: true, name: 'value-report.html', logical_name: 'value-report.html', is_latest: true, is_selected: true },
    { step_key: 'feedback-eval', round: 5, declared_output: false, name: 'nested.css', logical_name: null, is_latest: true, is_selected: true },
  ]

  assert.deepEqual(
    artifactsForStepRoundOutputs(artifacts, 'feedback-eval', 5).map((item) => item.name),
    ['score.md', 'value-report.html'],
  )
})

test('groups declared and produced outputs under their configured input ports', () => {
  const inputs = [
    { name: '前端功能测试', outputs: [{ name: '测试报告', type: 'md' }, { name: 'Bug 列表', type: 'md' }] },
    { name: '后端功能测试', outputs: [{ name: 'BUG 列表', type: 'md' }, { name: '测试报告', type: 'md' }] },
    { name: 'PRD 文档', outputs: [{ name: '测试用例', type: 'md' }, { name: '验收标准', type: 'md' }] },
  ]
  const produced = [
    { name: 'front.html', logical_name: '测试报告', artifact_type: 'HTML' },
    { name: 'backend.md', logical_name: 'BUG 列表', artifact_type: 'md' },
  ]

  const declared = groupStepOutputsByInput(inputs, [], [])
  assert.deepEqual(declared.map((group) => group.map((output) => output.name)), [
    ['测试报告', 'Bug 列表'],
    ['BUG 列表', '测试报告'],
    ['测试用例', '验收标准'],
  ])
  const actual = groupStepOutputsByInput(inputs, [], produced)
  assert.deepEqual(actual.map((group) => group.map((output) => output.name)), [
    ['测试报告'],
    ['BUG 列表'],
    [],
  ])
  assert.equal(actual[0][0].artifact, produced[0])
  assert.equal(actual[1][0].artifact, produced[1])

  const duplicateNames = groupStepOutputsByInput(inputs, [], [
    { name: 'backend-report.md', logical_name: '测试报告', artifact_type: 'md', output_port: 3 },
    { name: 'front-report.md', logical_name: '测试报告', artifact_type: 'md', output_port: 0 },
  ])
  assert.deepEqual(duplicateNames.map((group) => group.map((output) => output.artifact?.name)), [
    ['front-report.md'],
    ['backend-report.md'],
    [],
  ])
})

test('keeps a directory output as one entry instead of listing its scanned files', () => {
  const artifacts = [
    { step_key: 'build', round: 2, declared_output: false, name: 'site', logical_name: null, path: '/artifacts/build/2/site', is_dir: true, is_latest: true, is_selected: true },
    { step_key: 'build', round: 2, declared_output: true, name: 'index.html', logical_name: '首页', path: '/artifacts/build/2/site/index.html', is_dir: false, is_latest: true, is_selected: true },
    { step_key: 'build', round: 2, declared_output: true, name: 'app.js', logical_name: '脚本', path: '/artifacts/build/2/site/assets/app.js', is_dir: false, is_latest: true, is_selected: true },
    { step_key: 'build', round: 2, declared_output: true, name: 'summary.md', logical_name: '摘要', path: '/artifacts/build/2/summary.md', is_dir: false, is_latest: true, is_selected: true },
  ]

  assert.deepEqual(
    artifactsForStepRoundOutputs(artifacts, 'build', 2).map((item) => item.name),
    ['site', 'summary.md'],
  )
})

test('resolves a step input from the selected output round input snapshot', () => {
  const artifacts = [
    { step_key: 'req', round: 1, path: '/artifacts/req/1/prd.md', name: 'prd.md', is_latest: false, is_selected: false },
    { step_key: 'req', round: 2, path: '/artifacts/req/2/prd.md', name: 'prd.md', is_latest: true, is_selected: true },
  ]
  const snapshots = [{
    step_key: 'build',
    round: 3,
    ports: [{
      port: 0,
      name: 'PRD',
      status: 'ready',
      sources: [{ step: 'req', round: 1, path: '/artifacts/req/1/prd.md', name: 'PRD' }],
    }],
  }]

  assert.equal(
    findStepRoundInputArtifact(artifacts, snapshots, 'build', 3, 0)?.round,
    1,
  )
  assert.equal(findStepRoundInputArtifact(artifacts, snapshots, 'build', 2, 0), undefined)
})

test('preserves task-context input status even when there is no artifact file', () => {
  const snapshots = [{
    step_key: 'requirements',
    round: 5,
    ports: [{ port: 0, name: '需求内容', status: 'task_context', sources: [] }],
  }]

  assert.equal(
    findStepRoundInputPort(snapshots, 'requirements', 5, 0)?.status,
    'task_context',
  )
})

test('detects only input and output contract changes against the run snapshot', () => {
  const executedContract = {
    inputs: [{ name: '初稿', type: 'md' }],
    outputs: [{ name: '定稿', type: 'md' }],
  }
  const sameContract = {
    key: 'review',
    prompt: 'new prompt',
    inputs: [{ name: '初稿', type: 'md' }],
    outputs: [{ name: '定稿', type: 'md' }],
  }
  const changedContract = {
    ...sameContract,
    outputs: [{ name: '定稿目录', type: 'directory' }],
  }

  assert.equal(hasStepIoContractChanged(sameContract, executedContract), false)
  assert.equal(hasStepIoContractChanged(changedContract, executedContract), true)
  assert.equal(hasStepIoContractChanged(sameContract, undefined), false)
})

test('finds the latest task created by a workflow dispatch step', () => {
  const tasks = [
    {
      id: 'child-old',
      source_task_id: 'parent-1',
      source_step_key: 'handoff',
      created_at: '2026-09-20T10:00:00Z',
    },
    {
      id: 'other-child',
      source_task_id: 'another-parent',
      source_step_key: 'handoff',
      created_at: '2026-09-22T10:00:00Z',
    },
    {
      id: 'child-new',
      source_task_id: 'parent-1',
      source_step_key: 'handoff',
      created_at: '2026-09-21T10:00:00Z',
    },
  ]

  assert.equal(
    findLatestDispatchedTask(tasks, 'parent-1', 'handoff')?.id,
    'child-new',
  )
  assert.equal(findLatestDispatchedTask(tasks, 'parent-1', 'missing'), undefined)
})

test('does not present an idle pending step as currently running', () => {
  assert.equal(findActiveStepIndex(['passed', 'skipped', 'pending'], 'ready'), -1)
  assert.equal(findActiveStepIndex(['passed', 'skipped', 'pending'], 'running'), 2)
  assert.equal(findActiveStepIndex(['passed', 'failed', 'pending'], 'ready'), 1)
})

test('keeps previous step result visible while the current run is pending', () => {
  assert.equal(resolveStepDisplayStatus('pending', 'passed'), 'passed')
  assert.equal(resolveStepDisplayStatus('pending', 'failed'), 'failed')
  assert.equal(resolveStepDisplayStatus('pending', null), 'pending')
  assert.equal(resolveStepDisplayStatus('running', 'passed'), 'running')
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

test('prefers the selected latest artifact round over older eligible rounds', () => {
  const artifacts = [
    {
      step_key: 'req',
      round: 1,
      is_latest: false,
      is_selected: false,
      logical_name: 'PRD',
      name: 'prd.md',
    },
    {
      step_key: 'req',
      round: 2,
      is_latest: true,
      is_selected: true,
      logical_name: 'PRD',
      name: 'prd.md',
    },
  ]

  assert.equal(findPreferredArtifact(artifacts, 'PRD', 'req')?.round, 2)
})

test('keeps preferred step filtering when artifacts share a logical name', () => {
  const artifacts = [
    {
      step_key: 'design',
      round: 1,
      is_latest: true,
      is_selected: true,
      logical_name: 'Spec',
      name: 'spec.md',
    },
    {
      step_key: 'req',
      round: 2,
      is_latest: true,
      is_selected: true,
      logical_name: 'Spec',
      name: 'spec.md',
    },
  ]

  assert.equal(findPreferredArtifact(artifacts, 'Spec', 'req')?.step_key, 'req')
})

test('uses the relative artifact identity when file names are duplicated', () => {
  const artifacts = [
    {
      step_key: 'design', round: 1, is_latest: true, is_selected: true,
      logical_name: null, name: 'solution.md', path: '/artifacts/方案一/solution.md',
    },
    {
      step_key: 'design', round: 1, is_latest: true, is_selected: true,
      logical_name: null, name: 'solution.md', path: '/artifacts/方案二/solution.md',
    },
  ]

  assert.equal(
    findPreferredArtifact(
      artifacts,
      'solution.md',
      'design',
      1,
      '/artifacts/方案二/solution.md',
    )?.path,
    '/artifacts/方案二/solution.md',
  )
})

test('selects only the artifact round owned by a task message', () => {
  const artifacts = [
    { step_key: 'req', round: 1, is_latest: false, is_selected: false, name: 'prd.md' },
    { step_key: 'req', round: 2, is_latest: true, is_selected: true, name: 'prd.md' },
    { step_key: 'build', round: 1, is_latest: true, is_selected: true, name: 'result.md' },
  ]
  assert.deepEqual(
    artifactsForMessage(artifacts, 'req', 1).map((artifact: any) => artifact.round),
    [1],
  )
  assert.deepEqual(
    artifactsForMessage(artifacts, 'req', 2).map((artifact: any) => artifact.round),
    [2],
  )
  assert.deepEqual(artifactsForMessage(artifacts, 'req', null), [])
  assert.equal(findPreferredArtifact(artifacts, 'prd.md', 'req', 1)?.round, 1)
})

test('shows a directory artifact without listing files inside it', () => {
  const artifacts = [
    {
      step_key: 'design', round: 1, is_latest: true, is_selected: true,
      name: '方案目录', path: '/artifacts/design/方案目录', is_dir: true,
    },
    {
      step_key: 'design', round: 1, is_latest: true, is_selected: true,
      name: 'solution.md', path: '/artifacts/design/方案目录/solution.md', is_dir: false,
    },
    {
      step_key: 'design', round: 1, is_latest: true, is_selected: true,
      name: 'comparison.md', path: '/artifacts/design/comparison.md', is_dir: false,
    },
  ]

  assert.deepEqual(
    artifactsForMessage(artifacts, 'design', 1).map((artifact) => artifact.name),
    ['方案目录', 'comparison.md'],
  )
})

import {
  createOptimisticUserMessage,
  createOptimisticCoordinatorMessage,
  isAutoShrinkClamp,
  isVisibleHistoryMessage,
  isVisibleLiveExecutionMessage,
  isUnpersistedLiveMessage,
  isTaskCompleted,
  isTaskNotStarted,
  isNearConversationBottom,
  conversationBottomScrollTop,
  shouldPauseConversationFollow,
  isManualReviewMessage,
  isMessageReviewActionable,
  isReviewActionable,
  isLostEngineSessionError,
  isStepResumableWithMessage,
  isSelectedStepRunning,
  liveExecutionStatus,
  orderConversationMessages,
  resolveMessageReview,
  resolveTaskChatTarget,
  taskTargetStepsInWorkflowOrder,
  reviewActorLabel,
  resolveMessageError,
  resolveMessagePrompt,
  shouldRenderLegacyExecution,
  stepAvatarText,
} from '../src/pages/taskDetailChat.ts'

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

test('the composer stop state follows only the selected step tab', () => {
  assert.equal(isSelectedStepRunning('implement', ['implement']), true)
  assert.equal(isSelectedStepRunning('review', ['implement']), false)
  assert.equal(isSelectedStepRunning('coordinator', ['implement']), false)
})

test('the chat target stays on coordinator unless a selected step is still available', () => {
  assert.equal(
    resolveTaskChatTarget('coordinator', ['requirement'], ['requirement']),
    'coordinator',
  )
  assert.equal(
    resolveTaskChatTarget('requirement', ['requirement'], []),
    'requirement',
  )
  assert.equal(
    resolveTaskChatTarget('design', [], ['design']),
    'design',
  )
  assert.equal(
    resolveTaskChatTarget('design', [], []),
    'coordinator',
  )
})

test('orders step targets by workflow instead of execution state', () => {
  const steps = [
    { key: 'requirement', label: '需求' },
    { key: 'design', label: '设计' },
    { key: 'develop', label: '开发' },
  ]

  assert.deepEqual(
    taskTargetStepsInWorkflowOrder(steps, ['develop'], ['requirement', 'design'])
      .map((step) => step.key),
    ['requirement', 'design', 'develop'],
  )
})

test('extracts a readable failure from persisted and live task events', () => {
  const nestedError = JSON.stringify({
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: "The 'gpt-6-astra' model requires a newer version of Codex.",
    },
  })

  assert.equal(resolveMessageError([{
    type: 'error',
    data: { message: nestedError },
  }]), "The 'gpt-6-astra' model requires a newer version of Codex.")

  assert.equal(resolveMessageError([{
    type: 'CUSTOM',
    name: 'workstep.error',
    value: { message: nestedError },
  }]), "The 'gpt-6-astra' model requires a newer version of Codex.")

  assert.equal(resolveMessageError([{
    type: 'RUN_ERROR',
    error: 'Engine process exited unexpectedly',
  }]), 'Engine process exited unexpectedly')
})

test('history refresh preserves already loaded detail events', () => {
  const current = [{
    id: 'message-1',
    content: '旧回答',
    events: [{ type: 'REASONING_MESSAGE_CHUNK', event_sequence: 1, delta: '完整思考' }],
    event_detail: { available: true, loaded: true, loading: false, complete: true },
  }]
  const refreshed = [{
    id: 'message-1',
    content: '新回答',
    events: [],
    event_detail: { available: true, loaded: false, loading: false },
  }]

  const merged = mergeRefreshedTaskHistory(current, refreshed)

  assert.equal(merged[0].content, '新回答')
  assert.deepEqual(merged[0].events, current[0].events)
  assert.deepEqual(merged[0].event_detail, current[0].event_detail)
})

test('history refresh keeps newer review messages missing from an older page', () => {
  const current = [
    {
      id: 'execution-1',
      channel: 'execution',
      sequence: 1,
      content: '阶段结果',
      run_status: 'succeeded',
    },
    {
      id: 'review-1',
      channel: 'review',
      sequence: 2,
      content: '审核中',
      run_status: 'running',
    },
  ]
  const staleRefresh = [{
    id: 'execution-1',
    channel: 'execution',
    sequence: 1,
    content: '阶段结果',
    run_status: 'succeeded',
  }]

  const merged = mergeRefreshedTaskHistory(current, staleRefresh)

  assert.deepEqual(
    new Set(merged.map((message) => message.id)),
    new Set(['execution-1', 'review-1']),
  )
})

test('merges live review chunks into the running review history message', () => {
  const historyMessage = {
    id: 'review-running',
    channel: 'review',
    step_key: 'build',
    role: 'assistant',
    content: '审核中',
    run_status: 'running',
    events: [],
  }
  const liveMessage = {
    id: 'review-running',
    channel: 'review',
    step_key: 'build',
    role: 'assistant',
    content: '审核中正在检查验收标准',
    status: 'running',
    engine: 'codex_sdk',
    events: [{ type: 'TEXT_MESSAGE_CHUNK', messageId: 'review-running', delta: '正在检查验收标准' }],
  }

  const merged = mergeHistoryMessageWithLive(historyMessage, liveMessage)

  assert.equal(merged.content, '审核中正在检查验收标准')
  assert.equal(merged.run_status, 'running')
  assert.equal(isVisibleLiveExecutionMessage(liveMessage), true)
  assert.equal(
    isUnpersistedLiveMessage(liveMessage, new Set(['review-running'])),
    false,
  )
})

test('loads task JSONL details without dropping newer live events', () => {
  const messages = [{
    id: 'message-1',
    role: 'assistant',
    content: '回答',
    events: [{ type: 'TEXT_MESSAGE_CHUNK', event_sequence: 3, delta: '实时尾部' }],
    event_detail: { available: true, loaded: false, loading: true },
  }]

  const merged = mergeLoadedTaskMessageEvents(
    messages,
    'message-1',
    [
      { type: 'REASONING_MESSAGE_CHUNK', event_sequence: 1, delta: '历史思考' },
      { type: 'TEXT_MESSAGE_CHUNK', event_sequence: 2, delta: '历史回答' },
    ],
    { complete: true, next_cursor: null },
  )

  assert.deepEqual(merged[0].events.map((event: any) => event.event_sequence), [1, 2, 3])
  assert.deepEqual(merged[0].event_detail, {
    available: true,
    loaded: true,
    loading: false,
    complete: true,
    next_cursor: null,
    error: '',
  })
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

test('creates a user message that can render before the run request resolves', () => {
  const message = createOptimisticUserMessage(
    'pending-1',
    '继续检查 token 统计',
    'implement',
    '2024-08-03T00:00:00+00:00',
  )

  assert.deepEqual(message, {
    id: 'pending-1',
    role: 'user',
    content: '继续检查 token 统计',
    step_key: 'implement',
    run_status: 'pending',
    created_at: '2024-08-03T00:00:00+00:00',
    events: [],
  })
})

test('creates a coordinator message with its channel before the request resolves', () => {
  const message = createOptimisticCoordinatorMessage(
    'pending-coordinator-1',
    '结合需求阶段继续分析',
    'requirement',
    '2024-08-03T00:00:00+00:00',
  )

  assert.equal(message.channel, 'coordinator')
  assert.equal(message.step_key, 'requirement')
  assert.equal(message.context_step_key, 'requirement')
  assert.equal(message.role, 'user')
  assert.equal(message.content, '结合需求阶段继续分析')
})

test('detects tasks that have not started from their configured step', () => {
  assert.equal(isTaskNotStarted([
    { status: 'skipped', started_at: null },
    { status: 'pending', started_at: null },
  ]), true)
  assert.equal(isTaskNotStarted([
    { status: 'passed', started_at: '2026-08-04T00:00:00+00:00' },
  ]), false)
  assert.equal(isTaskNotStarted([
    { status: 'running', started_at: '2026-08-04T00:00:00+00:00' },
  ]), false)
})

test('distinguishes completed tasks from ready tasks that never started', () => {
  assert.equal(isTaskCompleted([
    { status: 'skipped', started_at: null },
    { status: 'passed', started_at: '2026-08-04T00:00:00+00:00' },
  ]), true)
  assert.equal(isTaskCompleted([
    { status: 'skipped', started_at: null },
    { status: 'pending', started_at: null },
  ]), false)
})

test('shows only step execution replies in the main task conversation', () => {
  assert.equal(isVisibleHistoryMessage({
    channel: 'execution', role: 'assistant', content: '阶段结果', run_status: 'succeeded',
  }), true)
  assert.equal(isVisibleHistoryMessage({
    channel: 'review', role: 'assistant', content: '审核结果', run_status: 'succeeded',
  }), true)
  assert.equal(isVisibleHistoryMessage({
    channel: 'review', role: 'assistant', content: '', run_status: 'succeeded',
    event_detail: { event_count: 12 },
  }), true)
  assert.equal(isVisibleHistoryMessage({
    channel: 'review', role: 'assistant', content: '等待你审核', run_status: 'completed',
    events: [{
      type: 'review_context',
      data: { review_run_id: 'review-skipped', status: 'skipped' },
    }],
  }), false)
  // 已停止/失败但无内容的执行消息仍保留展示（附带失败徽标）。
  assert.equal(isVisibleHistoryMessage({
    channel: 'execution', role: 'assistant', content: '', run_status: 'failed',
  }), true)
  assert.equal(isVisibleHistoryMessage({
    channel: 'execution', role: 'assistant', content: '', run_status: 'succeeded',
  }), false)
  assert.equal(isVisibleHistoryMessage({
    channel: 'coordinator', role: 'assistant', content: '协调回复', run_status: 'succeeded',
  }), true)
})

test('detects a lost engine session so the step can be re-run with a fresh session', () => {
  assert.equal(
    isLostEngineSessionError(
      'JSON-RPC error -32600: no rollout found for thread id 01a0aa38-2890-7ed3-9a30-ecfbe37f3056',
    ),
    true,
  )
  assert.equal(
    isLostEngineSessionError(
      'Claude Code returned an error result: No conversation found with session ID: a6b27625',
    ),
    true,
  )
  assert.equal(isLostEngineSessionError('Process exited with code 1'), false)
  assert.equal(isLostEngineSessionError(''), false)
  assert.equal(isLostEngineSessionError(undefined), false)
})

test('allows a message to rerun stopped, failed, review-waiting, or completed steps', () => {
  for (const status of [
    'cancelled', 'failed', 'rejected', 'awaiting_review', 'passed', 'skipped',
  ]) {
    assert.equal(isStepResumableWithMessage(status), true)
  }
  for (const status of ['pending', 'running', 'reviewing', 'retrying', 'rework', 'rework_waiting']) {
    assert.equal(isStepResumableWithMessage(status), false)
  }
})

test('allows @ on any step that ran before, even while it is pending again', () => {
  // 只要执行过一次（成功或失败），不管当前状态是否为 pending 都能发消息重跑。
  assert.equal(isStepResumableWithMessage('pending', true), true)
  assert.equal(isStepResumableWithMessage('failed', true), true)
  assert.equal(isStepResumableWithMessage('cancelled', true), true)
  // 从未执行过的 pending 阶段不能 @。
  assert.equal(isStepResumableWithMessage('pending', false), false)
  assert.equal(isStepResumableWithMessage('pending'), false)
  // 正在执行的阶段只走实时注入，历史标志不能把它变成重跑目标。
  assert.equal(isStepResumableWithMessage('running', true), false)
  assert.equal(isStepResumableWithMessage('reviewing', true), false)
  assert.equal(isStepResumableWithMessage('rework', true), false)
})

test('keeps a running review placeholder visible in history', () => {
  // 审核刚启动时 journal 还没有 chunk，历史只能提供「审核中」占位；
  // 这条消息不能被当成空消息过滤掉，否则审核期间列表里什么都看不到。
  assert.equal(isVisibleHistoryMessage({
    id: 'review-running',
    channel: 'review',
    role: 'assistant',
    content: '审核中',
    run_status: 'running',
    events: [],
  }), true)
  // 真正的空审核消息（例如占位被错误清空）才会被隐藏。
  assert.equal(isVisibleHistoryMessage({
    id: 'review-empty',
    channel: 'review',
    role: 'assistant',
    content: '',
    run_status: 'running',
    events: [],
  }), false)
})

test('keeps running execution and review messages visible and uses the step as its avatar', () => {
  assert.equal(isVisibleLiveExecutionMessage({
    channel: 'execution', content: '', status: 'running',
  }), true)
  assert.equal(isVisibleLiveExecutionMessage({
    channel: 'review', content: '审核中', status: 'running',
  }), true)
  assert.equal(stepAvatarText('任务理解'), '任务')
  assert.equal(stepAvatarText('测试'), '测试')
})

test('does not render a live message again after history contains it', () => {
  const persistedIds = new Set(['message-1'])
  assert.equal(isUnpersistedLiveMessage({ id: 'message-1' }, persistedIds), false)
  assert.equal(isUnpersistedLiveMessage({ id: 'message-2' }, persistedIds), true)
})

test('marks live-inserted user messages as user so they never render as execution bubbles', () => {
  // 引擎只发 live_message 确认，store 把该事件对应消息标记为 user；
  // 左侧执行消息渲染应将其排除，避免插入消息出现第二个流式气泡。
  assert.equal(isVisibleLiveExecutionMessage({
    id: 'mid-1', channel: 'execution', role: 'user', content: '插入内容', status: 'running',
  }), false)
  assert.equal(isVisibleLiveExecutionMessage({
    id: 'mid-1', channel: 'execution', role: 'assistant', content: '', status: 'running',
  }), true)
})

test('merges live execution updates into a persisted running message', () => {
  const merged = mergeHistoryMessageWithLive(
    {
      id: 'message-1',
      content: '',
      events: [],
      run_status: 'running',
      prompt: 'persisted prompt',
    },
    {
      id: 'message-1',
      content: '实时输出',
      events: [{ type: 'text_delta', data: { delta: '实时输出' } }],
      status: 'running',
      prompt: 'live prompt',
    },
  )

  assert.equal(merged.content, '实时输出')
  assert.equal(merged.events.length, 1)
  assert.equal(merged.prompt, 'live prompt')
  assert.equal(merged.run_status, 'running')
})

test('keeps a terminal history status when a stale live update still says running', () => {
  const merged = mergeHistoryMessageWithLive(
    { id: 'old-review', role: 'assistant', run_status: 'cancelled', ended_at: '2026-09-24T04:48:28Z', content: '审核中', events: [] },
    { id: 'old-review', role: 'assistant', status: 'running', content: '审核中', events: [] },
  )
  assert.equal(merged.run_status, 'cancelled')
})

test('keeps the inserted user message completed after its live_message ack', () => {
  // 插入的用户消息没有 message_completed 事件，只有 live_message 确认；
  // 合并时必须沿用历史 run_status，避免右侧用户气泡被误标为 streaming。
  const merged = mergeHistoryMessageWithLive(
    {
      id: 'mid-1',
      role: 'user',
      content: '插入内容',
      events: [],
      run_status: 'completed',
      created_at: '2026-08-12T08:00:00+00:00',
    },
    {
      id: 'mid-1',
      channel: 'execution',
      role: 'user',
      content: '插入内容',
      events: [{ type: 'live_message', data: { status: 'delivered' } }],
      status: 'running',
    },
  )

  assert.equal(merged.run_status, 'completed')
  assert.equal(merged.role, 'user')
})

test('keeps persisted interaction requests when the live update contains their response', () => {
  const merged = mergeHistoryMessageWithLive(
    {
      id: 'message-1',
      content: '',
      events: [{
        type: 'interaction_request',
        data: { interaction_id: 'request-1', method: 'elicitation/create', params: {} },
      }],
      run_status: 'running',
    },
    {
      id: 'message-1',
      content: '',
      events: [{
        type: 'interaction_response',
        data: { interaction_id: 'request-1', result: { action: 'accept', content: {} } },
      }],
      status: 'running',
    },
  )

  assert.deepEqual(merged.events.map((event: { type: string }) => event.type), [
    'interaction_request',
    'interaction_response',
  ])
})

test('orders sealed step segments around an inserted user message', () => {
  const ordered = orderConversationMessages([
    { id: 'B', role: 'assistant', sequence: 2, created_at: '2026-08-07T10:01:00.500Z', content: '第二段输出' },
    { id: 'U', role: 'user', sequence: 1, created_at: '2026-08-07T10:01:00.000Z', content: '插入内容' },
    { id: 'A', role: 'assistant', sequence: 0, created_at: '2026-08-07T10:00:00.000Z', content: '第一段输出' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['A', 'U', 'B'])
})

test('keeps a live-insert user message between step segments by server time', () => {
  // 乐观消息按服务端 created_at 落位：即使客户端时钟与 daemon 有偏差，
  // 插入消息也始终位于段 A 与段 B 之间（B 是引擎 ack 后才创建的服务端时间）。
  const ordered = orderConversationMessages([
    { id: 'A', role: 'assistant', created_at: '2026-08-07T10:00:00.000Z', content: '第一段输出' },
    { id: 'U', role: 'user', created_at: '2026-08-07T10:01:00.000Z', content: '插入内容' },
    { id: 'B', role: 'assistant', created_at: '2026-08-07T10:01:00.500Z', content: '第二段输出' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['A', 'U', 'B'])
})

test('falls back to created_at when only one side carries a sequence', () => {
  const ordered = orderConversationMessages([
    { id: 'B', role: 'assistant', created_at: '2026-08-07T10:01:00.500Z', content: '第二段输出' },
    { id: 'U', role: 'user', sequence: 1, created_at: '2026-08-07T10:01:00.000Z', content: '插入内容' },
    { id: 'A', role: 'assistant', sequence: 0, created_at: '2026-08-07T10:00:00.000Z', content: '第一段输出' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['A', 'U', 'B'])
})

test('keeps a still-running step message at its start time', () => {
  const ordered = orderConversationMessages([
    { id: 'A', role: 'assistant', run_status: 'running', created_at: '2026-08-07T10:00:00.000Z', content: '正在输出' },
    { id: 'U', role: 'user', created_at: '2026-08-07T10:01:00.000Z', content: '插入内容', run_status: 'completed' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['A', 'U'])
})

test('keeps a coordinator reply after the user message when their timestamps are equal', () => {
  const ordered = orderConversationMessages([
    {
      id: 'assistant',
      role: 'assistant',
      channel: 'coordinator',
      reply_to_message_id: 'user',
      run_status: 'running',
      created_at: '2026-09-21T06:40:25.000Z',
    },
    {
      id: 'user',
      role: 'user',
      channel: 'coordinator',
      run_status: 'completed',
      created_at: '2026-09-21T06:40:25.000Z',
    },
  ])

  assert.deepEqual(ordered.map((message) => message.id), ['user', 'assistant'])
})

test('keeps a running reply after a user message sent just before it', () => {
  const ordered = orderConversationMessages([
    {
      id: 'assistant',
      role: 'assistant',
      channel: 'coordinator',
      run_status: 'running',
      created_at: '2026-09-21T06:40:25.100Z',
    },
    {
      id: 'user',
      role: 'user',
      channel: 'coordinator',
      run_status: 'completed',
      created_at: '2026-09-21T06:40:25.000Z',
    },
  ])

  assert.deepEqual(ordered.map((message) => message.id), ['user', 'assistant'])
})

test('keeps finished step messages at their start time', () => {
  // 完成时间可能晚于用户发送时间，消息仍按界面显示的开始时间排列。
  const ordered = orderConversationMessages([
    { id: 'A', role: 'assistant', run_status: 'succeeded', created_at: '2026-08-07T10:00:00.000Z', ended_at: '2026-08-07T10:02:00.000Z', content: '第一段输出' },
    { id: 'U', role: 'user', created_at: '2026-08-07T10:01:00.000Z', content: '插入内容', run_status: 'completed' },
    { id: 'Prev', role: 'assistant', run_status: 'succeeded', created_at: '2026-08-07T09:58:00.000Z', ended_at: '2026-08-07T09:59:00.000Z', content: '早前输出' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['Prev', 'A', 'U'])
})

test('keeps later user messages below persisted running steps', () => {
  const ordered = orderConversationMessages([
    { id: 'later-user', role: 'user', sequence: 24, created_at: '2026-09-24T05:12:19.511843Z' },
    { id: 'step', role: 'assistant', channel: 'execution', sequence: 4, run_status: 'running', created_at: '2026-09-24T01:34:56.302751Z' },
    { id: 'review', role: 'assistant', channel: 'review', sequence: 5, run_status: 'running', created_at: '2026-09-24T01:35:32.235787Z' },
    { id: 'earlier-user', role: 'user', sequence: 22, created_at: '2026-09-24T05:08:15.161294Z' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['step', 'review', 'earlier-user', 'later-user'])
})

test('keeps a live message between persisted messages by its creation time', () => {
  const messages = [
    { id: 'later-user', role: 'user', sequence: 2, created_at: '2026-09-24T13:10:00.000Z' },
    { id: 'live', role: 'assistant', status: 'running', created_at: '2026-09-24T13:15:00.000Z' },
    { id: 'long-step', role: 'assistant', sequence: 1, run_status: 'succeeded', created_at: '2026-09-24T09:34:56.000Z', ended_at: '2026-09-24T13:20:00.000Z' },
  ]
  assert.deepEqual(orderConversationMessages(messages).map((m) => m.id), ['long-step', 'later-user', 'live'])
  assert.deepEqual(orderConversationMessages([...messages].reverse()).map((m) => m.id), ['long-step', 'later-user', 'live'])
})

test('keeps a live coordinator reply and its placeholder above a later action', () => {
  const history = [
    { id: 'coordinator-user', role: 'user', channel: 'coordinator', sequence: 1, started_at: '2026-09-25T00:03:48Z' },
    { id: 'action-user', role: 'user', channel: 'action', sequence: 2, started_at: '2026-09-25T00:03:55Z' },
    { id: 'action-reply', role: 'assistant', channel: 'action', sequence: 3, started_at: '2026-09-25T00:03:55Z' },
  ]
  const reply = { id: 'live-coordinator', role: 'assistant', channel: 'coordinator', started_at: '2026-09-25T00:03:48Z', reply_to_message_id: 'coordinator-user' }
  const placeholder = { ...reply, id: 'pending-coordinator-thinking' }
  assert.deepEqual(orderConversationMessages([...history, reply]).map((message) => message.id), [
    'coordinator-user', 'live-coordinator', 'action-user', 'action-reply',
  ])
  assert.deepEqual(orderConversationMessages([...history, placeholder]).map((message) => message.id), [
    'coordinator-user', 'pending-coordinator-thinking', 'action-user', 'action-reply',
  ])
})

test('keeps concurrent persisted messages in server sequence despite start inversion', () => {
  const messages = [
    { id: 'ui-review', role: 'assistant', sequence: 6, started_at: '2026-09-24T01:35:32.233Z' },
    { id: 'backend-review', role: 'assistant', sequence: 5, started_at: '2026-09-24T01:35:32.235Z' },
    { id: 'backend-execution', role: 'assistant', sequence: 4, started_at: '2026-09-24T01:34:56.302751Z' },
  ]
  assert.deepEqual(orderConversationMessages(messages).map((m) => m.id), [
    'backend-execution', 'backend-review', 'ui-review',
  ])
})

test('keeps the old segment above an inserted user message and its new response', () => {
  const messages = [
    { id: 'response', role: 'assistant', channel: 'execution', sequence: 13, started_at: '2026-09-24T03:31:43.531189Z', run_status: 'running' },
    { id: 'insert', role: 'user', channel: 'execution', sequence: 12, started_at: '2026-09-24T03:31:43.514729Z' },
    { id: 'old-segment', role: 'assistant', channel: 'execution', sequence: 8, started_at: '2026-09-24T01:44:34.224401Z', ended_at: '2026-09-24T03:31:43.531189Z', run_status: 'succeeded' },
  ]
  assert.deepEqual(orderConversationMessages(messages).map((m) => m.id), [
    'old-segment', 'insert', 'response',
  ])
})

test('keeps concurrent executions in creation order when they finish in reverse order', () => {
  const ordered = orderConversationMessages([
    { id: 'second', role: 'assistant', channel: 'execution', sequence: 2, started_at: '2026-09-24T10:00:01Z', ended_at: '2026-09-24T10:01:00Z' },
    { id: 'first', role: 'assistant', channel: 'execution', sequence: 1, started_at: '2026-09-24T10:00:00Z', ended_at: '2026-09-24T10:05:00Z' },
    { id: 'later-user', role: 'user', sequence: 3, started_at: '2026-09-24T10:02:00Z' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['first', 'second', 'later-user'])
})

test('keeps an optimistic insert below its running segment until the server responds', () => {
  const ordered = orderConversationMessages([
    { id: 'pending-user', role: 'user', created_at: '2026-09-24T10:02:00Z' },
    { id: 'old-segment', role: 'assistant', channel: 'execution', sequence: 1, run_status: 'running', started_at: '2026-09-24T10:00:00Z' },
    { id: 'parallel-step', role: 'assistant', channel: 'execution', sequence: 2, run_status: 'running', started_at: '2026-09-24T10:01:00Z' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['old-segment', 'parallel-step', 'pending-user'])
})

test('keeps a step review after its execution when the execution end time is later', () => {
  // 阶段执行消息的 ended_at 可能在 finally 中记成审核结束之后；此时若按
  // 结束时间排序，审核会被顶到阶段输出上方。同阶段执行/审核必须按 sequence 排。
  const ordered = orderConversationMessages([
    {
      id: 'review',
      step_key: 'req',
      channel: 'review',
      role: 'assistant',
      sequence: 3,
      run_status: 'completed',
      ended_at: '2026-09-18T04:21:43.996793Z',
      content: '审核结果',
    },
    {
      id: 'execution',
      step_key: 'req',
      channel: 'execution',
      role: 'assistant',
      sequence: 2,
      run_status: 'succeeded',
      ended_at: '2026-09-18T04:21:44.007427Z',
      content: '阶段输出',
    },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['execution', 'review'])
})

test('keeps a step review after its execution when their displayed times are equal', () => {
  // 真实任务中审核记录先于 execution finally 封口约 0.7ms；两条消息在界面上显示为同一秒。
  // 审核是该阶段执行结果的后续消息，应按服务端 sequence 保持在执行消息之后。
  const ordered = orderConversationMessages([
    {
      id: 'execution',
      step_key: 'start',
      channel: 'execution',
      role: 'assistant',
      sequence: 1,
      run_status: 'succeeded',
      created_at: '2026-08-11T08:42:16.730656Z',
      ended_at: '2026-08-11T08:42:39.781289Z',
    },
    {
      id: 'review',
      step_key: 'start',
      channel: 'review',
      role: 'assistant',
      sequence: 2,
      run_status: 'completed',
      created_at: '2026-08-11T08:42:39.780547Z',
    },
  ])

  assert.deepEqual(ordered.map((message) => message.id), ['execution', 'review'])
})

test('describes the latest live engine activity before text arrives', () => {
  assert.equal(liveExecutionStatus([
    { type: 'thinking_delta', data: { delta: '分析' } },
    { type: 'tool_use', data: { name: 'Bash' } },
  ]), '正在执行工具：Bash')
  assert.equal(liveExecutionStatus([
    { type: 'status', data: { status: 'idle_timeout' } },
  ]), '等待插入消息超时，会话已自动结束')
  assert.equal(liveExecutionStatus([
    { type: 'status', data: { status: 'done' } },
  ]), '处理中')
  assert.equal(liveExecutionStatus([
    { type: 'status', data: { status: 'done' } },
  ], undefined, true), '回复已完成，等待插入消息…')
  assert.equal(liveExecutionStatus([]), '处理中')
})

test('only follows new messages while the reader stays near the bottom', () => {
  assert.equal(isNearConversationBottom(1000, 620, 300), true)
  assert.equal(isNearConversationBottom(1000, 300, 300), false)
})

test('pauses message following as soon as the reader navigates toward older messages', () => {
  assert.equal(shouldPauseConversationFollow({ type: 'wheel', deltaY: -1 }), true)
  assert.equal(shouldPauseConversationFollow({ type: 'wheel', deltaY: 1 }), false)
  assert.equal(shouldPauseConversationFollow({ type: 'key', key: 'ArrowUp' }), true)
  assert.equal(shouldPauseConversationFollow({ type: 'key', key: 'PageUp' }), true)
  assert.equal(shouldPauseConversationFollow({ type: 'key', key: 'Home' }), true)
  assert.equal(shouldPauseConversationFollow({ type: 'key', key: 'ArrowDown' }), false)
})

test('does not render the legacy running placeholder beside a structured message', () => {
  assert.equal(shouldRenderLegacyExecution(true, false, '', true), false)
  assert.equal(shouldRenderLegacyExecution(true, false, '', false), true)
})

test('adds the live coordinator prompt to an already persisted queued message', () => {
  assert.equal(resolveMessagePrompt(null, '  complete coordinator prompt  '), 'complete coordinator prompt')
  assert.equal(resolveMessagePrompt('persisted prompt', undefined), 'persisted prompt')
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

test('conversationBottomScrollTop pins to the bottom without going negative', () => {
  assert.equal(conversationBottomScrollTop(500, 300), 200)
  assert.equal(conversationBottomScrollTop(200, 300), 0)
  assert.equal(conversationBottomScrollTop(0, 0), 0)
})

test('treats a bottom-landing scroll as an auto shrink clamp, not a user scroll-up', () => {
  // 思考块折叠：内容从 1000 缩到 600，scrollTop 被浏览器钳制到新的底部 300。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 300,
    prevScrollTop: 700,
    scrollHeight: 600,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), true)
  // 用户滚轮上滚：scrollTop 减小但内容高度不变 → 手动滚动。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 650,
    prevScrollTop: 700,
    scrollHeight: 1000,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), false)
  // 内容撑大、scrollTop 不变：没有滚动发生。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 700,
    prevScrollTop: 700,
    scrollHeight: 1200,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), false)
  // 高度缩小、scrollTop 也减小但位置未落底（合成兜底分支）：不按自动钳制处理。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 200,
    prevScrollTop: 700,
    scrollHeight: 600,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), false)
  // 向下滚动一律不是上滚钳制。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 750,
    prevScrollTop: 700,
    scrollHeight: 1000,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), false)
})
