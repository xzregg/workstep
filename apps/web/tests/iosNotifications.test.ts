import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomEnvironment } from './helpers/domEnv'
import { postAndroidCompletion } from '../../../packages/gateway-ui/src/androidNotifications'
import { completionNotice, notifyCompletion } from '../src/utils/completionNotifications'

test('iOS receives completion through shared bridge without Android alias', async () => {
  const { window } = installDomEnvironment()
  const sent: any[] = []
  window.WorkStepIOS = { postMessage: raw => sent.push(JSON.parse(raw)) }
  const notice = completionNotice({ type: 'TEXT_MESSAGE_END', project_id: 'p', session_id: 's', messageId: 'ios-result', status: 'succeeded' })!
  notifyCompletion(notice, '/chat?project=p&session=s')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].id, 'p:s:ios-result')
  assert.equal(window.WorkStepAndroid, undefined)
  await window.happyDOM.close()
})

test('iOS shares gateway scoping and workspace destination with Android', async () => {
  const { window } = installDomEnvironment()
  const sent: any[] = []
  window.WorkStepIOS = { postMessage: raw => sent.push(JSON.parse(raw)) }
  postAndroidCompletion({ type: 'notify', id: 'p:s:m', projectId: 'p', sessionId: 's',
    url: '/workspace/device/chat?project=p&session=s' }, 'device')
  assert.equal(sent[0].projectId, 'gateway/device/p')
  assert.equal(sent[0].workspaceUrl, '/workspace/device/chat?project=p&session=s')
  await window.happyDOM.close()
})
