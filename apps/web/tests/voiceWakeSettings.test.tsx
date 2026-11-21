import { MemoryRouter } from 'react-router-dom'
import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { voiceWakeApi } from '../src/api/digitalPerson'
import { voiceCapture } from '../src/utils/voiceCapture'
import { speechApi } from '../src/api/speech'
import { speechOutputApi } from '../src/api/speechOutput'
import { outputStatus } from './fixtures/speechOutput'
import { prepareWakeSound, playWakeSound } from '../src/audio/wakeSound'
import DigitalPersonWake, { wakeWordRuntime } from '../src/components/digital-person/DigitalPersonWake'
import VoiceWakeSettings from '../src/components/digital-person/VoiceWakeSettings'
import { getWakeEnabled, setWakeEnabled } from '../src/components/digital-person/wakePreferences'

test('Android prefers the native chime and falls back to predecoded playback', async () => {
  const {window} = installDomEnvironment()
  const {Audio, AudioContext, fetch} = globalThis
  let played = 0, requested = 0, allowPlayback = true
  Object.defineProperty(window.navigator, 'userAgent', {configurable:true,value:'Android WebView'})
  class Context {
    state = 'running'
    destination = {}
    async resume() { if (!allowPlayback) throw new Error('blocked') }
    async decodeAudioData() { return {} }
    createBufferSource() {
      return {onended:null as (()=>void)|null,connect(){},disconnect(){},stop(){},
        start(){played++;queueMicrotask(()=>this.onended?.())}}
    }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext
  globalThis.Audio = class extends window.EventTarget {
    async play(){throw new Error('media autoplay rejected')}
    pause(){}
  } as unknown as typeof Audio
  globalThis.fetch = async () => { requested++; return new Response(new Uint8Array([0])) }
  try {
    const chime = prepareWakeSound()
    const bridge: NonNullable<Window['WorkStepWakeChime']> = {
      onmessage: null,
      postMessage(data: string) {
        const { id, type } = JSON.parse(data)
        assert.equal(type, 'wake-chime')
        this.onmessage?.({ data: JSON.stringify({ id, status: 'done' }) })
      },
    }
    window.WorkStepWakeChime = bridge
    assert.equal(await playWakeSound(chime,new AbortController().signal),true)
    assert.equal(played,0)
    bridge.postMessage = function(data) {
      const { id } = JSON.parse(data)
      this.onmessage?.({ data: JSON.stringify({ id, status: 'error' }) })
    }
    assert.equal(await playWakeSound(chime,new AbortController().signal),true)
    assert.equal(played,1)
    assert.equal(requested,1)
    allowPlayback=false
    assert.equal(await playWakeSound(chime,new AbortController().signal),false)
  } finally {
    Object.assign(globalThis,{Audio,AudioContext,fetch})
    await window.happyDOM.close()
  }
})

test('Android gateway warms only the wake detector and reuses it across trials', async () => {
  const {window} = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Android WebView' })
  window.happyDOM.setURL('https://d-123.gateway.invalid/companion')
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const originalLoad = wakeWordRuntime.load, originalCapture = voiceCapture.start
  let opens = 0, captures = 0, resets = 0
  let warmSignal: AbortSignal | undefined
  let frame!: Parameters<typeof voiceCapture.start>[0]
  wakeWordRuntime.load = async () => ({
    preloadWakeWord: async () => new ArrayBuffer(0),
    openWakeWord: async (_config, signal) => {
      opens++
      warmSignal = signal
      return { matches: async () => true, close() {}, reset: async () => { resets++ } }
    },
  })
  voiceCapture.start = async callback => { captures++; frame = callback; return { stop() {}, flush() {} } }
  try {
    const draft = { keyword: '小研', sensitivity: 'balanced' as const, soundEnabled: false }
    await act(async () => root.render(<I18nProvider><DigitalPersonWake blocked={false} draft={draft} /></I18nProvider>))
    assert.equal(opens, 1)
    assert.equal(captures, 0)
    const button = () => document.querySelector<HTMLButtonElement>('[data-test-wake]')!
    for (let trial = 1; trial <= 2; trial++) {
      await act(async () => button().click())
      assert.match(document.body.textContent!, /小研/)
      await act(async () => frame(Int16Array.of(1), 0))
      assert.match(document.body.textContent!, /已听到唤醒词/)
      assert.equal(captures, trial)
      assert.equal(resets, trial)
      assert.equal(opens, 1)
    }
  } finally {
    await act(async () => root.unmount())
    wakeWordRuntime.load = originalLoad
    voiceCapture.start = originalCapture
    await window.happyDOM.close()
  }
  assert.equal(warmSignal?.aborted, true)
})

test('gateway devices sharing an origin keep independent wake preferences', async () => {
  const {window} = installDomEnvironment()
  try {
    window.happyDOM.setURL('https://gateway.invalid/workspace/first/companion')
    setWakeEnabled(true)
    window.happyDOM.setURL('https://gateway.invalid/workspace/second/companion')
    assert.equal(getWakeEnabled(),false)
    window.happyDOM.setURL('https://gateway.invalid/workspace/first/companion')
    assert.equal(getWakeEnabled(),true)
  } finally { await window.happyDOM.close() }
})

test('wake settings applies the master switch and tests the unsaved phrase on demand', async () => {
  const { window } = installDomEnvironment(); useLocaleStore.setState({locale:'zh-CN'})
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  const original = {...voiceWakeApi}
  const originalCapture = voiceCapture.start, originalLoad = wakeWordRuntime.load
  const originalOutput = speechOutputApi.status
  const originalAudio = globalThis.Audio
  let sounds = 0, preloads = 0
  globalThis.Audio = class extends window.EventTarget {
    async play() {
      sounds++
      queueMicrotask(() => this.dispatchEvent(new window.Event('ended')))
    }
    pause() {}
  } as unknown as typeof Audio
  let saved:any, dirty=false, tested='', closed=0, captures=0
  let frame!: Parameters<typeof voiceCapture.start>[0]
  voiceCapture.start=async callback=>{captures++; frame=callback; return {stop(){},flush(){}}}
  wakeWordRuntime.load=async()=>({
    preloadWakeWord:async()=>{preloads++;return new ArrayBuffer(0)},
    openWakeWord:async config=>{tested=config.keyword;return {matches:async()=>true,close:()=>{closed++}}},
  })
  voiceWakeApi.get=async()=>({keyword:'你好小研',sensitivity:'balanced',available:false,listening:false})
  voiceWakeApi.save=async value=>{saved=value;return {...value,available:false,listening:false}}
  const render=()=>root.render(<MemoryRouter><I18nProvider><VoiceWakeSettings onDirtyChange={value=>{dirty=value}} /></I18nProvider></MemoryRouter>)
  try {
    await act(async()=>render())
    assert.equal(preloads,1,'opening local wake settings starts fetching model weights')
    assert.equal(captures,0,'preloading still waits for a trial before capturing audio')
    const toggle=element.querySelector<HTMLButtonElement>('[role="switch"]')!
    assert.doesNotMatch(element.textContent!,/本地数字人页面/)
    assert.equal(toggle.getAttribute('aria-checked'),'false')
    assert.equal(captures,0)
    await act(async()=>toggle.click())
    assert.equal(toggle.getAttribute('aria-checked'),'true')
    assert.equal(window.localStorage.getItem('workstep.digital-person.wake-enabled'),'true')
    await act(async()=>toggle.click())
    assert.equal(captures,0)
    const input=element.querySelector<HTMLInputElement>('[name=wake_keyword]')!
    await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
    const sound=element.querySelector<HTMLInputElement>('input[name=wake_sound][type=checkbox]')!
    assert.equal(element.querySelector('[data-preview-wake]'),null)
    assert.ok(sound, 'wake sound is configurable with an empty wake word')
    const greeting=element.querySelector<HTMLInputElement>('[name=wake_greeting]')!
    assert.equal(sound.checked,true)
    assert.equal(greeting.placeholder,'留空播放默认提示音')
    await act(async()=>sound.click())
    assert.equal(sound.checked,false)
    assert.equal(greeting.disabled,true)
    assert.equal(window.localStorage.getItem('workstep.digital-person.wake-sound'),null)
    await act(async()=>sound.click())
    assert.equal(greeting.disabled,false)
    await act(async()=>{
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(greeting,'我在，您说')
      greeting.dispatchEvent(new window.Event('input',{bubbles:true}))
    })
    assert.equal(window.localStorage.getItem('workstep.digital-person.wake-greeting'),null)
    await act(async()=>{
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(greeting,'')
      greeting.dispatchEvent(new window.Event('input',{bubbles:true}))
    })
    await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'你好小舟');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
    assert.equal(dirty,true)
    const testButton=element.querySelector<HTMLButtonElement>('.voice-wake-actions [data-test-wake]')!
    assert.equal(testButton.disabled,false)
    await act(async()=>testButton.click())
    assert.equal(captures,1)
    assert.equal(tested,'你好小舟')
    assert.equal(saved,undefined)
    await act(async()=>frame(Int16Array.of(1),0))
    assert.match(element.textContent!,/已听到唤醒词/)
    assert.equal(sounds,1,'matching a draft without a greeting plays the default chime')
    assert.equal(closed,1)
    await act(async()=>{
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(greeting,'我在，您说')
      greeting.dispatchEvent(new window.Event('input',{bubbles:true}))
    })
    const utterances: { type: string; id: string; text?: string }[] = []
    const bridge: NonNullable<Window['WorkStepSpeech']> = {
      onmessage: null, postMessage: message => utterances.push(JSON.parse(message)),
    }
    window.WorkStepSpeech = bridge
    speechOutputApi.status = async () => ({ ...outputStatus, settings: { ...outputStatus.settings, mode: 'system' } })
    const startTrial = () => act(async()=>element.querySelector<HTMLButtonElement>('[data-test-wake]')!.click())
    await startTrial()
    await act(async()=>frame(Int16Array.of(1),0))
    assert.equal(utterances[0]?.text,'我在，您说')
    assert.equal(sounds,1)
    assert.equal(element.querySelector<HTMLButtonElement>('[data-save-wake]')!.disabled,true)
    await act(async()=>bridge.onmessage?.({data:JSON.stringify({id:utterances[0].id,status:'done'})}))
    await act(async()=>element.querySelector<HTMLButtonElement>('[data-save-wake]')!.click())
    assert.equal(saved.keyword,'你好小舟');assert.equal(dirty,false)
    assert.equal(saved.greeting,'我在，您说')
    assert.equal(saved.sound_enabled,true)
    assert.equal(window.localStorage.getItem('workstep.digital-person.wake-greeting'),null)
    saved=undefined
    await act(async()=>sound.click())
    assert.equal(greeting.disabled,true)
    assert.equal(dirty,true)
    assert.equal(window.localStorage.getItem('workstep.digital-person.wake-sound'),null)
    await startTrial()
    await act(async()=>frame(Int16Array.of(1),0))
    assert.equal(sounds,1)
    assert.equal(utterances.length,1,'the unchecked draft suppresses both forms of audio before saving')
    await act(async()=>element.querySelector<HTMLButtonElement>('[data-save-wake]')!.click())
    assert.equal(window.localStorage.getItem('workstep.digital-person.wake-sound'),null)
    assert.equal(saved.sound_enabled,false)
    assert.equal(saved.greeting,'我在，您说')
    assert.equal(dirty,false)
    localStorage.setItem('workstep.digital-person.wake-greeting','旧本地欢迎语')
    localStorage.setItem('workstep.digital-person.wake-sound','true')
    voiceWakeApi.get=async()=>({...saved,available:false,listening:false})
    await act(async()=>root.render(<MemoryRouter><I18nProvider><VoiceWakeSettings key="other-client" /></I18nProvider></MemoryRouter>))
    assert.equal(element.querySelector<HTMLInputElement>('[name=wake_greeting]')!.value,'我在，您说')
    assert.equal(element.querySelector<HTMLInputElement>('[name=wake_sound]')!.checked,false)
  } finally {await act(async()=>root.unmount());Object.assign(voiceWakeApi,original);voiceCapture.start=originalCapture;wakeWordRuntime.load=originalLoad;globalThis.Audio=originalAudio;speechOutputApi.status=originalOutput;await window.happyDOM.close()}
})

