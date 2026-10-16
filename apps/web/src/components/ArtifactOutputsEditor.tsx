import { useI18n } from '../i18n'
import { DEFAULT_OUTPUT_TYPE, OUTPUT_TYPES } from '../config/outputTypes'
import type { OutputField } from './flowCanvasData'
import Button from './Button'
import Input from './Input'
import Combobox from './Combobox'
import './ArtifactOutputsEditor.css'

export default function ArtifactOutputsEditor({ outputs, onChange, protectedCount = 0, appendDisabled = false }: {
  outputs: OutputField[]; onChange: (outputs: OutputField[]) => void; protectedCount?: number; appendDisabled?: boolean
}) {
  const { t } = useI18n()
  const update = (index: number, field: 'name' | 'type', value: string) =>
    onChange(outputs.map((output, i) => i === index ? { ...output, [field]: value } : output))
  return <div className="artifact-outputs-editor">
    {outputs.map((output, index) => <div key={index} className="artifact-output-row">
      <span aria-hidden="true">↳</span>
      <Input disabled={index < protectedCount} value={output.name} placeholder={t('flow.outputName')}
        onChange={(event) => update(index, 'name', event.target.value)} />
      <Combobox disabled={index < protectedCount} value={output.type} options={OUTPUT_TYPES}
        onChange={(value) => update(index, 'type', value)} />
      <Button variant="icon" className="artifact-output-remove" disabled={index < protectedCount}
        onClick={() => onChange(outputs.filter((_, i) => i !== index))}>×</Button>
    </div>)}
    <Button variant="ghost" disabled={appendDisabled}
      onClick={() => onChange([...outputs, { name: '', type: DEFAULT_OUTPUT_TYPE }])}>{t('flow.addSubOutput')}</Button>
  </div>
}
