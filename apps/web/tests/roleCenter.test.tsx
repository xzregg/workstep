import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import RoleCenterSettings from '../src/pages/RoleCenterSettings'
import { roleCenterApi, type RoleDocument, type TeamDocument } from '../src/api/roleCenter'

const roles: RoleDocument[] = [
  { id: 'architect', name: '架构专家', category: 'engineering', description: '评审技术方案',
    prompt: '原始架构提示词', builtin: true, source: null, revision: 'a'.repeat(64), updated_at: '' },
  { id: 'security', name: '安全专家', category: 'security', description: '评审权限边界',
    prompt: '原始安全提示词', builtin: true, source: null, revision: 'b'.repeat(64), updated_at: '' },
]

async function fixture(run: (context: {
  click: (text: string) => Promise<void>
  input: (label: string, value: string) => Promise<void>
  savedRoles: unknown[]
  savedTeams: unknown[]
}) => Promise<void>) {
  const { window } = installDomEnvironment()
  const old = { ...roleCenterApi }
  const savedRoles: unknown[] = [], savedTeams: unknown[] = []
  let catalogCalls = 0
  let documents = structuredClone(roles), teams: TeamDocument[] = []
  roleCenterApi.catalog = async () => {
    catalogCalls++
    return { categories: [{ id: 'engineering', name: '工程开发' }, { id: 'security', name: '安全' }],
      roles: documents, teams, warnings: [] }
  }
  roleCenterApi.getRole = async (id) => structuredClone(documents.find(r => r.id === id)!)
  roleCenterApi.getTeam = async (id) => structuredClone(teams.find(t => t.id === id)!)
  roleCenterApi.saveRole = async (payload, id) => {
    savedRoles.push(payload)
    const result = { ...documents.find(r => r.id === id), ...payload, id: id || 'custom',
      builtin: Boolean(id), source: null, revision: 'c'.repeat(64), updated_at: '' }
    documents = [...documents.filter(r => r.id !== result.id), result]
    return result
  }
  roleCenterApi.saveTeam = async (payload, id) => {
    savedTeams.push(payload)
    const result = { ...payload, id: id || 'team', revision: 'd'.repeat(64), updated_at: '' }
    teams = [...teams.filter(t => t.id !== result.id), result]
    return result
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><RoleCenterSettings /></I18nProvider></MemoryRouter>))
    const click = async (text: string) => act(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)
      assert.ok(button, `button: ${text}`); button.click()
    })
    const input = async (label: string, value: string) => act(async () => {
      const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
      assert.ok(element, `input: ${label}`)
      const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(catalogCalls, 1, 'single catalog request per mount')
    await run({ click, input, savedRoles, savedTeams })
  } finally {
    await act(async () => root.unmount())
    Object.assign(roleCenterApi, old)
    await window.happyDOM.close()
  }
}

test('role library filters categories and searches, then persists an edited prompt', async () => {
  await fixture(async ({ click, input, savedRoles }) => {
    assert.equal(document.querySelectorAll('.role-center-card').length, 2)
    await click('安全')
    assert.equal(document.querySelectorAll('.role-center-card').length, 1)
    await click('全部角色')
    await input('搜索角色', '架构')
    assert.equal(document.querySelectorAll('.role-center-card').length, 1)
    await click('编辑角色：架构专家')
    await input('角色提示词', '# 架构\n新增验证条件')
    await click('保存角色')
    assert.equal(savedRoles.length, 1)
    assert.equal((savedRoles[0] as any).prompt, '# 架构\n新增验证条件')
    assert.equal((savedRoles[0] as any).expected_revision, 'a'.repeat(64))
    assert.equal(document.querySelector('.role-center-editor-overlay'), null)
  })
})

test('role cards override global button centering and no-wrap styles', async () => {
  await fixture(async () => {
    const styles = document.createElement('style')
    styles.textContent = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
      + '\n' + readFileSync(new URL('../src/pages/RoleCenterSettings.css', import.meta.url), 'utf8')
    document.head.append(styles)
    const card = document.querySelector<HTMLElement>('.role-center-card')!
    const computed = getComputedStyle(card)
    assert.equal(computed.whiteSpace, 'normal')
    assert.equal(computed.alignItems, 'stretch')
    assert.equal(computed.justifyContent, 'flex-start')
    assert.equal(parseFloat(computed.minWidth), 0)
    const description = card.querySelector<HTMLElement>('.role-center-card-description')!
    assert.equal(getComputedStyle(description).whiteSpace, 'normal')
    assert.equal(getComputedStyle(description).overflow, 'hidden')
    styles.remove()
  })
})

