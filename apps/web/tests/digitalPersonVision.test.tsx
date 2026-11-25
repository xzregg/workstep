import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import ChatInput from '../src/components/ChatInput'
import DigitalPersonCamera, { DigitalPersonCameraToggle } from '../src/components/digital-person/DigitalPersonCamera'
import { fsApi } from '../src/api/client'

test('the dock camera keeps its icon while opening and only selects after the preview starts', async context => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0, deny: () => void = () => {}
  const track = { stop() {}, addEventListener() {} }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
    if (++requests === 1) return stream
    return new Promise((_resolve, reject) => { deny = () => reject(new DOMException('denied', 'NotAllowedError')) })
  } } })
  window.HTMLVideoElement.prototype.play = async () => {}
  Object.defineProperty(window.HTMLVideoElement.prototype, 'srcObject', { configurable: true, writable: true, value: null })
  try {
    await act(async () => root.render(<I18nProvider><DigitalPersonCamera compact><DigitalPersonCameraToggle /></DigitalPersonCamera></I18nProvider>))
    const toggle = host.querySelector<HTMLButtonElement>('[data-camera-toggle]')!
    const name = toggle.getAttribute('aria-label'), icon = toggle.querySelector('svg')?.outerHTML
    assert.ok(toggle.querySelector('path[d="m2 2 20 20"]'))
    await act(async () => { toggle.click(); toggle.click() })
    assert.equal(requests, 1)
    assert.equal(toggle.getAttribute('aria-pressed'), 'true', host.textContent || '')
    assert.equal(toggle.getAttribute('aria-label'), name)
    assert.ok(toggle.querySelector('path[d="m2 2 20 20"]') === null)
    await act(async () => toggle.click())
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-pressed'), 'false')
    assert.equal(toggle.getAttribute('aria-busy'), 'true')
    assert.equal(toggle.getAttribute('aria-disabled'), 'true')
    assert.equal(toggle.querySelector('svg')?.outerHTML, icon)
    await act(async () => context.mock.timers.tick(300))
    assert.ok(toggle.querySelector('.spinner'))
    await act(async () => toggle.click())
    assert.equal(requests, 2)
    await act(async () => deny())
    assert.ok(host.querySelector('[role="alert"]'))
    assert.equal(toggle.getAttribute('aria-busy'), 'false')
    assert.equal(toggle.getAttribute('aria-disabled'), null)
    assert.equal(toggle.querySelector('svg')?.outerHTML, icon)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

for (const mode of ['inline', 'compact', 'menu']) test(`camera captures only on send, uploads one frame and disposes tracks when hidden (mode=${mode})`, async () => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  let stops = 0, uploads = 0, draws = 0, prepare: ((content: string) => Promise<string>) | null = null
  const oldUpload = fsApi.uploadImage
  const track = { stop() { stops++ }, addEventListener() {}, removeEventListener() {}, readyState: 'live' }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async (constraints: any) => { assert.equal(constraints.audio, false); return stream } } })
  window.HTMLVideoElement.prototype.play = async () => {}
  Object.defineProperty(window.HTMLVideoElement.prototype, 'srcObject', { configurable: true, writable: true, value: null })
  window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() { draws++ } })) as any
  window.HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) { callback(new Blob(['frame'], { type: 'image/jpeg' })) }
  fsApi.uploadImage = async file => { uploads++; assert.equal(file.type, 'image/jpeg'); return { url: '.workstep/uploads/frame.jpg', filename: file.name, size: file.size } }
  const ready = (callback: typeof prepare) => { prepare = callback }
  try {
    await act(async () => root.render(<I18nProvider><DigitalPersonCamera projectId="demo" onPrepare={ready} compact={mode === 'compact'} floating={mode === 'menu'}>{mode === 'menu' ? <ChatInput value="草稿" onChange={()=>{}} onSend={()=>{}} /> : undefined}</DigitalPersonCamera></I18nProvider>))
    assert.equal(await prepare!('你好'), '你好')
    if(mode === 'menu') {
      assert.ok(host.querySelector('[data-camera-toggle]') === null, 'no standalone camera button')
      await act(async () => host.querySelector<HTMLButtonElement>('.chat-input-attach')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>('[data-camera-menu-toggle]')!.click())
      assert.ok(document.querySelector('.chat-input-attach-menu') === null, 'menu closes without releasing camera')
    } else await act(async () => host.querySelector<HTMLButtonElement>('[data-camera-toggle]')!.click())
    assert.equal(host.querySelector('.digital-person-camera')?.getAttribute('data-camera-phase'), 'on', host.textContent || '')
    assert.equal(host.textContent?.includes('发送消息时附上当前画面'), false)
    assert.equal(uploads, 0)
    if (mode === 'inline') {
      assert.ok(host.querySelector('.digital-person-camera-actions .digital-person-camera-switch'), 'switch and close share one toolbar')
    }
    const video = host.querySelector('video')!
    Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, readyState: { value: 2 } })
    let content = ''
    await act(async () => { content = await prepare!('看看这个') })
    assert.match(content, /^看看这个\n\n!\[.*\]\(\.workstep\/uploads\/frame.jpg\)$/)
    assert.equal(uploads, 1); assert.equal(draws, 1)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
    assert.equal(stops, 1)
    assert.equal(await prepare!('再次发送'), '再次发送')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close(); fsApi.uploadImage = oldUpload
  }
})

