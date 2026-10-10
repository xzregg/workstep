import { useState } from 'react'
import WorkflowHooksDialog from './WorkflowHooksDialog'
import NotificationHooksDialog from './NotificationHooksDialog'

export default function WorkflowHookManagerDialog(props: {projectId:string;workflowId:string;workflowName:string;onClose:()=>void}) {
  const [kind,setKind]=useState<'trigger'|'notification'>('trigger')
  return kind==='trigger'
    ? <WorkflowHooksDialog {...props} onSwitchType={()=>setKind('notification')}/>
    : <NotificationHooksDialog {...props} onSwitchType={()=>setKind('trigger')}/>
}
