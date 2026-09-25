import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import TaskArtifactBrowser, {
  artifactFileType,
  artifactDirectories,
  buildArtifactStepGroups,
  resolveArtifactRound,
} from '../src/components/TaskArtifactBrowser.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const artifacts = [
  { step_key: 'build', round: 3, name: 'result.md', logical_name: '成品', path: 'result.md' },
  { step_key: 'req', round: 2, name: 'spec.json', logical_name: '需求规格', path: 'spec.json' },
  { step_key: 'req', round: 1, name: 'draft.md', logical_name: '需求草稿', path: 'draft.md' },
  { step_key: 'build', round: 1, name: 'source', logical_name: '源码', path: 'source', is_dir: true },
] as any[]

test('groups artifacts by workflow step and sorts rounds from small to large', () => {
  const groups = buildArtifactStepGroups(artifacts, [
    { key: 'req', label: '需求分析' },
    { key: 'build', label: '开发实现' },
  ])

  assert.deepEqual(groups.map((group) => group.key), ['req', 'build'])
  assert.deepEqual(groups[0].rounds.map((round) => round.round), [1, 2])
  assert.deepEqual(groups[1].rounds.map((round) => round.round), [1, 3])
})

test('groups a directory as one artifact instead of exposing its child files', () => {
  const groups = buildArtifactStepGroups([
    {
      step_key: 'design', round: 1, name: '方案目录', logical_name: '方案目录',
      path: '/artifacts/design/方案目录', is_dir: true,
    },
    {
      step_key: 'design', round: 1, name: 'solution.md', logical_name: null,
      path: '/artifacts/design/方案目录/solution.md', is_dir: false,
    },
  ] as any[], [{ key: 'design', label: '方案设计' }])

  assert.deepEqual(
    groups[0].rounds[0].artifacts.map((artifact) => artifact.name),
    ['方案目录'],
  )
})

test('defaults each step to its latest round while preserving a valid selection', () => {
  assert.equal(resolveArtifactRound([1, 2, 3], null), 3)
  assert.equal(resolveArtifactRound([1, 2, 3], 2), 2)
  assert.equal(resolveArtifactRound([1, 2, 3], 8), 3)
})

test('shows the real file suffix beside a logical artifact name', () => {
  assert.equal(artifactFileType(artifacts[0]), 'md')
  assert.equal(artifactFileType(artifacts[1]), 'json')
  assert.equal(artifactFileType(artifacts[3]), '')
})

test('keeps the file suffix in the left name group before right-side status', () => {
  const artifact = {
    ...artifacts[0],
    updated_at: '2026-09-22T08:30:00+08:00',
    is_latest: true,
    is_selected: true,
    manifest_status: 'ready',
    eligible_for_downstream: true,
    relative_path: 'result.md',
    size: 10,
  }
  const html = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(TaskArtifactBrowser, {
      artifacts: [artifact],
      steps: [{ key: 'build', label: '开发实现' }],
      onOpenArtifact: () => {},
    }),
  ))

  assert.match(
    html,
    /task-artifact-file-main[\s\S]*task-artifact-file-name[\s\S]*task-artifact-file-relative-path[\s\S]*task-artifact-file-type[\s\S]*task-artifact-file-updated-at[\s\S]*dateTime="2026-09-22T08:30:00\+08:00"[\s\S]*task-artifact-file-status/,
  )
})

test('shows relative paths so same-named files remain distinguishable', () => {
  const duplicateFiles = ['方案一', '方案二'].map((directory) => ({
    step_key: 'design', round: 1, name: 'solution.md', logical_name: null,
    path: `/artifacts/design/${directory}/solution.md`,
    relative_path: `${directory}/solution.md`,
    is_latest: true,
    is_selected: true,
    manifest_status: 'ready',
    eligible_for_downstream: true,
    size: 10,
  })) as any[]
  const html = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(TaskArtifactBrowser, {
      artifacts: duplicateFiles,
      steps: [{ key: 'design', label: '方案设计' }],
      onOpenArtifact: () => {},
    }),
  ))

  assert.match(html, /方案一\/solution\.md/)
  assert.match(html, /方案二\/solution\.md/)
})