test('late camera permission after unmount releases camera without uploading', async () => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  let resolve!: (value: any) => void, stops = 0
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise(r => { resolve = r }) } })
  try {
    await act(async () => root.render(<I18nProvider><DigitalPersonCamera autoStart /></I18nProvider>))
    await act(async () => root.unmount())
    await act(async () => resolve({ getTracks: () => [{ stop() { stops++ } }] }))
    assert.equal(stops, 1)
  } finally { await window.happyDOM.close() }
})

for (const [scenario, expected] of [
  ['policy', '页面安全策略禁止使用摄像头'],
  ['insecure', '摄像头需要 HTTPS 或本机地址'],
  ['NotAllowedError', '摄像头权限未获允许'],
  ['NotFoundError', '未检测到摄像头'],
  ['NotReadableError', '摄像头无法启动'],
  ['OverconstrainedError', '摄像头不支持所请求的画面参数'],
  ['playback', '摄像头预览无法播放'],
] as const) {
  test(`camera distinguishes ${scenario} and never uploads on failure`, async () => {
    const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: scenario !== 'insecure' })
    let requests = 0, stops = 0
    Object.defineProperty(document, 'permissionsPolicy', { configurable: true, value: { allowsFeature: (name: string) => { assert.equal(name, 'camera'); return scenario !== 'policy' } } })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      requests++
      if (scenario === 'playback') return { getTracks: () => [{ stop() { stops++ } }], getVideoTracks: () => [] }
      throw new DOMException('device error', scenario)
    } } })
    window.HTMLVideoElement.prototype.play = async () => { throw new DOMException('autoplay blocked', 'NotAllowedError') }
    try {
      await act(async () => root.render(<I18nProvider><DigitalPersonCamera /></I18nProvider>))
      await act(async () => host.querySelector<HTMLButtonElement>('[data-camera-toggle]')!.click())
      assert.match(host.querySelector('[role=alert]')?.textContent || '', new RegExp(expected))
      assert.equal(requests, ['policy', 'insecure'].includes(scenario) ? 0 : 1)
      assert.equal(host.querySelector('.digital-person-camera')?.getAttribute('data-camera-phase'), 'off')
      if (scenario === 'playback') assert.equal(stops, 1)
    } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
  })
}

