import { useState } from 'react'
import type { PrototypeDocument, PrototypeSelection } from '../../api/prototype'
import { useI18n } from '../../i18n'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'

type Props = {
  selection: PrototypeSelection | null
  document: PrototypeDocument | null
  disabled: boolean
  onParent: () => void
  onEdit: (node: string, operation: string, values: Record<string,string>, version: string) => Promise<void>
}

export default function PrototypeInspector({selection, document, disabled, onParent, onEdit}: Props) {
  const {t} = useI18n()
  const [deleting, setDeleting] = useState(false)
  const node = selection?.node_id ? document?.nodes[selection.node_id] : null
  const textValue = node?.text_value ?? selection?.text ?? ''
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
          onBlur={event=>{if(event.target.value !== textValue) edit('text', {text:event.target.value})}} />
      </label>}
      {['color','background-color','font-size','font-weight','border-radius','width','height','padding','margin'].map(property =>
        <label key={`${selection.node_id}:${document?.version}:${property}`}>
          <span>{property}</span>
          <div className="prototype-property-value">
            {property.includes('color') && <input type="color" aria-label={`${property} picker`}
              disabled={!node?.editable || disabled} defaultValue={toHex(selection.styles[property])}
              onBlur={event=>{if(event.target.value !== toHex(selection.styles[property])) edit('style',{[property]:event.target.value})}} />}
            <input aria-label={property} disabled={!node?.editable || disabled} defaultValue={selection.styles[property]}
              onBlur={event=>{if(event.target.value !== selection.styles[property]) edit('style', {[property]:event.target.value})}}
              onKeyDown={event=>{if(event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()}} />
          </div>
        </label>)}
      <Button variant="danger" disabled={!node?.editable || disabled} onClick={()=>setDeleting(true)}>{t('prototype.delete')}</Button>
    </> : <p>{t('prototype.selectHint')}</p>}
    <ConfirmDialog open={deleting} title={t('prototype.delete')} danger onCancel={()=>setDeleting(false)}
      onConfirm={()=>{setDeleting(false);edit('delete', {})}} />
  </aside>
}

function toHex(value = '') {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  const components = value.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/)
  return components ? '#' + components.slice(1,4).map(v=>Number(v).toString(16).padStart(2,'0')).join('') : '#000000'
}