test('a settings test suspends page listening and the master switch releases it', async () => {
  const {window} = installDomEnvironment(), root = createRoot(document.body.appendChild(document.createElement('div')))
  const originalStatus = speechApi.status, originalGet = voiceWakeApi.get
  const originalCapture = voiceCapture.start, originalLoad = wakeWordRuntime.load
  const captures: AbortSignal[] = []
  speechApi.status = async () => ({enabled:true,ready:true}) as Awaited<ReturnType<typeof speechApi.status>>
  voiceWakeApi.get = async () => ({keyword:'你好小研',sensitivity:'balanced',available:false,listening:false})
  voiceCapture.start = async (_frame, signal) => {captures.push(signal);return {stop(){},flush(){}}}
  wakeWordRuntime.load = async () => ({
    preloadWakeWord:async()=>new ArrayBuffer(0),
    openWakeWord:async()=>({matches:async()=>false,close(){}}),
  })
  try {
    await act(async () => root.render(<I18nProvider><DigitalPersonWake projectId="p" blocked={false} />
      <VoiceWakeSettings /></I18nProvider>))
    const toggle = document.querySelector<HTMLButtonElement>('.voice-wake-settings [role=switch]')!
    await act(async () => toggle.click())
    assert.equal(captures.length,1)
    await act(async () => document.querySelector<HTMLButtonElement>('.voice-wake-settings [data-test-wake]')!.click())
    assert.equal(captures.length,2)
    assert.equal(captures[0].aborted,true)
    await act(async () => document.querySelector<HTMLButtonElement>('.voice-wake-test button')!.click())
    assert.equal(captures.length,3)
    assert.equal(captures[1].aborted,true)
    await act(async () => toggle.click())
    assert.equal(captures[2].aborted,true)
    assert.equal(captures.length,3)
  } finally {
    await act(async()=>root.unmount())
    speechApi.status=originalStatus;voiceWakeApi.get=originalGet;voiceCapture.start=originalCapture;wakeWordRuntime.load=originalLoad
    await window.happyDOM.close()
  }
})