for(const portrait of [false,true]) test(`ordinary shared composer sends the visible frame when camera ignores portrait constraints (portrait=${portrait})`, async () => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  Object.assign(globalThis,{history:window.history,location:window.location})
  Object.defineProperties(window,{innerWidth:{configurable:true,value:portrait?390:1280},innerHeight:{configurable:true,value:844}})
  Object.defineProperty(window.screen,'orientation',{configurable:true,value:{type:portrait?'portrait-primary':'landscape-primary'}})
  let drawn: unknown[] = [], encoded: number[] = []
  let uploads = 0, stops = 0, sent = ''
  const oldUpload = fsApi.uploadImage
  const track = { stop() { stops++ }, addEventListener() {}, readyState: 'live' }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) } })
  window.HTMLVideoElement.prototype.play = async () => {}
  Object.defineProperty(window.HTMLVideoElement.prototype,'srcObject',{configurable:true,writable:true,value:null})
  window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage(...args: unknown[]) { drawn=args } })) as any
  window.HTMLCanvasElement.prototype.toBlob = function(callback) { encoded=[this.width,this.height];callback(new Blob(['frame'], { type: 'image/jpeg' })) }
  fsApi.uploadImage = async file => { uploads++; return { url: '.workstep/uploads/frame.jpg', filename: file.name, size: file.size } }
  try {
    await act(async () => root.render(<I18nProvider><ChatInput projectId="demo" sessionId="ordinary" value="看看这个" onChange={()=>{}} onSend={content=>{sent=content || 'missing'}} /></I18nProvider>))
    await act(async () => host.querySelector<HTMLButtonElement>('.chat-input-attach')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-camera-menu-toggle]')!.click())
    assert.equal(host.querySelector('[data-camera-phase]')?.getAttribute('data-camera-phase'),'on',host.textContent || '')
    assert.equal(uploads, 0, 'preview never uploads')
    Object.defineProperties(host.querySelector('video')!, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, readyState: { value: 2 } })
    await act(async () => host.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
    assert.match(sent, /^看看这个\n\n!\[.*\]\(\.workstep\/uploads\/frame.jpg\)$/)
    assert.equal(uploads, 1)
    assert.deepEqual(drawn.slice(1,5),[0,0,1920,1080],'send preserves the entire camera frame even on portrait phones')
    assert.ok(Math.abs(encoded[0]/encoded[1]-16/9)<.001)
    fsApi.uploadImage = async () => { throw new Error('上传失败，请重试') }
    sent = ''
    await act(async () => host.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
    assert.equal(sent, '', 'failed capture upload must block send')
    assert.match(host.querySelector('[role=alert]')?.textContent || '', /上传失败/)
    await act(async () => root.unmount())
    assert.equal(stops, 1)
  } finally { await act(async () => root.unmount()); fsApi.uploadImage=oldUpload; await window.happyDOM.close() }
})

