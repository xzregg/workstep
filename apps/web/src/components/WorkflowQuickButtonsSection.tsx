import { useState } from 'react'
import type { ChatQuickButton } from '../api/client'
import { useI18n } from '../i18n'
import { randomUuid } from '../utils/uuid'
import ActionButtonFields from './ActionButtonFields'
import Button from './Button'
import Field from './Field'
import Input from './Input'
import QuickPromptButton from './QuickPromptButton'
import Select from './Select'
import Textarea from './Textarea'

interface Props {
  projectId: string
  workflowId: string
  buttons: ChatQuickButton[]
  onChange: (buttons: ChatQuickButton[]) => void
}

export default function WorkflowQuickButtonsSection({ projectId, workflowId, buttons, onChange }: Props) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = buttons.find((button) => button.id === selectedId) || buttons[0]
  const update = (next: ChatQuickButton) => onChange(buttons.map((button) => button.id === next.id ? next : button))
  const add = () => {
    const id = `qb-${randomUuid()}`
    onChange([...buttons, { id, kind: 'prompt', label: '', prompt: '', immediate_send: false }])
    setSelectedId(id)
  }

  return <section style={{ marginTop: 18 }}>
    <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8, marginBottom: 10, fontWeight: 600 }}>{t('actionShortcuts.quickButtons')}</div>
    <p style={{ color: 'var(--muted)', marginBottom: 10, fontSize: 'calc(12px * var(--font-scale))' }}>{t('actionShortcuts.stageHint')}</p>
    <div style={{ display: 'grid', gridTemplateColumns: '148px minmax(0, 1fr)', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {buttons.map((button) => <Button key={button.id} variant={selected?.id === button.id ? 'primary' : 'ghost'} onClick={() => setSelectedId(button.id)} style={{ justifyContent: 'flex-start' }}>{button.label || t('projectSettings.assistant.newButton')}</Button>)}
        <Button variant="ghost" onClick={add} style={{ justifyContent: 'flex-start' }}>{t('actionShortcuts.add')}</Button>
      </div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {selected && <>
          <Field label={t('projectSettings.assistant.buttonType')}>
            <Select value={selected.kind || 'prompt'} onChange={(event) => update({ ...selected, kind: event.target.value as ChatQuickButton['kind'], prompt: event.target.value === 'prompt' ? selected.prompt : '' })}>
              <option value="prompt">{t('actionShortcuts.typePrompt')}</option><option value="display">{t('projectSettings.assistant.buttonTypeDisplay')}</option><option value="action">{t('projectSettings.assistant.buttonTypeAction')}</option>
            </Select>
          </Field>
          <Field label={t('projectSettings.assistant.buttonLabel')} required><Input value={selected.label} onChange={(event) => update({ ...selected, label: event.target.value })} /></Field>
          {(selected.kind || 'prompt') === 'prompt' && <>
            <Field label={t('actionShortcuts.text')}><Textarea value={selected.prompt} onChange={(event) => update({ ...selected, prompt: event.target.value })} /></Field>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={selected.immediate_send === true} onChange={(event) => update({ ...selected, immediate_send: event.target.checked })} />{t('actionShortcuts.immediateSend')}</label>
          </>}
          {selected.kind === 'display' && <p style={{ color: 'var(--muted)' }}>{t('actionShortcuts.displayHint')}</p>}
          {selected.kind === 'display' && <>
            <Field label={t('projectSettings.assistant.buttonContent')}>
              <Textarea value={selected.content || ''} onChange={(event) => update({ ...selected, content: event.target.value })} />
            </Field>
            {selected.content && <QuickPromptButton label={selected.label} prompt="" displayOnly displayContent={selected.content} onSelect={() => {}} />}
          </>}
          {selected.kind === 'action' && <ActionButtonFields
            projectId={projectId} workflowId={workflowId}
            value={{ actionId: selected.action_id || '', scriptPath: selected.script_path || '', cwdMode: selected.cwd_mode || 'task', requireConfirmation: selected.require_confirmation !== false, confirmationInputPrompt: selected.confirmation_input_prompt || '' }}
            onChange={(value) => update({ ...selected, action_id: value.actionId, script_path: value.scriptPath, cwd_mode: value.cwdMode, require_confirmation: value.requireConfirmation, confirmation_input_prompt: value.confirmationInputPrompt })}
          />}
          <Button variant="ghost" onClick={() => {
            onChange(buttons.filter((button) => button.id !== selected.id))
            setSelectedId(null)
          }} style={{ color: 'var(--danger)', alignSelf: 'flex-start' }}>{t('actionShortcuts.delete')}</Button>
        </>}
      </div>
    </div>
  </section>
}
