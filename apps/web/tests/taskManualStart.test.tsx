import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import TaskManualStartControls from '../src/components/TaskManualStartControls'
import TaskDetailView from '../src/components/TaskDetailView'
import { taskDisplayStatus } from '../src/utils/taskDisplayStatus'
import { useTaskStore } from '../src/stores/taskStore'

test('manual step controls identify waiting branches, prevent duplicate clicks and allow failure retry', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const long = '开发实现与主题切换兼容性处理及验收准备'
  let finish: () => void = () => {}, calls: string[] = []
  const start = async (key: string) => { calls.push(key); await new Promise<void>(resolve => { finish = resolve }); throw new Error('启动失败') }
  try {
    await act(async () => root.render(<I18nProvider><TaskManualStartControls
      steps={[{key:'build',label:long},{key:'publish',label:'发布'},{key:'test',label:'测试'}]}
      stepProgress={[{step_key:'build',status:'awaiting_start'}, {step_key:'publish',status:'pending'}, {step_key:'test',status:'awaiting_start'}]}
      onStart={start}/></I18nProvider>))
    const buttons = [...host.querySelectorAll('button')]
    assert.equal(buttons.length, 2)
    assert.equal(host.querySelector('.task-manual-start-name')?.getAttribute('title'), long)
    assert.ok(!host.textContent?.includes('待手动开始'), 'no duplicate status in the compact action row')
    await act(async () => { buttons[0].click(); buttons[0].click() })
    assert.deepEqual(calls, ['build'])
    assert.equal(buttons[0].disabled, true)
    assert.equal(buttons[0].getAttribute('aria-busy'), 'true')
    await act(async () => finish())
    assert.match(host.querySelector('[role=alert]')?.textContent || '', /启动失败/)
    assert.equal(buttons[0].disabled, false)
    await act(async () => buttons[0].click())
    assert.deepEqual(calls, ['build', 'build'])
    await act(async () => finish())
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('read only task details cannot start a step', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  try {
    await act(async () => root.render(<I18nProvider><TaskManualStartControls
      steps={[{key:'build',label:'开发'}]} stepProgress={[{step_key:'build',status:'awaiting_start'}]}/></I18nProvider>))
    assert.equal(host.querySelectorAll('button').length, 0)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('task details place step start next to workflow editing and show a static waiting graph status', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({locale:'zh-CN'})
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const step = {key:'build',label:'开发实现',color:'blue',prompt:'',inputs:[],outputs:[]}
  const onStart = async () => {}
  try {
    await act(async () => root.render(<I18nProvider><TaskDetailView {...{
      task:{id:'manual-task',title:'手动任务',status:'waiting',status_reason:'manual_start',steps:[{step_key:'build',status:'awaiting_start'}],created_at:'2026-11-28T00:00:00Z'},
      steps:[step], stepProgress:[{step_key:'build',status:'awaiting_start',visualState:'awaiting_start'}],
      selectedStep:0,onStepClick:()=>{},currentStep:step,activeStep:step,currentStepColor:'blue',activeStepColor:'blue',
      taskCompleted:false,runningSteps:[],executionStepModel:'',sessionIdForStep:()=>null,onViewingPromptChange:()=>{},
      historyMessages:[],liveMessages:{},events:[],content:'',reviews:[],artifacts:[],locale:'zh-CN',durationNowMs:Date.now(),
      workflowTools:<div className="task-workflow-tools"><button>编辑任务流程</button></div>,
      onStartStep:onStart,chatEnabled:false,actionEnabled:false,
    } as any}/></I18nProvider>))
    const toolbar=host.querySelector('.task-step-toolbar')!
    assert.ok(toolbar.querySelector('.task-workflow-tools'))
    assert.ok(toolbar.querySelector('.task-manual-start-item'))
    assert.ok(Boolean(toolbar.compareDocumentPosition(host.querySelector('.task-step-io')!) & window.Node.DOCUMENT_POSITION_FOLLOWING))
    const card=host.querySelector('.task-step-progress-card.is-awaiting_start')!
    assert.match(card.textContent||'',/待手动开始/)
    assert.equal(Boolean(card.querySelector('.is-spinning')),false)
    assert.ok(!toolbar.textContent?.includes('待手动开始'))
  } finally {await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('manual waits round-trip through status events and clear when the step runs', () => {
  const steps=[{step_key:'build',status:'pending'}]
  useTaskStore.setState({tasks:[{id:'manual',status:'running',steps} as any],events:{},liveMessages:{},content:{}})
  const status=(value:string)=>useTaskStore.getState().handleWsEvent({type:'CUSTOM',name:'workstep.status',task_id:'manual',step_key:'build',value:{status:value,step_key:'build'}})
  status('awaiting_start')
  let task=useTaskStore.getState().tasks[0]
  assert.equal(task.status,'waiting')
  assert.equal(task.status_reason,'manual_start')
  assert.equal(taskDisplayStatus(task.status,task.steps,false,task.status_reason).displayStatus,'awaiting_start')
  status('running')
  task=useTaskStore.getState().tasks[0]
  assert.equal(task.status,'running')
  assert.deepEqual(task.pending_confirmations,[])
  assert.equal(task.steps[0].waiting_reason,null)
})