for (const android of [false,true]) for (const nativeFrames of [true,false]) for (const [orientation, width, height] of [['portrait-primary',390,280], ['landscape-primary',390,700]] as const) test(`camera capture chooses the native frame preference (${orientation}, nativeFrames=${nativeFrames}, android=${android})`, async () => {
  const { window }=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  Object.defineProperty(document,'hidden',{configurable:true,value:false})
  Object.defineProperties(window,{innerWidth:{configurable:true,value:width},innerHeight:{configurable:true,value:height}})
  Object.defineProperty(window.screen,'orientation',{configurable:true,value:{type:orientation}})
  Object.defineProperty(navigator,'userAgent',{configurable:true,value:android?'Mozilla/5.0 (Linux; Android 14; wv)':'Mozilla/5.0 (Macintosh)'})
  let constraints: MediaStreamConstraints | undefined
  const track={stop(){},addEventListener(){},readyState:'live'}
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getSupportedConstraints:()=>({resizeMode:nativeFrames}),getUserMedia:async(value:MediaStreamConstraints)=>{constraints=value;return {getTracks:()=>[track],getVideoTracks:()=>[track]}}}})
  window.HTMLVideoElement.prototype.play=async()=>{}
  Object.defineProperty(window.HTMLVideoElement.prototype,'srcObject',{configurable:true,writable:true,value:null})
  try {
    await act(async()=>root.render(<I18nProvider><DigitalPersonCamera projectId="demo"/></I18nProvider>))
    await act(async()=>host.querySelector<HTMLButtonElement>('[data-camera-toggle]')!.click())
    const video=constraints!.video as MediaTrackConstraints
    const portrait=orientation.startsWith('portrait')
    assert.deepEqual(video.facingMode,{ideal:'environment'})
    assert.deepEqual(video.aspectRatio,nativeFrames?{ideal:android?4/3:portrait?9/16:16/9}:undefined,
      'Android rear cameras prefer a native 4:3 capture format in both orientations')
    assert.equal(video.width,undefined,'no width that may crop the native camera frame')
    assert.equal(video.height,undefined,'no height that may crop the native camera frame')
    assert.deepEqual(video.resizeMode,nativeFrames?{exact:'none'}:undefined,'disable capture-level crop and scale when supported')
    await act(async()=>host.querySelector<HTMLButtonElement>('.digital-person-camera-switch')!.click())
    const front=constraints!.video as MediaTrackConstraints
    assert.deepEqual(front.facingMode,{ideal:'user'})
    assert.deepEqual(front.aspectRatio,nativeFrames?{ideal:portrait?9/16:16/9}:undefined)
  } finally {await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('Android selects an exposed rear camera, remembers it and recovers if it disappears', async () => {
  const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  Object.defineProperty(document,'hidden',{configurable:true,value:false})
  Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (Linux; Android 14; wv)'})
  Object.defineProperty(window.HTMLVideoElement.prototype,'srcObject',{configurable:true,writable:true,value:null})
  window.HTMLVideoElement.prototype.play=async()=>{}
  const requests:MediaTrackConstraints[]=[]
  let available=true,stops=0
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
    getUserMedia:async ({video}:MediaStreamConstraints)=>{
      const constraints=video as MediaTrackConstraints
      requests.push(constraints)
      const id=(constraints.deviceId as ConstrainDOMStringParameters|undefined)?.exact
      if(id==='rear-two'&&!available)throw new DOMException('','NotFoundError')
      const track={stop(){stops++},addEventListener(){},getSettings:()=>({deviceId:id??'rear-one'})}
      return {getTracks:()=>[track],getVideoTracks:()=>[track]}
    },
    enumerateDevices:async()=>[
      {kind:'videoinput',deviceId:'rear-one',label:'camera2 0, facing back'},
      ...(available?[{kind:'videoinput',deviceId:'rear-two',label:'camera2 2, facing back'}]:[]),
      {kind:'videoinput',deviceId:'front',label:'camera2 1, facing front'},
    ],
  }})
  const click=async(selector:string)=>{await act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click())}
  try{
    await act(async()=>root.render(<I18nProvider><DigitalPersonCamera /></I18nProvider>))
    await click('[data-camera-toggle]')
    await click('.digital-person-camera-switch')
    assert.equal(requests.length,1)
    const options=[...document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')]
    assert.equal(options.length,3)
    assert.equal(options[0]?.dataset.selected,'true')
    await act(async()=>options[1]!.click())
    assert.deepEqual(requests.at(-1)?.deviceId,{exact:'rear-two'})
    assert.equal(stops,1)
    await click('[data-camera-toggle]')
    await click('[data-camera-toggle]')
    assert.deepEqual(requests.at(-1)?.deviceId,{exact:'rear-two'})
    await click('[data-camera-toggle]')
    available=false
    await click('[data-camera-toggle]')
    assert.deepEqual(requests.at(-2)?.deviceId,{exact:'rear-two'})
    assert.equal(requests.at(-1)?.deviceId,undefined)
    assert.equal(host.querySelector('[data-camera-phase]')?.getAttribute('data-camera-phase'),'on')
  }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
