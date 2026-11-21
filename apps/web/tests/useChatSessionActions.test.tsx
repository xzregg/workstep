import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useChatSessionActions } from '../src/hooks/useChatSessionActions'
import { useChatSessionStore } from '../src/stores/chatSessionStore'

for(const mode of ['normal','running','prepared'] as const)test(`recognized face IDs travel in the same chat request (${mode})`,async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const oldFetch=globalThis.fetch,oldList=chatSessionApi.list
 let actions!:ReturnType<typeof useChatSessionActions>,captures=0
 const requests:any[]=[]
 globalThis.fetch=async(input,options)=>{
  assert.match(String(input),/\/chat(?:\?|$)/)
  requests.push(JSON.parse(String(options?.body)))
  return Response.json({session_id:'face-send',turn_id:'face-user',assistant_message_id:'face-reply',status:'queued'})
 }
 chatSessionApi.list=async()=>({sessions:[]})
 function Harness(){
  actions=useChatSessionActions({sessionId:'face-send',projectId:'p',running:mode==='running',
   engineConfig:{engine:'codex',providerId:'',model:'',fastModel:'',visionModel:'',thinkingEffort:''},
   permissionMode:'',planMode:false,goalMode:false,effectiveEngine:'codex',onSessionIdChange(){},onTitleChange(){},
   prepareContent:async(content,onFaces)=>{captures++;onFaces?.(['face-1'],mode==='running');return content+'\n\n![camera](.workstep/uploads/camera.jpg)'},
  });return null
 }
 try{
  await act(async()=>root.render(<I18nProvider><Harness/></I18nProvider>))
  await act(async()=>{
   const sent=mode==='running'?await actions.sendPendingContent('我是谁',[]):await actions.sendMessageNow('我是谁',false,mode==='prepared',mode==='prepared'?['face-1']:[],mode==='prepared')
   assert.equal(sent,true,actions.sendError)
  })
  assert.equal(requests.length,1);assert.deepEqual(requests[0].face_person_ids,['face-1'])
  assert.equal(requests[0].face_context_recent,mode==='normal'?undefined:true)
  assert.equal(captures,mode==='prepared'?0:1)
  assert.doesNotMatch(requests[0].content,/face-1|人脸识别/)
 }finally{await act(async()=>root.unmount());globalThis.fetch=oldFetch;chatSessionApi.list=oldList;useChatSessionStore.getState().resetSession('face-send');await window.happyDOM.close()}
})

