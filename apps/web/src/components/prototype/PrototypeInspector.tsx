import { useState } from 'react'
import type { PrototypeDocument, PrototypeSelection } from '../../api/prototype'
import { useI18n } from '../../i18n'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import PrototypeStyleField from './PrototypeStyleField'

type Props = {
  selection: PrototypeSelection | null
  document: PrototypeDocument | null
  disabled: boolean
  onParent: () => void
  onPreview: (node: string, operation: string, values: Record<string,string>, version: string) => void
  onResetPreview: (node: string) => void
  onEdit: (node: string, operation: string, values: Record<string,string>, version: string) => Promise<void>
}

export default function PrototypeInspector({selection, document, disabled, onParent, onEdit, onPreview, onResetPreview}: Props) {
  const {t} = useI18n()
  const [deleting, setDeleting] = useState(false)
  const node = selection?.node_id ? document?.nodes[selection.node_id] : null
  const textValue = node?.text_value ?? selection?.text ?? ''
  const preview = (operation: string, values: Record<string,string>) => {
    if (selection?.node_id && !disabled) onPreview(selection.node_id, operation, values, selection.version)
  }
  const resetPreview = () => { if (selection?.node_id) onResetPreview(selection.node_id) }
  const edit = (operation: string, values: Record<string,string>) => {
    if (selection?.node_id) void onEdit(selection.node_id, operation, values, selection.version)
  }
  return <aside className="prototype-properties">
    <strong>{t('prototype.selected')}</strong>
    {selection ? <>
      <code>{selection.tag}{selection.classes ? `.${selection.classes}` : ''}</code>
      <Button variant="ghost" onClick={onParent}>{t('prototype.parent')}</Button>
      {!node?.editable && <p>{t('prototype.dynamic')}</p>}
      {node?.text_editable && <label key={`${selection.node_id}:${document?.version}:text`}>
        <span>{t('prototype.text')}</span>
        <textarea aria-label={t('prototype.text')} defaultValue={textValue} disabled={disabled}
          onChange={event=>preview('text',{text:event.target.value})}
          onBlur={event=>{if(event.target.value !== textValue) edit('text', {text:event.target.value});else resetPreview()}} />
      </label>}
      {['color','background-color','font-size','font-weight','border-radius','width','height','padding','margin'].map(property =>
        <PrototypeStyleField key={`${selection.node_id}:${document?.version}:${property}`} property={property} value={selection.styles[property]||''} disabled={!node?.editable||disabled}
          onPreview={value=>preview('style',{[property]:value})} onCommit={value=>edit('style',{[property]:value})} onResetPreview={resetPreview}/>)}
      <Button variant="danger" disabled={!node?.editable || disabled} onClick={()=>setDeleting(true)}>{t('prototype.delete')}</Button>
    </> : <p>{t('prototype.selectHint')}</p>}
    <ConfirmDialog open={deleting} title={t('prototype.delete')} danger onCancel={()=>setDeleting(false)}
      onConfirm={()=>{setDeleting(false);edit('delete', {})}} />
  </aside>
}
