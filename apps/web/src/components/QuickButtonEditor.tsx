import { useRef, useState } from 'react'
import type { ChatQuickButton } from '../api/client'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n } from '../i18n'
import { randomUuid } from '../utils/uuid'
import ActionButtonFields from './ActionButtonFields'
import Button from './Button'
import Field from './Field'
import Input from './Input'
import MarkdownEditor from './MarkdownEditor'
import MarqueeText from './MarqueeText'
import QuickPromptButton from './QuickPromptButton'
import Select from './Select'
import Textarea from './Textarea'
import './QuickButtonEditor.css'

export interface QuickButtonDraft {
  id: string
  label: string
  prompt: string
  content: string
  kind: '' | 'prompt' | 'display' | 'action'
  enabled?: boolean
  immediateSend: boolean
  actionId: string
  scriptPath: string
  cwdMode: 'project' | 'task' | 'worktrees'
  requireConfirmation: boolean
  confirmationInputPrompt: string
}

export function quickButtonToDraft(button: ChatQuickButton): QuickButtonDraft {
  const legacyHtml = button.kind === 'display' && !button.content && /<[^>]+>/.test(button.label)
  let title = button.label
  if (legacyHtml && typeof document !== 'undefined') {
    const template = document.createElement('template')
    template.innerHTML = button.label
    template.content.querySelectorAll('script, style, iframe, object, svg, math').forEach((node) => node.remove())
    title = template.content.textContent?.trim() || button.label
  }
  return {
    id: button.id, label: title, prompt: button.prompt || '', content: button.content || (legacyHtml ? button.label : ''),
    enabled: button.enabled !== false,
    kind: button.kind || 'prompt', immediateSend: button.immediate_send === true,
    actionId: button.action_id || '', scriptPath: button.script_path || '',
    cwdMode: button.cwd_mode || 'task', requireConfirmation: button.require_confirmation !== false,
    confirmationInputPrompt: button.confirmation_input_prompt || '',
  }
}

export function quickButtonFromDraft(button: QuickButtonDraft): ChatQuickButton {
  return {
    id: button.id, label: button.label.trim(), prompt: button.kind === 'prompt' ? button.prompt.trim() : '',
    enabled: button.enabled !== false,
    content: button.kind === 'display' ? button.content.trim() : '',
    kind: button.kind || 'prompt', immediate_send: button.kind === 'prompt' && button.immediateSend,
    ...(button.kind === 'action' ? {
      action_id: button.actionId.trim(), script_path: button.scriptPath,
      cwd_mode: button.cwdMode, require_confirmation: button.requireConfirmation,
      confirmation_input_prompt: button.confirmationInputPrompt.trim(),
    } : {}),
  }
}

interface Props {
  projectId: string
  workflowId?: string
  buttons: QuickButtonDraft[]
  onChange: (buttons: QuickButtonDraft[]) => void
  selectedId: string
  onSelect: (id: string) => void
  onSave: () => void
  saving?: boolean
  saveDisabled?: boolean
  saved?: boolean
  error?: string
  onEdited?: () => void
}

