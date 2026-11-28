import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomEnvironment } from './helpers/domEnv'
import { DirectHtmlResources } from '../src/webrtc/directHtmlResources'
import { fsApi } from '../src/api/client'

test('direct HTML resolves only ticket resources, including CSS fonts and child frames', async () => {
  const {window} = installDomEnvironment()
  window.happyDOM.setURL('http://localhost/p2p/device/')
  const root = 'http://localhost/api/fs/html-resource/project/ticket/'
  const requests: string[] = []
  const previous = globalThis.fetch
  const responses = new Map([
    ['index.html', '<link rel="stylesheet" href="styles/main.css"><script src="app.js"></script><img src="../secret.png"><iframe src="child.html"></iframe>'],
    ['styles/main.css', '@font-face{font-family:demo;src:url(../font.woff2)}body{color:red}'],
    ['app.js', 'document.body.dataset.ready="yes"'],
    ['child.html', '<h1>Child</h1>'], ['font.woff2', 'font'],
  ])
  globalThis.fetch = async input => {
    const url = new URL(String(input)); requests.push(url.href)
    assert.ok(url.href.startsWith(root))
    const body = responses.get(url.pathname.slice(new URL(root).pathname.length))
    return new Response(body || 'missing', {status:body ? 200 : 404})
  }
  const resources = new DirectHtmlResources(root)
  try {
    const html = await resources.document(root+'index.html')
    assert.ok(html.includes('data:text/css'))
    assert.ok(html.includes('data:text/javascript'))
    assert.ok(!html.includes('src="../secret.png"'))
    assert.ok(html.includes('src="data:text/html;base64,'))
    assert.ok(html.includes("connect-src 'none'"))
    assert.equal(requests.length, 5)
  } finally {
    resources.dispose(); globalThis.fetch=previous; await window.happyDOM.close()
  }
})

test('editing keeps the host nonce policy and does not load page scripts or escaped resources',async()=>{
  const {window}=installDomEnvironment()
  const previous=globalThis.fetch
  const root='http://localhost/api/fs/html-resource/project/ticket/'
  const calls:string[]=[]
  globalThis.fetch=async input=>{
    calls.push(String(input))
    return new Response('<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-ticket\'; frame-src http://localhost/"><script src="app.js"></script><script>untrusted()</script><script nonce="ticket">trusted()</script><img src="https://other.example/private.png">',{headers:{'Content-Type':'text/html'}})
  }
  const resources=new DirectHtmlResources(root)
  try{
    const html=await resources.document(root+'index.html')
    assert.equal(calls.length,1)
    assert.ok(!html.includes('untrusted()'))
    assert.ok(html.includes('trusted()'))
    assert.ok(html.includes("script-src 'nonce-ticket'"))
    assert.ok(!html.includes('https://other.example'))
    await assert.rejects(resources.document(root+'../private.html'),/denied/)
  }finally{resources.dispose();globalThis.fetch=previous;await window.happyDOM.close()}
})


test('nested prototype entries preserve their directory when loading linked resources', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://localhost/p2p/device/')
  const root = 'http://localhost/api/fs/html-resource/project/ticket/'
  const previous = globalThis.fetch
  const requests: string[] = []
  const responses = new Map([
    ['plans/应用 设计/architecture.html', '<link rel="stylesheet" href="styles.css"><script src="diagrams.js"></script><h1>Architecture</h1>'],
    ['plans/应用 设计/styles.css', 'h1{color:red}'],
    ['plans/应用 设计/diagrams.js', 'document.body.dataset.loaded="yes"'],
  ])
  globalThis.fetch = async input => {
    const url = new URL(String(input), window.location.href)
    const resource = decodeURIComponent(url.pathname.slice(new URL(root).pathname.length))
    requests.push(resource)
    const body = responses.get(resource)
    return new Response(body || 'missing', {status:body ? 200 : 404})
  }
  const resources = new DirectHtmlResources(root)
  try {
    const entry = fsApi.htmlPreviewUrl({token:'ticket',entry:'plans/应用 设计/architecture.html'}, 'project')
    const html = await resources.document(new URL(entry, window.location.href).href)
    assert.ok(html.includes('data:text/css'))
    assert.ok(html.includes('data:text/javascript'))
    assert.deepEqual(requests, ['plans/应用 设计/architecture.html', 'plans/应用 设计/styles.css', 'plans/应用 设计/diagrams.js'])
  } finally {
    resources.dispose()
    globalThis.fetch = previous
    await window.happyDOM.close()
  }
})
