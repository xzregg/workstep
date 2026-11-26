import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import WorkflowCreateDialog from '../../../src/components/WorkflowCreateDialog'
import { I18nProvider, useLocaleStore } from '../../../src/i18n'
import { workflowGenApi } from '../../../src/api/client'
import { useWorkflowGenStore } from '../../../src/stores/workflowGenStore'
import '../../../src/index.css'
import '../../../src/mobile.css'

useLocaleStore.setState({locale:'zh-CN'})
const stops: string[] = []
let sessionId = ''
let failStop = false
let accept: (() => void) | undefined
workflowGenApi.chat = async (_project, _content, sid) => {
  sessionId = sid!
  await new Promise<void>(resolve => { accept = resolve })
  return {session_id:sessionId,turn_id:'u',assistant_message_id:'a',status:'queued'}
}
workflowGenApi.stop = async (sid) => { stops.push(sid); return {stopped:!failStop} }
Object.assign(window, {workflowCreateFixture:{
  accept: () => accept?.(),
  failStop: (value: boolean) => { failStop = value },
  stops: () => stops,
  session: () => sessionId,
  complete: () => useWorkflowGenStore.getState().markStopped(sessionId),
}})
function App() {
  const [open, setOpen] = useState(true)
  return <><button onClick={() => setOpen(true)}>重新打开</button>{open && <WorkflowCreateDialog projectId="fixture" onClose={() => setOpen(false)} />}</>
}
createRoot(document.getElementById('root')!).render(<I18nProvider><MemoryRouter><App /></MemoryRouter></I18nProvider>)
