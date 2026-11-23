import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SkillCenterSettings from '../src/pages/SkillCenterSettings'
import { skillApi, type SkillDescriptor } from '../src/api/client'

test('skill status combines with search and source, limits select-all, and follows saved changes', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const project = { id: 'demo', name: 'Demo', path: '/demo', steps: {}, workflows: [] }
  let skills: SkillDescriptor[] = [
    ['a', 'Alpha enabled', 'agents', true],
    ['b', 'Alpha disabled', 'agents', false],
    ['c', 'Other disabled', 'claude', false],
  ].map(([id, name, source, enabled]) => ({ skill_id: String(id), name: String(name), source: String(source), enabled: Boolean(enabled),
    description: 'Demo skill', source_path: `/demo/${id}/SKILL.md`, valid: true, conflict: false, sync_status: enabled ? 'synced' : 'disabled' }))
  const result = () => ({ project_id: project.id, project_name: project.name, project_path: project.path,
    compatible_engines: [], takes_effect: 'next_run' as const, skills })
  const original = { list: skillApi.list, setEnabled: skillApi.setEnabled, setEnabledBatch: skillApi.setEnabledBatch }
  let lists = 0
  const batches: string[][] = []
  skillApi.list = async () => { lists++; return result() }
  skillApi.setEnabled = async (_project, id, enabled) => {
    skills = skills.map(skill => skill.skill_id === id ? { ...skill, enabled } : skill)
    return result()
  }
  skillApi.setEnabledBatch = async (_project, ids, enabled) => {
    batches.push(ids)
    skills = skills.map(skill => ids.includes(skill.skill_id) ? { ...skill, enabled } : skill)
    return result()
  }
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  const render = async (id = 'demo') => act(async () => root.render(<MemoryRouter><I18nProvider><SkillCenterSettings project={{ ...project, id }} /></I18nProvider></MemoryRouter>))
  const choose = async (label: string, value: string) => {
    const select = [...element.querySelectorAll('select')].find(node => node.closest('label')?.textContent?.includes(label))
    assert.ok(select, label)
    await act(async () => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
  }
  const rows = () => [...element.querySelectorAll<HTMLInputElement>('[role="switch"]')].map(node => node.getAttribute('aria-label'))
  try {
    await render()
    assert.equal(rows().length, 3)
    await choose('开启状态', 'enabled')
    assert.deepEqual(rows(), ['Alpha enabled 关闭'])
    await choose('开启状态', 'disabled')
    assert.deepEqual(rows(), ['Alpha disabled 开启', 'Other disabled 开启'])
    await choose('按来源筛选', 'agents')
    assert.deepEqual(rows(), ['Alpha disabled 开启'])
    const search = element.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'Other')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(rows().length, 0)
    assert.match(element.textContent ?? '', /没有符合搜索条件/)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'Alpha')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.deepEqual(rows(), ['Alpha disabled 开启'])
    await act(async () => element.querySelector<HTMLInputElement>('[aria-label="选择当前结果"]')!.click())
    const enable = [...element.querySelectorAll('button')].find(node => node.textContent === '开启所选')!
    await act(async () => enable.click())
    assert.deepEqual(batches, [['b']])
    assert.equal(rows().length, 0)
    await choose('开启状态', 'enabled')
    assert.equal(rows().length, 2)
    await act(async () => element.querySelector<HTMLInputElement>('[aria-label="Alpha enabled 关闭"]')!.click())
    assert.deepEqual(rows(), ['Alpha disabled 关闭'])
    assert.equal(lists, 1, 'filtering uses the loaded list')
    await render('other-project')
    assert.equal(rows().length, 3, 'project changes reset all filters')
  } finally {
    await act(async () => root.unmount())
    Object.assign(skillApi, original)
    await window.happyDOM.close()
  }
})