test('gateway settings test the draft only after a click', async () => {
  const {window} = installDomEnvironment()
  window.happyDOM.setURL('https://d-123.gateway.invalid/companion')
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const originalGet = voiceWakeApi.get, originalLoad = wakeWordRuntime.load, originalCapture = voiceCapture.start
  let loads = 0, keyword = ''
  let frame!: Parameters<typeof voiceCapture.start>[0]
  voiceWakeApi.get = async () => ({keyword:'你好小研',sensitivity:'balanced',available:false,listening:false})
  voiceCapture.start = async callback => { frame=callback; return {stop(){},flush(){}} }
  wakeWordRuntime.load = async () => {
    loads++
    return {preloadWakeWord:async()=>new ArrayBuffer(0),
      openWakeWord:async config=>{keyword=config.keyword;return {matches:async()=>true,close(){}}}}
  }
  try {
    await act(async()=>root.render(<I18nProvider><VoiceWakeSettings /></I18nProvider>))
    assert.equal(loads,0)
    const toggle = host.querySelector<HTMLButtonElement>('[role=switch]')!
    await act(async()=>toggle.click())
    assert.equal(toggle.getAttribute('aria-checked'),'true')
    assert.equal(loads,0)
    const input = host.querySelector('input')!
    await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'小研');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
    const button = host.querySelector<HTMLButtonElement>('[data-test-wake]')!
    assert.equal(button.disabled,false)
    assert.doesNotMatch(host.textContent!,/请在运行 WorkStep 的设备上打开/)
    await act(async()=>button.click())
    assert.equal(loads,1)
    assert.equal(keyword,'小研')
    await act(async()=>frame(Int16Array.of(1),0))
    assert.match(host.textContent!,/已听到唤醒词/)
  } finally {
    await act(async()=>root.unmount()); voiceWakeApi.get=originalGet; wakeWordRuntime.load=originalLoad; voiceCapture.start=originalCapture
    await window.happyDOM.close()
  }
})