export default function QuickButtonEditor({ projectId, workflowId, buttons, onChange, selectedId, onSelect, onSave, saving, saveDisabled, saved, error, onEdited }: Props) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const [draggedId, setDraggedId] = useState('')
  const draggedIdRef = useRef('')
  const selectedIndex = buttons.findIndex((button) => button.id === selectedId)
  const selected = selectedIndex >= 0 ? buttons[selectedIndex] : null
  const change = (next: QuickButtonDraft[]) => { onChange(next); onEdited?.() }
  const update = (patch: Partial<QuickButtonDraft>) => {
    if (selectedIndex < 0) return
    change(buttons.map((button, index) => index === selectedIndex ? { ...button, ...patch } : button))
  }
  const reorder = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return
    const source = buttons.findIndex((button) => button.id === sourceId)
    const target = buttons.findIndex((button) => button.id === targetId)
    if (source < 0 || target < 0) return
    const next = [...buttons]
    const [moved] = next.splice(source, 1)
    next.splice(target, 0, moved)
    change(next)
  }

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
      {t('projectSettings.assistant.quickButtonsHint')} {t('projectSettings.assistant.quickButtonsDragHint')}
    </p>
    {error && <div role="status" style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>{error}</div>}
    <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', gap: 18, alignItems: 'stretch', minHeight: 300 }}>
      <div data-testid="quick-button-list" style={{ width: compact ? '100%' : 180, maxHeight: compact ? 180 : undefined, overflowY: compact ? 'auto' : undefined, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, paddingRight: compact ? 0 : 14, paddingBottom: compact ? 12 : 0, borderRight: compact ? 0 : '1px solid var(--border-soft)', borderBottom: compact ? '1px solid var(--border-soft)' : 0 }}>
        {buttons.map((button) => {
          const active = button.id === selectedId
          return <button key={button.id} type="button" draggable aria-current={active ? 'true' : undefined}
            onClick={() => onSelect(button.id)}
            onDragStart={(event) => { draggedIdRef.current = button.id; setDraggedId(button.id); event.dataTransfer?.setData('text/plain', button.id) }}
            onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move' }}
            onDrop={(event) => { event.preventDefault(); reorder(event.dataTransfer?.getData('text/plain') || draggedIdRef.current, button.id); draggedIdRef.current = ''; setDraggedId('') }}
            onDragEnd={() => { draggedIdRef.current = ''; setDraggedId('') }}
            style={{ width: '100%', minHeight: 38, padding: '7px 10px', borderRadius: 8, border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'color-mix(in oklab, var(--accent), transparent 92%)' : 'var(--surface)', color: active ? 'var(--accent)' : 'var(--fg-2)', textAlign: 'left', font: 'inherit', fontSize: 'calc(12px * var(--font-scale))', fontWeight: active ? 650 : 500, cursor: 'grab', opacity: draggedId === button.id ? 0.55 : 1 }}>
            <MarqueeText text={button.label.trim() || t('projectSettings.assistant.newButton')} title={button.label.trim() || t('projectSettings.assistant.newButton')} />
          </button>
        })}
        <Button variant="ghost" onClick={() => {
          const id = `qb-${randomUuid()}`
          change([...buttons, { id, label: '', prompt: '', content: '', kind: '', enabled: true, immediateSend: false, actionId: '', scriptPath: '', cwdMode: 'task', requireConfirmation: true, confirmationInputPrompt: '' }])
          onSelect(id)
        }} style={{ width: '100%', justifyContent: 'flex-start' }}>{t('projectSettings.assistant.addButton')}</Button>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {selected ? <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="quick-button-enabled-control">
            <input type="checkbox" role="switch" checked={selected.enabled !== false} onChange={(event) => update({ enabled: event.target.checked })} />
            {t('projectSettings.assistant.buttonEnabled')}
          </label>
          <Field label={t('projectSettings.assistant.buttonType')}>
            <Select data-testid="quick-button-type" value={selected.kind} onChange={(event) => update({ kind: event.target.value as QuickButtonDraft['kind'] })}>
              <option value="">{t('projectSettings.assistant.buttonTypePlaceholder')}</option>
              <option value="prompt">{t('projectSettings.assistant.buttonTypePrompt')}</option>
              <option value="display">{t('projectSettings.assistant.buttonTypeDisplay')}</option>
              <option value="action">{t('projectSettings.assistant.buttonTypeAction')}</option>
            </Select>
          </Field>
          {selected.kind && <>
            <Field label={t('projectSettings.assistant.buttonLabel')} required>
              <Input value={selected.label} onChange={(event) => update({ label: event.target.value })} placeholder={t('projectSettings.assistant.buttonLabel')} />
            </Field>
            {selected.kind === 'prompt' && <>
              <Field label={t('projectSettings.assistant.buttonPrompt')}>
                <MarkdownEditor data-testid="quick-button-prompt" value={selected.prompt} onChange={(value) => update({ prompt: value })} projectId={projectId} imagePrefix="quick-button" placeholder={t('projectSettings.assistant.buttonPrompt')} minHeight={140} maxHeight={280} />
              </Field>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-2)', fontSize: 'calc(12px * var(--font-scale))' }}>
                <input type="checkbox" checked={selected.immediateSend} onChange={(event) => update({ immediateSend: event.target.checked })} />
                {t('projectSettings.assistant.buttonImmediateSend')}
              </label>
            </>}
            {selected.kind === 'display' && <>
              <Field label={t('projectSettings.assistant.buttonContent')}>
                <Textarea data-testid="quick-button-display-content" value={selected.content} onChange={(event) => update({ content: event.target.value })} placeholder={'<a href="https://example.com">打开链接</a>'} style={{ minHeight: 100 }} />
              </Field>
              <div style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>{t('projectSettings.assistant.buttonDisplayHint')}</div>
              {selected.content.trim() && <QuickPromptButton label={selected.label} prompt="" displayOnly displayContent={selected.content} onSelect={() => {}} />}
            </>}
            {selected.kind === 'action' && <ActionButtonFields projectId={projectId} workflowId={workflowId}
              value={{ actionId: selected.actionId, scriptPath: selected.scriptPath, cwdMode: selected.cwdMode, requireConfirmation: selected.requireConfirmation, confirmationInputPrompt: selected.confirmationInputPrompt }}
              onChange={(next) => update(next)} />}
          </>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button variant="primary" loading={saving} disabled={saveDisabled} onClick={onSave}>{t('common.save')}</Button>
            <Button variant="ghost" onClick={() => {
              const remaining = buttons.filter((button) => button.id !== selected.id)
              change(remaining)
              onSelect((remaining[selectedIndex] || remaining[selectedIndex - 1])?.id || '')
            }} style={{ color: 'var(--danger)' }}>{t('common.delete')}</Button>
            {saved && <span role="status" style={{ color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))' }}>{t('projectSettings.assistant.buttonsSaved')}</span>}
          </div>
        </div> : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>{t('projectSettings.assistant.noQuickButtons')}</div>
          <Button variant="primary" loading={saving} disabled={saveDisabled} onClick={onSave} style={{ alignSelf: 'flex-start' }}>{t('common.save')}</Button>
        </div>}
      </div>
    </div>
  </div>
}
