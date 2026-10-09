import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SandboxSettings from '../src/components/SandboxSettings'
import SettingsNavigation from '../src/components/SettingsNavigation'
import type { SandboxStatus, SandboxBridge } from '../src/utils/desktopSandbox'

test('sandbox preparation is explicit, mode switching confirms, and failures preserve retry', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  let current: SandboxStatus = { settings: { enabled: false, root: '', project: '', mounts: [] }, phase: 'idle', progress: null, error: null, running: false, supported: true }
  let reads = 0, prepared = 0, switches = 0, selected = 0, fail = true, software = 0, images = 0
  let migration: unknown
  const choices = ['/sandbox', '/project']
  window.workstepDesktop = { notify() {}, sandbox: {
    status: async () => { reads++; return current },
    dockerImages: async () => ({ images: [], error: null }),
    hostProjects: async () => [{ path: '/project', name: 'Existing', id: 'old' }],
    chooseDirectory: async () => choices[selected++]!,
    prepareRuntime: async ({ root }) => { software++; current = { ...current, runtimeReady: true, settings: { ...current.settings, root } }; return current },
    prepareImage: async () => { images++; if (fail) throw new Error('下载失败'); current = { ...current, imageReady: true }; return current },
    migrateSettings: async options => { migration = options; return current },
    prepare: async settings => {
      prepared++
      current = { ...current, phase: 'ready', settings: { ...settings, prepared: true } }; return current
    },
    switchMode: async () => { switches++ },
    switchImage: async () => {},
    importConfig: async () => current, remove: async () => current, logs: async () => {}, readLogs: async () => '', copyLogs: async () => {},
  } }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!
  try {
    await act(async () => root.render(<I18nProvider><SandboxSettings /></I18nProvider>))
    assert.equal(reads, 1)
    assert.equal(button('下一步').disabled, true)
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '选择目录')!.click())
    await act(async () => button('下载并准备辅助软件').click())
    assert.equal(software, 1); assert.equal(images, 0)
    await act(async () => button('下一步').click())
    assert.equal(prepared, 0)
    await act(async () => button('下载推荐镜像').click())
    assert.match(document.body.textContent!, /下载失败/)
    assert.equal(button('下载推荐镜像').disabled, false)
    assert.equal(button('下一步').disabled, true)
    fail = false
    await act(async () => button('下载推荐镜像').click())
    await act(async () => button('下一步').click())
    assert.match(document.body.textContent!, /Existing/)
    assert.match(document.body.textContent!, /不会.*清空/)
    await act(async () => button('下一步').click())
    assert.match(document.body.textContent!, /目录配置自动排除/)
    await act(async () => button('下一步').click())
    assert.equal(button('确认并重启').disabled, true)
    await act(async () => (document.querySelector('#sandbox-ack') as HTMLInputElement).click())
    await act(async () => button('确认并重启').click())
    assert.equal(switches, 0)
    assert.ok(document.querySelector('[role="dialog"]'))
    await act(async () => button('确认').click())
    assert.equal(switches, 1)
    assert.equal(prepared, 1)
    assert.deepEqual(migration, { providers: true, engines: true, preferences: true, overwrite: false })
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('sandbox entry is last in desktop settings and hidden in ordinary browser', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  window.workstepDesktop = { notify() {}, sandbox: {} as SandboxBridge }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><SettingsNavigation activeSection="sandbox" onSelect={() => {}} /></I18nProvider>))
    assert.equal(document.querySelector('.settings-nav-button:last-child')?.textContent, '沙箱')
    delete window.workstepDesktop
    await act(async () => root.render(<I18nProvider><SettingsNavigation activeSection="system" onSelect={() => {}} /></I18nProvider>))
    assert.ok(![...document.querySelectorAll('.settings-nav-button')].some(b => b.textContent === '沙箱'))
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('ordinary browser has no sandbox controls', async () => {
  const { document, window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><SandboxSettings /></I18nProvider>))
    assert.equal(document.body.textContent, '')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('prepared sandbox shows runtime health, port, phase, and log location', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const current: SandboxStatus = { settings: { enabled: true, prepared: true, root: '/sandbox', project: '/project', mounts: [], dockerImage: 'sha256:old' }, phase: 'running', progress: null, error: null, running: true, health: 'healthy', hostPort: 8766, logDirectory: '/sandbox/desktop', supported: true }
  let copied = 0
  window.workstepDesktop = { notify() {}, sandbox: {
    status: async () => current, hostProjects: async () => [], dockerImages: async () => ({ images: [], error: null }), chooseDirectory: async () => null,
    prepareRuntime: async () => current, prepareImage: async () => current, prepare: async () => current,
    migrateSettings: async () => current, switchMode: async () => {}, switchImage: async () => {}, importConfig: async () => current,
    remove: async () => current, logs: async () => {}, readLogs: async () => '启动阶段日志\nphase=error\n容器日志\nImportError', copyLogs: async () => { copied++ },
  } }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><SandboxSettings /></I18nProvider>))
    assert.match(document.body.textContent!, /运行状态运行正常/)
    assert.match(document.body.textContent!, /当前阶段运行中/)
    assert.match(document.body.textContent!, /后台端口8766/)
    assert.match(document.body.textContent!, /日志目录\/sandbox\/desktop/)
    const imageButton = [...document.querySelectorAll('button')].find(button => button.textContent === '更换镜像')!
    assert.equal(imageButton.disabled, false)
    await act(async () => imageButton.click())
    assert.ok(document.querySelector('#sandbox-image'))
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '查看日志')!.click())
    assert.match(document.body.textContent!, /ImportError/)
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '复制日志')!.click())
    assert.equal(copied, 1)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('saving never switches mode, failed migration remains retryable, and initial suggested projects are not dirty', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  let current: SandboxStatus = { settings: { enabled: false, root: '/sandbox', project: '', mounts: [] }, phase: 'imageReady', progress: null, error: null, running: false, supported: true, runtimeReady: true, imageReady: true }
  let fail = true, switches = 0, migrations = 0, dirty = true
  window.workstepDesktop = { notify() {}, sandbox: {
    status: async () => current, hostProjects: async () => [{ path: '/project', name: 'Existing' }], dockerImages: async () => ({ images: [], error: null }), chooseDirectory: async () => null,
    prepareRuntime: async () => current, prepareImage: async () => current,
    prepare: async settings => { current = { ...current, settings: { ...settings, prepared: true } }; return current },
    migrateSettings: async () => { migrations++; if (fail) throw new Error('配置导入失败'); return current },
    switchMode: async () => { switches++ }, switchImage: async () => {}, importConfig: async () => current, remove: async () => current, logs: async () => {}, readLogs: async () => '', copyLogs: async () => {},
  } }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!
  try {
    await act(async () => root.render(<I18nProvider><SandboxSettings onDirtyChange={value => { dirty = value }} /></I18nProvider>))
    assert.equal(dirty, false)
    for (let i = 0; i < 4; i++) await act(async () => button('下一步').click())
    await act(async () => button('仅保存，稍后开启').click())
    assert.match(document.body.textContent!, /配置导入失败/)
    assert.equal(switches, 0)
    assert.equal(button('仅保存，稍后开启').disabled, false)
    fail = false
    await act(async () => button('仅保存，稍后开启').click())
    assert.equal(migrations, 2)
    assert.equal(switches, 0)
    assert.match(document.body.textContent!, /沙箱环境已准备/)
    assert.equal(dirty, false)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
