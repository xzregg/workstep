import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { GroupSkillsPage } from '../src/GroupSkillsPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/groups',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('group leader assigns approved version and revokes only own project source', async () => {
  const writes: Array<{ url: string; method: string; csrf: string; body?: unknown }> = []
  let assigned = false
  let conflict = true
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-leader' })
    if (url === '/api/groups') return Response.json({ groups: [
      { id: 'group-1', name: '研发组', slug: 'dev', source_type: 'manual' },
    ] })
    if (url === '/api/groups/group-1/projects') return Response.json({ projects: [
      { id: 'project-1', name: '项目一', purpose: 'skill_management' },
    ] })
    if (url === '/api/groups/group-1/skills') return Response.json({ skills: [
      { skill_id: 'skill-1', name: '审核 Skill', slug: 'review',
        skill_version_id: 'version-1', version: '1.0.0', digest: 'abc' },
    ] })
    if (url === '/api/groups/group-1/projects/project-1/skills' && !init?.method) {
      return Response.json({ desired_revision: assigned ? 2 : 0, applied_revision: null,
        status: 'pending', last_error_code: null, skills: assigned ? [{
          skill_id: 'skill-1', name: '审核 Skill', skill_version_id: 'version-1',
          version: '1.0.0', desired_revision: 2,
        }] : [] })
    }
    if (url === '/api/groups/group-1/projects/project-1/skills' && init?.method === 'POST') {
      writes.push({ url, method: 'POST', csrf: String((init.headers as Record<string, string>)['X-CSRF-Token']),
        body: JSON.parse(String(init.body)) })
      if (conflict) { conflict = false; return new Response(null, { status: 409 }) }
      assigned = true
      return Response.json({ desired_revision: 2 })
    }
    if (url === '/api/groups/group-1/projects/project-1/skills/skill-1'
        && init?.method === 'DELETE') {
      writes.push({ url, method: 'DELETE', csrf: String((init.headers as Record<string, string>)['X-CSRF-Token']) })
      assigned = false
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><GroupSkillsPage /></MemoryRouter>)
  await screen.findByRole('option', { name: '研发组' })
  fireEvent.change(screen.getByLabelText('用户组'), { target: { value: 'group-1' } })
  await screen.findByRole('option', { name: '项目一' })
  fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'project-1' } })
  await screen.findByRole('option', { name: '审核 Skill · 1.0.0' })
  fireEvent.change(screen.getByLabelText('可用 Skill 版本'), { target: { value: 'version-1' } })
  fireEvent.click(screen.getByRole('button', { name: '分配 Skill' }))
  await screen.findByRole('alert')
  assert.match(screen.getByRole('alert').textContent ?? '', /版本冲突/)
  fireEvent.click(screen.getByRole('button', { name: '分配 Skill' }))
  await screen.findByText(/审核 Skill · 1.0.0 · 来源：当前用户组/)
  assert.deepEqual(writes[0], { url: '/api/groups/group-1/projects/project-1/skills',
    method: 'POST', csrf: 'csrf-leader', body: { skill_version_id: 'version-1' } })
  fireEvent.click(screen.getByRole('button', { name: '撤销审核 Skill' }))
  const dialog = await screen.findByRole('dialog', { name: '撤销项目 Skill' })
  fireEvent.click((await import('@testing-library/dom')).getByRole(dialog, 'button', { name: '确认撤销' }))
  await waitFor(() => assert.equal(assigned, false))
  assert.deepEqual(writes.at(-1), { url: '/api/groups/group-1/projects/project-1/skills/skill-1',
    method: 'DELETE', csrf: 'csrf-leader' })
})
