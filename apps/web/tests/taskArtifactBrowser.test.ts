import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import TaskArtifactBrowser, {
  artifactFileType,
  buildArtifactStageGroups,
  resolveArtifactRound,
} from '../src/components/TaskArtifactBrowser.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const artifacts = [
  { step_key: 'build', round: 3, name: 'result.md', logical_name: '成品', path: 'result.md' },
  { step_key: 'req', round: 2, name: 'spec.json', logical_name: '需求规格', path: 'spec.json' },
  { step_key: 'req', round: 1, name: 'draft.md', logical_name: '需求草稿', path: 'draft.md' },
  { step_key: 'build', round: 1, name: 'source', logical_name: '源码', path: 'source', is_dir: true },
] as any[]

test('groups artifacts by workflow stage and sorts rounds from small to large', () => {
  const groups = buildArtifactStageGroups(artifacts, [
    { key: 'req', label: '需求分析' },
    { key: 'build', label: '开发实现' },
  ])

  assert.deepEqual(groups.map((group) => group.key), ['req', 'build'])
  assert.deepEqual(groups[0].rounds.map((round) => round.round), [1, 2])
  assert.deepEqual(groups[1].rounds.map((round) => round.round), [1, 3])
})

test('defaults each stage to its latest round while preserving a valid selection', () => {
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
      stages: [{ key: 'build', label: '开发实现' }],
      onOpenArtifact: () => {},
    }),
  ))

  assert.match(
    html,
    /task-artifact-file-main[\s\S]*task-artifact-file-name[\s\S]*task-artifact-file-type[\s\S]*task-artifact-file-status/,
  )
})

test('stacks stage sections without a left sidebar and keeps compact visible round tabs', () => {
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
      stages: [
        { key: 'req', label: '需求分析' },
        { key: 'build', label: '开发实现' },
      ],
      onOpenArtifact: () => {},
    }),
  ))

  assert.doesNotMatch(html, /task-artifact-stage-tabs/)
  assert.equal((html.match(/task-artifact-stage-section/g) || []).length, 2)
  assert.match(html, /需求分析/)
  assert.match(html, /开发实现/)
  assert.match(html, /task-artifact-round-tab-label/)
})