test('shows a neutral unchanged marker on both the round tab and copied file', () => {
  const html = renderToStaticMarkup(createElement(
    I18nProvider, null,
    createElement(TaskArtifactBrowser, {
      artifacts: [{
        step_key: 'ui', round: 2, name: 'design.md', logical_name: '设计稿',
        path: '/artifacts/ui/2/design.md', relative_path: 'design.md',
        round_unchanged_from: 1, unchanged_from_round: 1,
      }] as any[],
      steps: [{ key: 'ui', label: '界面设计' }],
      onOpenArtifact: () => {},
    }),
  ))
  assert.match(html, /task-artifact-round-tab-label[\s\S]*同第1轮/)
  assert.match(html, /task-artifact-file-row[\s\S]*同第1轮/)
})

test('stacks step sections without a left sidebar and keeps compact visible round tabs', () => {
  const completeArtifacts = artifacts.slice(0, 2).map((artifact) => ({
    ...artifact,
    is_latest: true,
    is_selected: true,
    manifest_status: 'ready',
    eligible_for_downstream: true,
    relative_path: artifact.path,
    size: 10,
  }))
  const html = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(TaskArtifactBrowser, {
      artifacts: completeArtifacts,
      steps: [
        { key: 'req', label: '需求分析' },
        { key: 'build', label: '开发实现' },
      ],
      onOpenArtifact: () => {},
    }),
  ))

  assert.doesNotMatch(html, /task-artifact-step-tabs/)
  assert.equal((html.match(/task-artifact-step-section/g) || []).length, 2)
  assert.match(html, /需求分析/)
  assert.match(html, /开发实现/)
  assert.match(html, /task-artifact-round-tab-label/)

  const firstStepHeadingStart = html.indexOf('class="task-artifact-step-heading"')
  const firstStepHeading = html.slice(
    firstStepHeadingStart,
    html.indexOf('</div>', firstStepHeadingStart),
  )
  assert.match(firstStepHeading, /task-artifact-round-tabs/)
  assert.match(firstStepHeading, /task-artifact-step-title[\s\S]*ws-marquee/)
  assert.match(firstStepHeading, /task-artifact-round-tab-label">2 轮</)
  assert.doesNotMatch(firstStepHeading, /task-artifact-round-tab-label">第/)
})

test('shows task and step artifact directory actions when the project directory is available', () => {
  const html = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(TaskArtifactBrowser, {
      artifacts: artifacts as any,
      steps: [{ key: 'req', label: '需求分析' }, { key: 'build', label: '开发实现' }],
      projectId: 'project-one',
      artifactDirectory: '/project/.workstep/artifacts/workflow/task',
      onOpenArtifact: () => {},
    }),
  ))

  assert.equal((html.match(/class="task-artifact-open-directory(?: task-artifact-open-directory--step)?"/g) || []).length, 3)
  assert.match(html, /aria-label="需求分析[^\"]*打开目录"/)
  assert.match(html, /aria-label="开发实现[^\"]*打开目录"/)
  const reqHeading = html.slice(html.indexOf('class="task-artifact-step-heading"'))
  assert.ok(reqHeading.indexOf('task-artifact-round-tabs') < reqHeading.indexOf('aria-label="需求分析 打开目录"'))
  assert.match(html, /class="task-artifact-open-directory task-artifact-open-directory--step"[^>]*aria-label="需求分析 打开目录"[^>]*><svg/)
})

test('shared task also shows artifact directory actions without a project id', () => {
  const html = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(TaskArtifactBrowser, {
      artifacts: artifacts as any,
      steps: [{ key: 'req', label: '需求分析' }, { key: 'build', label: '开发实现' }],
      artifactDirectory: '/project/.workstep/artifacts/workflow/task',
      onOpenArtifact: () => {},
    }),
  ))

  assert.equal((html.match(/class="task-artifact-open-directory(?: task-artifact-open-directory--step)?"/g) || []).length, 3)
})

test('derives task and step directories from existing artifact paths when the API omits them', () => {
  const artifact = {
    step_key: 'req', round: 2, name: 'spec.md', logical_name: null,
    path: '/project/.workstep/artifacts/workflow/task/req/2/docs/spec.md',
    relative_path: 'docs/spec.md',
  } as any
  assert.deepEqual(artifactDirectories(artifact), {
    task: '/project/.workstep/artifacts/workflow/task',
    step: '/project/.workstep/artifacts/workflow/task/req',
  })

  const html = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(TaskArtifactBrowser, {
      artifacts: [artifact],
      steps: [{ key: 'req', label: '需求分析' }],
      projectId: 'project-one',
      onOpenArtifact: () => {},
    }),
  ))
  assert.equal((html.match(/class="task-artifact-open-directory(?: task-artifact-open-directory--step)?"/g) || []).length, 2)
})