for (const fallback of [false, true]) {
  test(`sending follows the server config rather than the local default engine (${fallback ? 'live fallback' : 'normal'})`, async () => {
    const { window } = installDomEnvironment()
    const original = { chat: chatSessionApi.chat, list: chatSessionApi.list, sendLiveMessage: chatSessionApi.sendLiveMessage }
    let actions!: ReturnType<typeof useChatSessionActions>
    let requestedEngine: string | undefined
    function Harness() {
      actions = useChatSessionActions({
        sessionId: 'default-engine', projectId: 'p', running: fallback,
        // The picker uses '' for 默认（Codex）; the persisted session may still be Claude.
        engineConfig: { engine: '', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        permissionMode: '', planMode: false, goalMode: false, effectiveEngine: 'codex_sdk',
        onSessionIdChange: () => {}, onTitleChange: () => {},
      })
      return null
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    try {
      chatSessionApi.sendLiveMessage = async () => { throw new Error('not running') }
      chatSessionApi.chat = async (_id, _project, _content, _key, options) => {
        requestedEngine = options?.engine
        return { session_id: 'default-engine', turn_id: 't', assistant_message_id: 'reply', status: 'queued', execution_config: { id: 'default-engine', project_id: 'p', engine: 'claude', provider_id: 'latest-provider', execution_config_revision: 3 } }
      }
      chatSessionApi.list = async () => ({ sessions: [] })
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      await act(async () => { assert.equal(await actions.sendPendingContent('continue with Codex', []), true) })
      assert.equal(requestedEngine, undefined)
      assert.equal(useChatSessionStore.getState().sessions['default-engine'].messages.at(-1)?.engine, 'claude')
    } finally {
      await act(async () => root.unmount())
      Object.assign(chatSessionApi, original)
      useChatSessionStore.getState().resetSession('default-engine')
      await window.happyDOM.close()
    }
  })
}

for (const [engine, tier] of [
  ['codex_sdk', 'priority'], ['codex', 'default'],
  ['codex_sdk', ''], ['claude', 'priority'],
] as const) {
  test(`chat does not resend stale local speed or provider (${engine}, ${tier || 'inherited'})`, async () => {
    const { window } = installDomEnvironment()
    const original = { chat: chatSessionApi.chat, list: chatSessionApi.list }
    let actions!: ReturnType<typeof useChatSessionActions>
    let selected: string | undefined
    function Harness() {
      actions = useChatSessionActions({
        sessionId: 'speed', projectId: 'p', running: false,
        engineConfig: { engine, model: '', fastModel: '', visionModel: '', thinkingEffort: '', providerId: 'third-party', serviceTier: tier },
        permissionMode: '', planMode: false, goalMode: false, effectiveEngine: engine,
        onSessionIdChange: () => {}, onTitleChange: () => {},
      })
      return null
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    try {
      chatSessionApi.chat = async (_id, _project, _content, _key, options) => {
        selected = options?.service_tier
        assert.equal(options?.provider_id, undefined)
        return { session_id: 'speed', turn_id: 't', assistant_message_id: 'reply', status: 'queued' }
      }
      chatSessionApi.list = async () => ({ sessions: [] })
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      await act(async () => { assert.equal(await actions.sendMessageNow('hi'), true) })
      assert.equal(selected, undefined)
    } finally {
      await act(async () => root.unmount())
      Object.assign(chatSessionApi, original)
      useChatSessionStore.getState().resetSession('speed')
      await window.happyDOM.close()
    }
  })
}

for (const scenario of ['normal', 'live', 'list-failed']) {
  const live = scenario === 'live'
  const listFailed = scenario === 'list-failed'
  test(`send establishes its accepted state even without WebSocket START (${scenario})`, async () => {
    const { window } = installDomEnvironment()
    const original = { chat: chatSessionApi.chat, sendLiveMessage: chatSessionApi.sendLiveMessage, list: chatSessionApi.list }
    let actions!: ReturnType<typeof useChatSessionActions>
    function Harness() {
      actions = useChatSessionActions({
        sessionId: 'confirmed', projectId: 'project-1', running: live,
        engineConfig: { engine: 'codex', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        permissionMode: '', planMode: false, goalMode: false, effectiveEngine: 'codex',
        onSessionIdChange: () => {}, onTitleChange: () => {},
      })
      return null
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    try {
      chatSessionApi.chat = (async () => ({ session_id: 'confirmed', turn_id: 'saved-user',
        assistant_message_id: 'reply', status: 'queued' })) as never
      chatSessionApi.sendLiveMessage = (async () => ({ message_id: 'saved-user', created_at: '2026-10-07T05:56:08Z' })) as never
      chatSessionApi.list = (async () => {
        if (listFailed) throw new Error('连接已断开')
        return { sessions: [] }
      }) as never
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      await act(async () => { assert.equal(await actions.sendPendingContent('hello', []), true) })
      const messages = useChatSessionStore.getState().sessions.confirmed.messages
      assert.deepEqual(messages.map((message) => message.id), live ? ['saved-user'] : ['saved-user', 'reply'])
      if (!live) assert.equal(useChatSessionStore.getState().sessions.confirmed.running, true)
      assert.equal(actions.sendError, '')
      if (live) assert.equal(messages[0].created_at, '2026-10-07T05:56:08Z')
    } finally {
      await act(async () => root.unmount())
      Object.assign(chatSessionApi, original)
      useChatSessionStore.getState().resetSession('confirmed')
      await window.happyDOM.close()
    }
  })
}

test('running chat falls back to a normal send when its turn has ended', async () => {
  const { window } = installDomEnvironment()
  const originalLive = chatSessionApi.sendLiveMessage
  const originalChat = chatSessionApi.chat
  const originalList = chatSessionApi.list
  const calls: string[] = []
  let root!: Root
  let actions!: ReturnType<typeof useChatSessionActions>

  function Harness() {
    actions = useChatSessionActions({
      sessionId: 'session-1', projectId: 'project-1', running: true,
      engineConfig: { engine: 'codex_sdk', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
      permissionMode: '', planMode: false, goalMode: false, effectiveEngine: 'codex_sdk',
      onSessionIdChange: () => {}, onTitleChange: () => {},
    })
    return null
  }

  try {
    chatSessionApi.sendLiveMessage = (async () => {
      calls.push('live')
      throw new Error('not running')
    }) as never
    chatSessionApi.chat = (async () => {
      calls.push('chat')
      return { session_id: 'session-1' }
    }) as never
    chatSessionApi.list = (async () => ({ sessions: [] })) as never
    useChatSessionStore.getState().newSession('session-1')
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<I18nProvider><Harness /></I18nProvider>)
    })
    let accepted = false
    await act(async () => { accepted = await actions.sendPendingContent('hello', ['insert-1']) })
    assert.equal(accepted, true)
    assert.deepEqual(calls, ['live', 'chat'])
    assert.equal(actions.sendError, '')
    await act(async () => { root.unmount() })
  } finally {
    chatSessionApi.sendLiveMessage = originalLive
    chatSessionApi.chat = originalChat
    chatSessionApi.list = originalList
    useChatSessionStore.getState().resetSession('session-1')
    await window.happyDOM.close()
  }
})


for (const scenario of ['resume', 'end-running', 'end-idle', 'stop-failed', 'clear-failed']) {
  test(`goal controls: ${scenario}`, async () => {
    const { window } = installDomEnvironment()
    const original = { chat: chatSessionApi.chat, stop: chatSessionApi.stop, list: chatSessionApi.list }
    const calls: string[] = []
    let actions!: ReturnType<typeof useChatSessionActions>
    const sessionId = `goal-${scenario}`
    function Harness() {
      actions = useChatSessionActions({
        sessionId, projectId: 'project-1', running: scenario !== 'resume' && scenario !== 'end-idle',
        engineConfig: { engine: 'codex_sdk', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        permissionMode: '', planMode: true, goalMode: true, effectiveEngine: 'codex_sdk',
        onSessionIdChange: () => {}, onTitleChange: () => {},
      })
      return null
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    try {
      chatSessionApi.stop = (async () => {
        calls.push('stop')
        return { stopped: scenario !== 'stop-failed' }
      }) as never
      chatSessionApi.chat = (async (_id, projectId, content, _key, overrides) => {
        calls.push(content)
        assert.equal(projectId, 'project-1')
        assert.equal(overrides?.goal_mode, false)
        assert.equal(overrides?.plan_mode, false)
        if (scenario === 'clear-failed') throw new Error('clear failed')
        return { session_id: sessionId }
      }) as typeof chatSessionApi.chat
      chatSessionApi.list = (async () => ({ sessions: [] })) as never
      useChatSessionStore.getState().newSession(sessionId)
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      let accepted = false
      await act(async () => { accepted = await (scenario === 'resume' ? actions.continueGoal() : actions.endGoal()) })
      assert.equal(accepted, scenario !== 'stop-failed' && scenario !== 'clear-failed')
      assert.deepEqual(calls, scenario === 'resume' ? ['/goal resume']
        : scenario === 'end-idle' ? ['/goal clear']
        : scenario === 'stop-failed' ? ['stop'] : ['stop', '/goal clear'])
      if (scenario === 'clear-failed') {
        assert.equal(actions.sendError, 'clear failed')
        assert.equal(useChatSessionStore.getState().sessions[sessionId].messages.length, 0)
      }
    } finally {
      await act(async () => root.unmount())
      Object.assign(chatSessionApi, original)
      useChatSessionStore.getState().resetSession(sessionId)
      await window.happyDOM.close()
    }
  })
}


for (const scenario of ['omitted', 'selected', 'cleared', 'live', 'fallback'] as const) {
  test(`provider selection in chat send: ${scenario}`, async () => {
    const { window } = installDomEnvironment()
    const original = { chat: chatSessionApi.chat, sendLiveMessage: chatSessionApi.sendLiveMessage, list: chatSessionApi.list }
    const calls: string[] = []
    let actions!: ReturnType<typeof useChatSessionActions>
    function Harness() {
      actions = useChatSessionActions({
        sessionId: 'provider-session', projectId: 'project-1', running: scenario === 'live' || scenario === 'fallback',
        engineConfig: { engine: 'codex_sdk', providerId: scenario === 'selected' ? 'chosen-provider' : '',
          providerCleared: ['cleared', 'live', 'fallback'].includes(scenario),
          model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        permissionMode: '', planMode: false, goalMode: false, effectiveEngine: 'codex_sdk',
        onSessionIdChange: () => {}, onTitleChange: () => {},
      })
      return null
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    try {
      chatSessionApi.chat = (async (_id, _project, _content, _key, overrides) => {
        calls.push('chat')
        assert.equal(overrides?.provider_id, undefined)
        return { session_id: 'provider-session' }
      }) as typeof chatSessionApi.chat
      chatSessionApi.sendLiveMessage = (async (...args) => {
        calls.push('live')
        assert.deepEqual(args, ['provider-session', 'project-1', 'hello', ['insert-1']])
        if (scenario === 'fallback') throw new Error('not running')
        return { accepted: true }
      }) as never
      chatSessionApi.list = (async () => ({ sessions: [] })) as never
      useChatSessionStore.getState().newSession('provider-session')
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      let accepted = false
      await act(async () => { accepted = await actions.sendPendingContent('hello', ['insert-1']) })
      assert.equal(accepted, true)
      assert.deepEqual(calls, scenario === 'live' ? ['live'] : scenario === 'fallback' ? ['live', 'chat'] : ['chat'])
    } finally {
      await act(async () => root.unmount())
      Object.assign(chatSessionApi, original)
      useChatSessionStore.getState().resetSession('provider-session')
      await window.happyDOM.close()
    }
  })
}

for (const mode of ['normal', 'live', 'fallback', 'failed'] as const) {
  test(`camera preparation stays with its turn and runs once: ${mode}`, async () => {
    const { window } = installDomEnvironment(), root = createRoot(document.body.appendChild(document.createElement('div')))
    const original = { ...chatSessionApi }
    let actions!: ReturnType<typeof useChatSessionActions>, frames = 0
    const contents: string[] = []
    function Harness() {
      actions = useChatSessionActions({ sessionId: 'camera', projectId: 'p', running: mode === 'live' || mode === 'fallback',
        engineConfig: { engine: 'codex', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        permissionMode: '', planMode: false, goalMode: false, effectiveEngine: 'codex', onSessionIdChange() {}, onTitleChange() {},
        prepareContent: async content => { frames++; if (mode === 'failed') throw new Error('frame failed'); return content + '\n\n![camera](.workstep/uploads/frame.jpg)' },
      })
      return null
    }
    chatSessionApi.chat = async (_id, _project, content) => { contents.push(content); return { session_id: 'camera' } as any }
    chatSessionApi.sendLiveMessage = async (_id, _project, content) => { contents.push(content); if (mode === 'fallback') throw new Error('not running'); return {} as any }
    chatSessionApi.list = async () => ({ sessions: [] })
    try {
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      await act(async () => assert.equal(await actions.sendPendingContent('看到了什么', []), mode !== 'failed'))
      assert.equal(frames, 1)
      assert.equal(contents.length, mode === 'fallback' ? 2 : mode === 'failed' ? 0 : 1)
      assert.ok(contents.every(content => content === '看到了什么\n\n![camera](.workstep/uploads/frame.jpg)'))
      if (mode === 'failed') assert.equal(actions.sendError, 'frame failed')
    } finally { await act(async () => root.unmount()); Object.assign(chatSessionApi, original); useChatSessionStore.getState().resetSession('camera'); await window.happyDOM.close() }
  })
}
