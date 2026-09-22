import assert from 'node:assert/strict'
import test from 'node:test'
import { filterSidebarProject } from '../src/utils/sidebarSearch.ts'

const project = {
  name: 'workstep',
  workflows: [
    { id: 'flow-1', name: '研发流程' },
    { id: 'flow-2', name: '发布流程' },
  ],
}

const sessions = [
  { id: 'chat-1', title: '分析功能对齐' },
  { id: 'chat-2', title: '页面崩溃' },
]

test('sidebar search independently filters workflows and conversations', () => {
  const workflowResult = filterSidebarProject(project, sessions, '研发')
  assert.equal(workflowResult.visible, true)
  assert.deepEqual(workflowResult.workflows.map((item) => item.id), ['flow-1'])
  assert.deepEqual(workflowResult.sessions, [])

  const conversationResult = filterSidebarProject(project, sessions, '功能')
  assert.equal(conversationResult.visible, true)
  assert.deepEqual(conversationResult.workflows, [])
  assert.deepEqual(conversationResult.sessions.map((item) => item.id), ['chat-1'])
})

test('sidebar search keeps a matching project without unrelated children', () => {
  const result = filterSidebarProject(project, sessions, 'WORKSTEP')
  assert.equal(result.visible, true)
  assert.equal(result.projectMatches, true)
  assert.deepEqual(result.workflows, [])
  assert.deepEqual(result.sessions, [])
})

test('blank sidebar search restores every item', () => {
  const result = filterSidebarProject(project, sessions, '  ')
  assert.equal(result.visible, true)
  assert.equal(result.projectMatches, true)
  assert.equal(result.workflows.length, 2)
  assert.equal(result.sessions.length, 2)
})