test('mobile settings control sizing excludes role cards', () => {
  const css = readFileSync(new URL('../src/mobile.css', import.meta.url), 'utf8')
  for (const scope of ['settings-layout', 'settings-content', 'project-settings-layout']) {
    assert.ok(css.includes(`.${scope} button:not(.btn-icon):not(.role-center-card)`))
  }
})

test('custom role required fields, failed save recovery and unsaved close protection', async () => {
  await fixture(async ({ click, input, savedRoles }) => {
    await click('新增角色')
    const create = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '创建角色')!
    assert.equal(create.disabled, true)
    await input('角色名称', '检索专家')
    await input('角色提示词', '评估检索质量')
    const save = roleCenterApi.saveRole
    roleCenterApi.saveRole = async () => { throw new Error('磁盘暂时不可用') }
    await click('创建角色')
    assert.match(document.querySelector('.role-center-editor-error')!.textContent!, /磁盘暂时不可用/)
    assert.equal((document.querySelector('[aria-label="角色提示词"]') as HTMLTextAreaElement).value, '评估检索质量')
    await click('关闭角色编辑')
    assert.match(document.body.textContent!, /放弃未保存的修改/)
    await click('继续编辑')
    roleCenterApi.saveRole = save
    await click('创建角色')
    assert.equal(savedRoles.length, 1)
    await click('编辑角色：检索专家')
    assert.equal((document.querySelector('[aria-label="角色提示词"]') as HTMLTextAreaElement).value, '评估检索质量')
    await input('角色提示词', '未保存内容')
    await click('关闭角色编辑')
    await click('放弃修改')
    assert.equal(document.querySelector('.role-center-editor-overlay'), null)
  })
})

test('expert team saves its prompt, referenced members, duties and order', async () => {
  await fixture(async ({ click, input, savedTeams }) => {
    await click('专家团')
    await click('新增专家团')
    await input('专家团名称', '方案评审团')
    await input('专家团提示词', 'A 先提出方案，B 随后审核，再由 A 汇总。')
    const split = document.querySelector<HTMLButtonElement>('.role-center-split-handle')!
    assert.equal(split.getAttribute('aria-valuenow'), '50')
    await act(async () => split.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(split.getAttribute('aria-valuenow'), '52')
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '创建专家团')!.disabled, true)
    for (const id of ['architect', 'security']) await act(async () => {
      document.querySelector<HTMLInputElement>(`[data-role-id="${id}"]`)!.click()
    })
    await input('架构专家的分工', '先设计架构')
    await click('上移安全专家')
    await click('创建专家团')
    assert.equal(savedTeams.length, 1)
    const saved = savedTeams[0] as any
    assert.match(saved.prompt, /B 随后审核/)
    assert.deepEqual(saved.members.map((m: any) => m.role_id), ['security', 'architect'])
    assert.equal(saved.members[1].duty, '先设计架构')
    assert.ok(!('prompt' in saved.members[0]), 'member does not duplicate role prompt')
    await click('编辑专家团：方案评审团')
    assert.match((document.querySelector('[aria-label="专家团提示词"]') as HTMLTextAreaElement).value, /A 先提出方案/)
  })
})

test('failed role detail load is retryable without opening a blank editable draft', async () => {
  await fixture(async ({ click }) => {
    const get = roleCenterApi.getRole
    roleCenterApi.getRole = async () => { throw new Error('读取失败') }
    await click('编辑角色：架构专家')
    assert.match(document.querySelector('.role-center-editor-error')!.textContent!, /读取失败/)
    assert.equal(document.querySelector('[aria-label="角色提示词"]'), null)
    roleCenterApi.getRole = get
    await click('重试')
    assert.equal((document.querySelector('[aria-label="角色提示词"]') as HTMLTextAreaElement).value, '原始架构提示词')
  })
})
