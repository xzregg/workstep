import { useState } from 'react'
import type { TaskWorkflowConfiguration } from '../api/taskWorkflow'
import { taskWorkflowApi } from '../api/taskWorkflow'
import ArtifactTemplateDialog from './ArtifactTemplateDialog'

interface Props {
  taskId: string
  projectId: string
  stepKey: string
  outputIndex: number
  name: string
  value: string
  configuration?: TaskWorkflowConfiguration
  onSaved?: (value: TaskWorkflowConfiguration) => void
  onClose: () => void
}

export function setOutputTemplate(workflow: any, stepKey: string, outputIndex: number, template: string) {
  const next = structuredClone(workflow)
  const node = next.nodes.find((item: any) => item.type === stepKey)
  const output = node?.outputs?.[outputIndex]
  if (!output) throw new Error('Output not found')
  output.template = template
  for (const input of node.inputs || []) {
    for (const nested of input.outputs || []) {
      if (nested.name === output.name && nested.type === output.type) nested.template = template
    }
  }
  return next
}

export default function TaskArtifactTemplateEditor({ taskId, projectId, stepKey, outputIndex,
  name, value, configuration, onSaved, onClose }: Props) {
  const [initial] = useState(configuration)
  const editable = configuration?.editable && !configuration.conflict && onSaved
  const source = configuration?.source?.nodes?.find((node: any) => node.type === stepKey)?.outputs?.[outputIndex]
  return <ArtifactTemplateDialog name={name} value={value} sourceValue={source ? source.template || '' : undefined}
    onClose={onClose} onSave={editable ? async template => {
      const workflow = setOutputTemplate(initial!.workflow, stepKey, outputIndex, template)
      const result = await taskWorkflowApi.save(taskId, projectId, workflow, initial!.revision)
      onSaved(result)
    } : undefined} />
}
