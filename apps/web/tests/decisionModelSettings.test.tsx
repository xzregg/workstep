import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import DecisionModelSettings from '../src/pages/DecisionModelSettings'
import { decisionModelsApi, type DecisionStatus } from '../src/api/decisionModels'

function initial(): DecisionStatus {
  const resource = { stage: 'idle', downloaded_bytes: 0, total_bytes: null, error: '', installed: false, size_bytes: null }
  return { environment: { supported: true, reasons: [], cpu_cores: 4, memory_total_bytes: 8589934592, memory_available_bytes: 4294967296, disk_free_bytes: 10737418240 }, settings: { mode: 'managed', base_url: '', model: '', has_api_key: false }, root: '/config/decision-models', platform: 'Darwin · arm64', worker: 'stopped',
    resources: { runtime: { ...resource, path: '/config/decision-models/runtime' }, model: { ...resource, path: '/config/decision-models/models/laya-multilingual', size_bytes: 678201636 } } }
}
test('settings reads once, exposes real paths and only downloads the clicked resource', async () => {
  const { window } = installDomEnvironment(); const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...decisionModelsApi }; let reads = 0; const downloads: string[] = []; const status = initial()
  decisionModelsApi.status = async () => { reads++; return structuredClone(status) }
  decisionModelsApi.download = async kind => { downloads.push(kind); status.resources[kind].installed = true; return structuredClone(status) }
  try {
    await act(async () => root.render(<I18nProvider><DecisionModelSettings /></I18nProvider>))
    assert.equal(reads, 1); assert.deepEqual(downloads, [])
    assert.match(document.body.textContent!, /\/config\/decision-models\/models\/laya-multilingual/)
    const find = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!
    assert.equal(find('测试本地推理').disabled, true)
    await act(async () => find('下载组件').click())
    assert.deepEqual(downloads, ['runtime']); assert.equal(find('测试本地推理').disabled, true)
    await act(async () => find('下载模型').click())
    assert.deepEqual(downloads, ['runtime', 'model']); assert.equal(find('测试本地推理').disabled, false)
  } finally { Object.assign(decisionModelsApi, original); await act(async () => root.unmount()); await window.happyDOM.close() }
})
test('external configuration validates drafts, tests without saving and reports dirty state', async () => {
  const { window } = installDomEnvironment(); const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...decisionModelsApi }; const status = initial(); let saved = 0; let tested = 0; let dirty = false
  decisionModelsApi.status = async () => structuredClone(status)
  decisionModelsApi.save = async draft => { saved++; status.settings = { ...draft, has_api_key: false }; return structuredClone(status) }
  decisionModelsApi.test = async draft => { tested++; return { success: true, elapsed_ms: 12, mode: draft.mode } }
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!
  function fill(id: string, value: string) { const input = document.getElementById(id) as HTMLInputElement; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!; setter.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })) }
  try {
    await act(async () => root.render(<I18nProvider><DecisionModelSettings onDirtyChange={value => { dirty = value }} /></I18nProvider>))
    await act(async () => button('本地服务连接已启动的本地服务').click())
    assert.equal(button('保存配置').disabled, true)
    await act(async () => { fill('decision-endpoint', 'http://127.0.0.1:6000'); fill('decision-model', 'multilingual') })
    assert.equal(button('保存配置').disabled, false); assert.equal(dirty, true)
    await act(async () => button('测试连接').click())
    assert.equal(tested, 1); assert.equal(saved, 0)
    await act(async () => button('保存配置').click())
    assert.equal(saved, 1); assert.equal(dirty, false)
  } finally { Object.assign(decisionModelsApi, original); await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('hosted proxy displays actual daemon URLs and reuses existing remote key', async () => {
  const { window } = installDomEnvironment(); const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...decisionModelsApi }; const status = initial(); let submitted: unknown
  status.proxy = { enabled: false, access_key_set: true, local_url: 'http://127.0.0.1:9876/api/decision-models/v1', lan_url: 'http://192.168.1.10:9876/api/decision-models/v1', remote_url: 'https://example.com/api/decision-models/v1' }
  decisionModelsApi.status = async () => structuredClone(status)
  decisionModelsApi.save = async draft => { submitted = draft; status.settings.proxy_enabled = draft.proxy_enabled; return structuredClone(status) }
  try {
    await act(async () => root.render(<I18nProvider><DecisionModelSettings /></I18nProvider>))
    assert.match(document.body.textContent!, /192.168.1.10:9876/)
    assert.match(document.body.textContent!, /沿用远程访问密钥/)
    assert.equal(document.getElementById('decision-access-key'), null)
    await act(async () => (document.getElementById('decision-proxy-enabled') as HTMLInputElement).click())
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '保存配置')!.click())
    assert.equal((submitted as { proxy_enabled: boolean }).proxy_enabled, true)
    assert.match(document.body.textContent!, /Authorization: Bearer/)
  } finally { Object.assign(decisionModelsApi, original); await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('unsupported host disables only managed mode and shows reasons at mobile width', async () => {
  const { window } = installDomEnvironment(); window.innerWidth = 390
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...decisionModelsApi }; const status = initial()
  status.environment = { supported: false, reasons: ['容器内存额度不足 4 GiB'] }
  decisionModelsApi.status = async () => structuredClone(status)
  try {
    await act(async () => root.render(<I18nProvider><DecisionModelSettings /></I18nProvider>))
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.equal(radios[0].disabled, true)
    assert.equal(radios[1].disabled, false); assert.equal(radios[2].disabled, false)
    assert.match(document.body.textContent!, /配置不够/)
    assert.match(document.body.textContent!, /容器内存额度不足 4 GiB/)
    const find = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
    assert.equal(find('下载组件').disabled, true)
    assert.equal(find('下载模型').disabled, true)
    assert.equal(find('测试本地推理').disabled, true)
    assert.doesNotMatch(document.body.textContent!, /NEW/)
    await act(async () => radios[2].click())
    assert.ok(document.getElementById('decision-endpoint'))
  } finally { Object.assign(decisionModelsApi, original); await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('three models download separately and selection controls test readiness and saved model', async () => {
  const { window } = installDomEnvironment(); const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...decisionModelsApi }; const status = initial(); const downloads: string[] = []; let savedModel = ''
  status.models = [
    { id: 'laya-multilingual', resource_kind: 'model', name: 'Laya · Multilingual', description: '中文', size_bytes:678201636 },
    { id: 'laya', resource_kind: 'english', name: 'Laya · English', description: '英文', size_bytes:846195574 },
    { id: 'laya-typed-decisions', resource_kind: 'typed-decisions', name: 'Laya · Typed-Decisions', description: '英文专项', size_bytes:846195716 },
  ]
  status.resources.english = { ...status.resources.model, path:'/models/laya', installed: false }
  status.resources['typed-decisions'] = { ...status.resources.model, path:'/models/laya-typed-decisions', installed: false }
  status.resources.runtime.installed = true; status.resources.model.installed = true
  decisionModelsApi.status = async () => structuredClone(status)
  decisionModelsApi.download = async kind => { downloads.push(kind); status.resources[kind]!.installed = true; return structuredClone(status) }
  decisionModelsApi.save = async draft => { savedModel = draft.managed_model!; return structuredClone(status) }
  try {
    await act(async () => root.render(<I18nProvider><DecisionModelSettings /></I18nProvider>))
    const testButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '测试本地推理')!
    assert.equal(testButton().disabled, false)
    const english = document.querySelector('[data-resource="english"]')!
    await act(async () => [...english.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '使用此模型')!.click())
    assert.equal(testButton().disabled, true)
    assert.deepEqual(downloads, [])
    await act(async () => [...english.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '下载模型')!.click())
    assert.deepEqual(downloads, ['english']); assert.equal(testButton().disabled, false)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '保存配置')!.click())
    assert.equal(savedModel, 'laya')
    assert.equal(status.resources['typed-decisions']!.installed, false)
  } finally { Object.assign(decisionModelsApi, original); await act(async () => root.unmount()); await window.happyDOM.close() }
})


