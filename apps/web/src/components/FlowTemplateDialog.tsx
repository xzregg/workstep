import { useEffect, useState } from 'react'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Input from './Input'
import ResizablePanel from './ResizablePanel'
import { fetchTemplates, invalidateTemplates, templateApi, type TemplateInfo } from '../api/client'
import { useI18n } from '../i18n'
import './FlowTemplateDialog.css'

interface Props {
  open: boolean
  onClose: () => void
  getSteps: () => unknown
  onApply: (steps: unknown) => void
  onFeedback: (message: string, kind: 'success' | 'error') => void
}

export default function FlowTemplateDialog({ open, onClose, getSteps, onApply, onFeedback }: Props) {
  const { t } = useI18n()
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [pending, setPending] = useState<TemplateInfo | null>(null)
  const [search, setSearch] = useState('')
  const [showSave, setShowSave] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    let mounted = true
    fetchTemplates().then(({ templates: list }) => {
      if (mounted) setTemplates(list)
    }).catch(() => {
      if (mounted) setTemplates([])
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (open) setSearch('')
  }, [open])

  const saveTemplate = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      onFeedback(t('flow.saveTemplateNameRequired'), 'error')
      return
    }
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    try {
      await templateApi.save({
        id: slug || `custom-${Date.now()}`,
        name: trimmed,
        description: description.trim(),
        steps: getSteps(),
      })
      invalidateTemplates()
      const { templates: list } = await fetchTemplates(true)
      setTemplates(list)
      setShowSave(false)
      setName('')
      setDescription('')
      onClose()
      onFeedback(t('flow.templateSaved', { name: trimmed }), 'success')
    } catch (error) {
      onFeedback(t('flow.saveFailed', { error: error instanceof Error ? error.message : t('flow.networkError') }), 'error')
    }
  }

  const applyTemplate = async (template: TemplateInfo) => {
    setPending(null)
    try {
      const full = await templateApi.get(template.id)
      onApply(full.steps ?? full)
    } catch (error) {
      onFeedback(t('flow.templateLoadFailed', { error: error instanceof Error ? error.message : t('flow.networkError') }), 'error')
    }
  }

  const query = search.trim().toLowerCase()
  const filtered = templates.filter((template) => !query
    || template.name.toLowerCase().includes(query)
    || (template.description || '').toLowerCase().includes(query)
    || template.id.toLowerCase().includes(query))

  return (
    <>
      {open && (
        <div className="modal-overlay flow-template-overlay" onClick={onClose}>
          <ResizablePanel className="modal flow-template-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('flow.templates')}</span>
              <Button variant="icon" aria-label={t('common.cancel')} onClick={onClose}>✕</Button>
            </div>
            <div className="modal-body flow-template-body">
              <Input className="flow-template-search" value={search} onChange={(event) => setSearch(event.target.value)}
                placeholder={t('flow.searchTemplates')} spellCheck={false} />
              {showSave && (
                <div className="flow-template-save-form">
                  <div className="flow-template-save-title">{t('flow.saveCanvasAsTemplate')}</div>
                  <Input value={name} onChange={(event) => setName(event.target.value)}
                    placeholder={t('flow.templateNameRequired')} spellCheck={false} />
                  <Input className="flow-template-description" value={description} onChange={(event) => setDescription(event.target.value)}
                    placeholder={t('flow.templateDescOptional')} spellCheck={false} />
                  <div className="flow-template-save-actions">
                    <Button variant="primary" onClick={() => void saveTemplate()} disabled={!name.trim()}>{t('flow.saveTemplate')}</Button>
                    <Button variant="ghost" onClick={() => setShowSave(false)}>{t('common.cancel')}</Button>
                  </div>
                </div>
              )}
              {templates.length === 0 ? (
                <div className="flow-template-empty">{t('flow.noTemplates')}</div>
              ) : filtered.length === 0 ? (
                <div className="flow-template-empty">{t('flow.noMatchingTemplates')}</div>
              ) : filtered.map((template) => (
                <button key={template.id} type="button" className="flow-template-choice"
                  onClick={() => { onClose(); setPending(template) }}>
                  <span className="flow-template-choice-text">
                    <span className="flow-template-choice-name">{template.name}</span>
                    {template.description && <span className="flow-template-choice-description">{template.description}</span>}
                  </span>
                  <span className="flow-template-choice-count">{t('flow.nodeCount', { count: template.nodeCount })}</span>
                </button>
              ))}
            </div>
            <div className="modal-footer">
              <Button variant="primary" onClick={() => setShowSave(true)}>{t('flow.saveAsTemplate')}</Button>
              <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            </div>
          </ResizablePanel>
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={t('flow.applyTemplateTitle')}
        message={pending ? t('flow.applyTemplateMessage', { name: pending.name }) : undefined}
        confirmText={t('flow.applyTemplate')}
        danger
        onConfirm={() => { if (pending) void applyTemplate(pending) }}
        onCancel={() => setPending(null)}
      />
    </>
  )
}
