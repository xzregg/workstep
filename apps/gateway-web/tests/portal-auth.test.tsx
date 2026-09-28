import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { PortalAuthPage, validPortalAccount, safeNextPath } from '../src/PortalAuthPage'
import { ProjectCard } from '../src/ProjectsPage'

test('portal account validation follows the Gateway schema', () => {
  assert.equal(validPortalAccount('alice', 'Alice', 'long-password-123'), true)
  assert.equal(validPortalAccount('A lice', 'Alice', 'long-password-123'), false)
  assert.equal(validPortalAccount('alice', ' ', 'long-password-123'), false)
  assert.equal(validPortalAccount('alice', 'Alice', 'short'), false)
})

test('login return path stays on this Gateway', () => {
  assert.equal(safeNextPath('/devices'), '/devices')
  assert.equal(safeNextPath('//evil.example'), '/')
  assert.equal(safeNextPath('https://evil.example'), '/')
  assert.equal(safeNextPath('/desktop/login?state=x'), '/desktop/login?state=x')
})

test('portal auth page starts with a loading state', () => {
  const html = renderToString(<MemoryRouter><PortalAuthPage /></MemoryRouter>)
  assert.match(html, /正在检查平台状态/)
})

test('project card identifies host, grant origin, access level and offline state', () => {
  const html = renderToString(<ProjectCard project={{ id: 'p1', name: '项目甲', device_id: 'd1',
    device_name: '研发电脑', device_online: false, access_level: 'read',
    grant_sources: ['用户组：研发'] }} opening={false} onOpen={() => {}} />)
  assert.match(html, /研发电脑/)
  assert.match(html, /用户组：研发/)
  assert.match(html, /只读/)
  assert.match(html, /离线/)
  assert.match(html, /disabled/)
})
