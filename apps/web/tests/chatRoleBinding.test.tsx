import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import ChatInput from '../src/components/ChatInput'
import ChatRoleBinding from '../src/components/role-center/ChatRoleBinding'
import { roleCenterApi } from '../src/api/roleCenter'
import { chatRoleApi } from '../src/api/chatRoles'

const role = { id: 'architect', name: '架构专家', category: 'engineering', description: '架构评审', prompt: '专业架构提示词', builtin: true, source: null, revision: 'a', updated_at: '' }
const team = { id: 'reviewers', name: '评审团', description: '综合评审', prompt: '团队约定', members: [{ role_id: role.id, duty: '先评估结构' }], revision: 'b', updated_at: '' }

test('plus menu loads a role, keeps it across session switches and removes only its own binding', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const oldRoles = { ...roleCenterApi }, oldChat = { ...chatRoleApi }
  const bindings = new Map<string, { binding: { kind: 'role' | 'team'; id: string } | null; name: string; missing: boolean }>()
  const calls: string[] = []
  roleCenterApi.catalog = async () => { calls.push('catalog'); return { roles: [role], teams: [team], categories: [{ id: 'engineering', name: '工程开发' }], warnings: [] } }
  roleCenterApi.getRole = async () => role
  roleCenterApi.getTeam = async () => team
  chatRoleApi.get = async (sid) => bindings.get(sid) || { binding: null, name: '', missing: false }
  chatRoleApi.set = async (sid, _pid, binding) => {
    const state = { binding, name: binding?.kind === 'team' ? team.name : binding ? role.name : '', missing: false }
    bindings.set(sid, state); return state
  }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const render = async (sid: string, running = false) => act(async () => root.render(<I18nProvider>
    <ChatRoleBinding key={sid} sessionId={sid} projectId="project" running={running}>
      {roleBinding => <ChatInput value="用户问题" onChange={() => {}} onSend={() => {}} roleBinding={roleBinding} />}
    </ChatRoleBinding>
  </I18nProvider>))
  const click = async (label: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
    assert.ok(button, label); button.click()
  })
  try {
    await render('one')
    // Roles remain available even when the composer has no attachment capability.
    await click('添加附件')
    await click('角色／专家团')
    assert.equal(calls.length, 1)
    await click('选择角色：架构专家')
    assert.match(document.body.textContent!, /专业架构提示词/)
    await click('加载到对话')
    assert.deepEqual(bindings.get('one')!.binding, { kind: 'role', id: 'architect' })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.ok(document.querySelector('[aria-label="查看已加载角色：架构专家"]'))
    await render('two')
    assert.equal(document.querySelector('[aria-label="查看已加载角色：架构专家"]'), null)
    await render('one')
    assert.ok(document.querySelector('[aria-label="查看已加载角色：架构专家"]'))
    await render('one', true)
    assert.equal((document.querySelector('[aria-label="移除已加载角色"]') as HTMLButtonElement).disabled, true)
    await render('one')
    await click('移除已加载角色')
    assert.equal(bindings.get('one')!.binding, null)
  } finally {
    await act(async () => root.unmount())
    Object.assign(roleCenterApi, oldRoles); Object.assign(chatRoleApi, oldChat)
    await window.happyDOM.close()
  }
})

test('binding save failure retains selection, team preview includes member duties, disabled surfaces make no requests', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const oldRoles = { ...roleCenterApi }, oldChat = { ...chatRoleApi }
  let gets = 0, failed = true
  chatRoleApi.get = async () => { gets++; return { binding: null, name: '', missing: false } }
  chatRoleApi.set = async (_sid, _pid, binding) => {
    if (failed) throw new Error('保存失败，请重试。')
    return { binding, name: team.name, missing: false }
  }
  roleCenterApi.catalog = async () => ({ roles: [role], teams: [team], categories: [], warnings: [] })
  roleCenterApi.getRole = async () => role
  roleCenterApi.getTeam = async () => team
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = async (enabled: boolean) => act(async () => root.render(<I18nProvider><ChatRoleBinding key={String(enabled)} enabled={enabled} sessionId="one" projectId="project" running={false}>
    {roleBinding => <ChatInput value="草稿" onChange={() => {}} onSend={() => {}} roleBinding={roleBinding} />}
  </ChatRoleBinding></I18nProvider>))
  const click = async (text: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
    assert.ok(button, text); button.click()
  })
  try {
    await render(false); assert.equal(gets, 0)
    await render(true)
    await click('添加附件'); await click('角色／专家团'); await click('专家团')
    await click('选择专家团：评审团')
    assert.match(document.body.textContent!, /先评估结构/)
    await click('加载到对话')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /保存失败/)
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '草稿')
    failed = false; await click('加载到对话')
    assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally {
    await act(async () => root.unmount())
    Object.assign(roleCenterApi, oldRoles); Object.assign(chatRoleApi, oldChat)
    await window.happyDOM.close()
  }
})
