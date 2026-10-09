import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomEnvironment } from './helpers/domEnv'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { workflowGenApi, taskDraftApi, pendingMessageInsertApi } from '../src/api/conversations'
import { fsApi, templateApi } from '../src/api/client'
import { projectApi } from '../src/api/project'
import { scheduleApi } from '../src/api/schedule'

test('remote workspace request bodies, path resources, templates and preview share project identity', async () => {
 const { window } = installDomEnvironment()
 window.history.replaceState({}, '', '/workspace/device-1/chat')
 useGatewaySessionStore.setState({ session: { device_id:'device-1', device_name:'Device', username:'test', gateway_url:window.location.origin + '/devices', project_id:'published', host_project_id:'visible', access_level:'edit', task_create:true, share_create:false, can_manage_project_access:false } })
 const original = globalThis.fetch
 const urls: string[] = []
 globalThis.fetch = async input => { urls.push(String(input)); return Response.json({}) }
 try {
  await workflowGenApi.chat('visible','hello',null,'turn-1')
  await taskDraftApi.chat('visible','hello',null,'draft-1',{ title:'Task' })
  await pendingMessageInsertApi.create('visible','message-1','later')
  await pendingMessageInsertApi.update('visible','insert-1','updated')
  await pendingMessageInsertApi.reorder('visible','message-1',[])
  await fsApi.createEntry('visible',undefined,'','demo','directory')
  await fsApi.saveContent('visible',undefined,'demo.txt','text','')
  await templateApi.list(); await templateApi.get('development')
  await projectApi.settings('visible', true); await projectApi.concurrency('visible')
  await projectApi.setConcurrency('visible',{ maxTasks:1,maxChats:1,scheduleExempt:false })
  await scheduleApi.preview({ kind:'daily',time:'09:00',timezone:'Asia/Shanghai' })
  for (const url of urls) assert.notEqual(new URL(url,'http://workstep.local').searchParams.get('with_share'),'true',url)
  for (const url of urls) assert.equal(new URL(url,'http://workstep.local').searchParams.get('project_id'),'visible',url)
  const count = urls.length
  await assert.rejects(() => fsApi.createEntry('private',undefined,'','escape','directory'), /项目范围不匹配/)
  assert.equal(urls.length,count)
 } finally { globalThis.fetch=original; useGatewaySessionStore.setState({ session:null }); await window.happyDOM.close() }
})
