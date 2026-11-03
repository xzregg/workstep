import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { useWorkflowDesignSkill } from '../src/hooks/useWorkflowDesignSkill'
import { engineApi } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('plus menu inserts the engine skill reference, keeps the idea and never sends automatically', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const original = engineApi.inspect
  let loads = 0
  let sends = 0
  engineApi.inspect = async () => { loads++; return { input_items: [{kind:'skill',name:'workstep-exec',insert_text:'$workstep-exec ',action:'prompt'}] } as any }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Composer({ sessionId = 's1', running = false }) {
    const [input, setInput] = useState('做一个登录页面')
    const skill = useWorkflowDesignSkill({ projectId: 'p1', engine: 'codex', sessionId, input, onChange: setInput, running, onError: () => {} })
    return <ChatInput value={input} onChange={setInput} onSend={() => { sends++ }} workflowSkill={skill} />
  }
  try {
    await act(async () => root.render(<I18nProvider><Composer /></I18nProvider>))
    await act(async () => (container.querySelector('.chat-input-attach') as HTMLButtonElement).click())
    const option = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('流程模式'))!
    assert.ok(option)
    await act(async () => option.click())
    assert.equal(loads, 1)
    assert.equal(sends, 0)
    assert.equal((container.querySelector('textarea') as HTMLTextAreaElement).value, '$workstep-exec 做一个登录页面')
    assert.ok(container.querySelector('[data-kind="workflow-skill"]'))
    await act(async () => root.render(<I18nProvider><Composer sessionId="s2" /></I18nProvider>))
    assert.equal(container.querySelector('[data-kind="workflow-skill"]'), null)
  } finally {
    engineApi.inspect = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('skill loading ignores stale sessions and preserves edits made during the request', async () => {
  const { window } = installDomEnvironment()
  const original = engineApi.inspect
  let resolve!: (value: any) => void
  engineApi.inspect = () => new Promise(done => { resolve = done })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let skill: ReturnType<typeof useWorkflowDesignSkill>
  let change!: (value: string) => void
  let value = ''
  function Probe({ sessionId }: { sessionId: string }) {
    const [input, setInput] = useState('原想法')
    value = input; change = setInput
    skill = useWorkflowDesignSkill({ projectId: 'p', engine: 'claude', sessionId, input, onChange: setInput, running: false, onError: () => {} })
    return null
  }
  try {
    await act(async () => root.render(<I18nProvider><Probe sessionId="s1" /></I18nProvider>))
    await act(async () => { void skill.onLoad() })
    await act(async () => change('补充后的想法'))
    await act(async () => resolve({input_items:[{kind:'skill',name:'workstep-exec',insert_text:'/workstep-exec ',action:'prompt'}]}))
    assert.equal(value, '/workstep-exec 补充后的想法')
    await act(async () => { skill.onRemove(); void skill.onLoad() })
    await act(async () => root.render(<I18nProvider><Probe sessionId="s2" /></I18nProvider>))
    await act(async () => resolve({input_items:[{kind:'skill',name:'workstep-exec',insert_text:'/过期技能 ',action:'prompt'}]}))
    assert.doesNotMatch(value, /过期技能/)
  } finally {
    engineApi.inspect = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('failed skill loading keeps the idea and can be retried; running conversations cannot load', async () => {
  const { window } = installDomEnvironment()
  const original = engineApi.inspect
  let calls = 0
  engineApi.inspect = async () => {
    if (++calls === 1) throw new Error('读取失败')
    return {input_items:[{kind:'skill',name:'workstep-exec',insert_text:'/workstep-exec ',action:'prompt'}]} as any
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let control!: ReturnType<typeof useWorkflowDesignSkill>
  let value = ''
  let error = ''
  function Probe({ running = false }) {
    const [input, onChange] = useState('保留想法')
    value = input
    control = useWorkflowDesignSkill({ projectId: 'p', engine: 'claude', sessionId: 's', input, onChange, running, onError: message => { error = message } })
    return null
  }
  try {
    await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>))
    await act(async () => { await control.onLoad() })
    assert.equal(error, '读取失败')
    assert.equal(value, '保留想法')
    assert.equal(control.loading, false)
    assert.equal(control.active, false)
    await act(async () => { await control.onLoad() })
    assert.equal(value, '/workstep-exec 保留想法')
    await act(async () => control.onRemove())
    await act(async () => root.render(<I18nProvider><Probe running /></I18nProvider>))
    await act(async () => { await control.onLoad() })
    assert.equal(calls, 2)
    assert.equal(value, '保留想法')
    assert.equal(control.disabled, true)
  } finally {
    engineApi.inspect = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('disabled skills keep drafts intact; engine switches clear only the inserted invocation', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const original = engineApi.inspect
  let enabled = false
  engineApi.inspect = async (engine) => ({input_items: enabled ? [{kind:'skill',name:'workstep-exec',insert_text:engine === 'codex' ? '$workstep-exec ' : '/workstep:workstep-exec ',action:'prompt'}] : []}) as any
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let control!: ReturnType<typeof useWorkflowDesignSkill>
  let value = ''
  let error = ''
  function Probe({ engine = 'codex' }) {
    const [input, onChange] = useState('我的需求')
    value = input
    control = useWorkflowDesignSkill({projectId:'p',sessionId:'s',engine,input,onChange,running:false,onError:message => {error=message}})
    return null
  }
  try {
    await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>))
    await act(async () => {await control.onLoad()})
    assert.match(error, /未加载/)
    assert.equal(value, '我的需求')
    enabled = true
    await act(async () => {await control.onLoad()})
    assert.equal(value, '$workstep-exec 我的需求')
    await act(async () => root.render(<I18nProvider><Probe engine="claude" /></I18nProvider>))
    assert.equal(value, '我的需求')
    await act(async () => {await control.onLoad()})
    assert.equal(value, '/workstep:workstep-exec 我的需求')
    await act(async () => control.onRemove())
    assert.equal(value, '我的需求')
  } finally {
    engineApi.inspect = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
