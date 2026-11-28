import { useState } from 'react'
import ArtifactTemplateDialog from './ArtifactTemplateDialog'
import { useI18n } from '../i18n'
import { DEFAULT_OUTPUT_TYPE, OUTPUT_TYPES } from '../config/outputTypes'
import type { OutputField } from './flowCanvasData'
import Button from './Button'
import Input from './Input'
import Combobox from './Combobox'
import './ArtifactOutputsEditor.css'

export default function ArtifactOutputsEditor({ outputs, onChange, protectedCount = 0, appendDisabled = false, sourceOutputs, nested = false }: {
  outputs: OutputField[]; sourceOutputs?: OutputField[]; onChange: (outputs: OutputField[]) => void; protectedCount?: number; appendDisabled?: boolean; nested?: boolean
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState<number | null>(null)
  const update = (index: number, field: 'name' | 'type' | 'template', value: string) =>
    onChange(outputs.map((output, i) => i === index ? { ...output, [field]: value } : output))
  const setGlobal = (index: number, checked: boolean) => onChange(outputs.map((output, i) => {
    if (i !== index) return output
    const next = { ...output }
    if (checked) next.global = true
    else delete next.global
    return next
  }))
  return <div className={nested ? 'artifact-outputs-editor artifact-outputs-editor--nested' : 'artifact-outputs-editor'}>
    {outputs.map((output, index) => <div key={index} className="artifact-output-row">
      <label className="artifact-output-global">
        <input type="checkbox" checked={output.global === true} disabled={index < protectedCount}
          aria-label={output.name ? `${output.name} · ${t('flow.globalOutput')}` : t('flow.globalOutput')}
          onChange={event => setGlobal(index, event.target.checked)} />
        {t('flow.globalOutput')}
      </label>
      <Input disabled={index < protectedCount} value={output.name} placeholder={t('flow.outputName')}
        onChange={(event) => update(index, 'name', event.target.value)} />
      <Button variant="ghost" className="artifact-template-button" data-configured={Boolean(output.template?.trim())}
        aria-label={`${t('artifactTemplate.title')} · ${output.name}`} onClick={() => setEditing(index)}>{t('artifactTemplate.title')}</Button>
      <Combobox disabled={index < protectedCount} value={output.type} options={OUTPUT_TYPES}
        onChange={(value) => update(index, 'type', value)} />
      <Button variant="icon" className="artifact-output-remove" disabled={index < protectedCount}
        onClick={() => onChange(outputs.filter((_, i) => i !== index))}>×</Button>
    </div>)}
    <Button variant="ghost" disabled={appendDisabled}
      onClick={() => onChange([...outputs, { name: '', type: DEFAULT_OUTPUT_TYPE }])}>{t('flow.addSubOutput')}</Button>
    {editing !== null && outputs[editing] && <ArtifactTemplateDialog name={outputs[editing].name}
      value={outputs[editing].template || ''} sourceValue={sourceOutputs?.[editing] ? sourceOutputs[editing].template || '' : undefined} onClose={() => setEditing(null)}
      onSave={template => update(editing, 'template', template)} />}
  </div>
}