test('curated native model needs its own explicit runtime download and respects per-model limits', async () => {
 const {window}=installDomEnvironment();const root=createRoot(document.body.appendChild(document.createElement('div')))
 const original={...decisionModelsApi};const status=initial();const downloads:string[]=[]
 const resource={...status.resources.model,installed:false,path:'/models/d1-2b-q4'}
 status.models=[
  {id:'laya-multilingual',resource_kind:'model',name:'Laya',description:'中文',size_bytes:678201636,runtime_kind:'runtime',environment:{supported:true,reasons:[]}},
  {id:'d1-2b-q4',resource_kind:'d1-2b-q4',name:'LiquidAI d1-2B',description:'中文',size_bytes:1099629888,runtime_kind:'runtime-gguf',backend:'gguf',environment:{supported:true,reasons:[]}},
  {id:'kev-9b-q4',resource_kind:'kev-9b-q4',name:'Kev 9B',description:'英文',size_bytes:6358923744,runtime_kind:'runtime-gguf',backend:'gguf',environment:{supported:false,reasons:['至少需要 16 GiB 内存']}}]
 status.resources['runtime-gguf']={...resource,path:'/runtime-gguf'}
 status.resources['d1-2b-q4']=resource;status.resources['kev-9b-q4']={...resource,path:'/models/kev-9b-q4'}
 status.resources.runtime.installed=true;status.resources.model.installed=true
 decisionModelsApi.status=async()=>structuredClone(status)
 decisionModelsApi.download=async kind=>{downloads.push(kind);status.resources[kind]!.installed=true;return structuredClone(status)}
 const click=async(kind:string,label:string)=>act(async()=>[...document.querySelectorAll<HTMLButtonElement>(`[data-resource="${kind}"] button`)].find(b=>b.textContent===label)!.click())
 const testButton=()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='测试本地推理')!
 try{
  await act(async()=>root.render(<I18nProvider><DecisionModelSettings /></I18nProvider>))
  assert.match(document.body.textContent!,/原生决策推理组件/)
  const tooLarge=[...document.querySelectorAll<HTMLButtonElement>('[data-resource="kev-9b-q4"] button')]
  assert.ok(tooLarge.every(button=>button.disabled))
  await click('d1-2b-q4','使用此模型')
  assert.equal(testButton().disabled,true);assert.deepEqual(downloads,[])
  await click('d1-2b-q4','下载模型')
  assert.equal(testButton().disabled,true)
  await click('runtime-gguf','下载组件')
  assert.equal(testButton().disabled,false)
  assert.deepEqual(downloads,['d1-2b-q4','runtime-gguf'])
 }finally{Object.assign(decisionModelsApi,original);await act(async()=>root.unmount());await window.happyDOM.close()}
})
