import { useState } from 'react'
import { useProjectStore } from '../stores/projectStore'
import Icon from './Icon'
import SidebarRenameField from './SidebarRenameField'
import './WorkflowNameEditor.css'

interface Props {
  projectId: string
  workflowId: string
  name: string
  canEdit: boolean
}

export default function WorkflowNameEditor({ projectId, workflowId, name, canEdit }: Props) {
  const [editing, setEditing] = useState(false)
  const renameWorkflow = useProjectStore((state) => state.renameWorkflow)

  return (
    <span className="workflow-name-editor" data-editing={editing && canEdit}>
      <Icon name="workflow" size={13} strokeWidth={2} />
      {editing && canEdit ? (
        <SidebarRenameField
          kind="workflow"
          initialName={name}
          onSave={(value) => renameWorkflow(workflowId, projectId, value)}
          onClose={() => setEditing(false)}
        />
      ) : (
        <span className="workflow-name-editor-title" title={name} onDoubleClick={() => { if (canEdit) setEditing(true) }}>
          {name}
        </span>
      )}
    </span>
  )
}
