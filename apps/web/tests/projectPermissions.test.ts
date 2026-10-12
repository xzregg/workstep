import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveProjectPermissions } from '../src/utils/projectPermissions'
const session = { host_project_id: 'host', access_level: 'edit' as const, task_create: true, share_create: false }
test('task creator can submit but cannot edit workflows, files, Git or sessions', () => {
 const p = resolveProjectPermissions(true, { ...session, permissions: ['task.read', 'task.create', 'workflow.read'] }, 'host')
 assert.equal(p.can('task.create'), true)
 for (const key of ['workflow.edit','file.edit','file.manage','git.write','session.create','session.chat','task.chat','task.start_on_create']) assert.equal(p.can(key), false, key)
 assert.equal(p.can('workflow.read'), true)
})
test('local/device behavior is preserved; loading and wrong-project access fail closed', () => {
 assert.equal(resolveProjectPermissions(false, null, 'host').can('workflow.edit'), true)
 assert.equal(resolveProjectPermissions(true, { ...session, host_project_id: null }, 'host').can('workflow.edit'), true)
 assert.equal(resolveProjectPermissions(true, null, 'host').can('task.create'), false)
 assert.equal(resolveProjectPermissions(true, session, 'other').can('task.create'), false)
})
test('legacy read/edit grants work but explicit empty permissions never fall back', () => {
 assert.equal(resolveProjectPermissions(true, session, 'host').can('workflow.edit'), true)
 assert.equal(resolveProjectPermissions(true, { ...session, access_level: 'read' }, 'host').can('workflow.read'), true)
 assert.equal(resolveProjectPermissions(true, { ...session, access_level: 'read' }, 'host').can('workflow.edit'), false)
 assert.equal(resolveProjectPermissions(true, { ...session, permissions: [] }, 'host').can('workflow.edit'), false)
 assert.equal(resolveProjectPermissions(true, { ...session, permissions: ['share.create'] }, 'host').can('share.create'), false)
 assert.equal(resolveProjectPermissions(true, { ...session, task_create: false, permissions: ['task.create'] }, 'host').can('task.create'), false)
})
