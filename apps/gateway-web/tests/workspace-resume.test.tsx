import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { rememberWorkspacePage, restoredWorkspacePage } from '../../../packages/gateway-ui/src/workspaceResume'

test('remembers the last device conversation across new browser sessions',()=>{
 const first=new JSDOM('',{url:'https://gateway.test/workspace/device-2/chat?project=demo&session=reply-7'})
 rememberWorkspacePage(first.window.location.href,first.window.localStorage)
 const persisted=first.window.localStorage.getItem('workstep:last-workspace-page')!
 const reopened=new JSDOM('',{url:'https://gateway.test/'})
 reopened.window.localStorage.setItem('workstep:last-workspace-page',persisted)
 assert.deepEqual(restoredWorkspacePage(reopened.window.localStorage),{
  deviceId:'device-2',next:'chat?project=demo&session=reply-7',
 })
 first.window.close();reopened.window.close()
})

test('portal and unrelated pages cannot replace the last conversation',()=>{
 const dom=new JSDOM('',{url:'https://gateway.test/'})
 const storage=dom.window.localStorage
 rememberWorkspacePage('https://gateway.test/workspace/device-2/chat?project=demo&session=reply-7',storage)
 rememberWorkspacePage('https://gateway.test/',storage)
 rememberWorkspacePage('https://gateway.test/workspace/device-1/chat?project=demo',storage)
 assert.equal(restoredWorkspacePage(storage)?.next,'chat?project=demo&session=reply-7')
 dom.window.close()
})
