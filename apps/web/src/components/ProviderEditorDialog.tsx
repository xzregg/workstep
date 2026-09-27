import { useEffect, useRef, useState } from 'react'
import { providerApi, type ProviderInfo, type ProviderTypeMeta } from '../api/client'
import { useI18n, type TKey } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Field from './Field'
import Input from './Input'
import ResizablePanel from './ResizablePanel'
import Select from './Select'
import './ProviderEditorDialog.css'

export type ProviderEditorTarget =
  | { mode: 'create' }
  | { mode: 'edit' | 'copy'; provider: ProviderInfo }

interface Props {
  target: ProviderEditorTarget
  types: ProviderTypeMeta[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}

interface ProviderForm {
  name: string
  type: string
  protocols: string[]
  protocol_base_urls: Record<string, string>
  api_key: string
  clear_key: boolean
}

const PROTOCOLS: { value: string; labelKey: TKey }[] = [
  { value: 'anthropic_messages', labelKey: 'providerSettings.protocolAnthropic' },
  { value: 'openai_responses', labelKey: 'providerSettings.protocolResponses' },
  { value: 'openai_chat_completions', labelKey: 'providerSettings.protocolChat' },
]

function defaultProtocols(types: ProviderTypeMeta[], id: string) {
  const type = types.find((item) => item.id === id)
  return type?.default_protocols?.length
    ? type.default_protocols
    : [type?.default_protocol ?? 'openai_chat_completions']
}

function defaultBaseUrl(types: ProviderTypeMeta[], id: string) {
  return types.find((item) => item.id === id)?.default_base_url ?? ''
}

function initialForm(target: ProviderEditorTarget, types: ProviderTypeMeta[]): ProviderForm {
  if (target.mode === 'create') {
    const type = types[0]?.id ?? 'custom'
    const protocols = defaultProtocols(types, type)
    return {
      name: '', type, protocols,
      protocol_base_urls: Object.fromEntries(protocols.map((protocol) => [protocol, defaultBaseUrl(types, type)])),
      api_key: '', clear_key: false,
    }
  }
  const { provider } = target
  const protocols = provider.protocols?.length ? provider.protocols : [provider.protocol]
  return {
    name: provider.name,
    type: provider.type,
    protocols,
    protocol_base_urls: Object.fromEntries(protocols.map((protocol) => [
      protocol, provider.protocol_base_urls?.[protocol] || provider.base_url,
    ])),
    api_key: '',
    clear_key: false,
  }
}

export default function ProviderEditorDialog({ target, types, onClose, onSaved }: Props) {
  const { t } = useI18n()
  const [form, setForm] = useState(() => initialForm(target, types))
  const [baseline, setBaseline] = useState(() => initialForm(target, types))
  const [confirmClose, setConfirmClose] = useState(false)
  const [formError, setFormError] = useState('')
  const [formSaving, setFormSaving] = useState(false)
  const [keyRevealed, setKeyRevealed] = useState(false)
  const [copyLoading, setCopyLoading] = useState(target.mode === 'copy')
  const [copyError, setCopyError] = useState('')
  const [copyReady, setCopyReady] = useState(target.mode !== 'copy')
  const copyRequest = useRef<Promise<string> | null>(null)

  useEffect(() => {
    if (target.mode !== 'copy') return
    let mounted = true
    if (!copyRequest.current) {
      copyRequest.current = target.provider.has_key
        ? providerApi.reveal(target.provider.id).then((result) => result.value || '')
        : Promise.resolve('')
    }
    const prepareCopy = async () => {
      try {
        const apiKey = (await copyRequest.current) || ''
        if (!mounted) return
        const next = {
          ...initialForm(target, types),
          name: t('providerSettings.copyName', { name: target.provider.name }),
          api_key: apiKey,
        }
        setForm(next)
        setBaseline(next)
        setCopyReady(true)
      } catch (reason) {
        if (mounted) setCopyError(reason instanceof Error ? reason.message : t('providerSettings.copyFailed'))
      } finally {
        if (mounted) setCopyLoading(false)
      }
    }
    void prepareCopy()
    return () => { mounted = false }
  }, [target, t, types])

  // Copying requires fetching the existing secret before the draft can be saved.
  const editingId = target.mode === 'edit' ? target.provider.id : null
  const existingKey = target.mode !== 'create' && target.provider.has_key
  const title = target.mode === 'edit'
    ? t('providerSettings.editTitle')
    : target.mode === 'copy'
      ? t('providerSettings.copyTitle')
      : t('providerSettings.newTitle')

  const toggleProtocol = (value: string) => {
    setForm((current) => {
      const present = current.protocols.includes(value)
      return {
        ...current,
        protocols: present ? current.protocols.filter((item) => item !== value) : [...current.protocols, value],
        protocol_base_urls: present ? current.protocol_base_urls : {
          ...current.protocol_base_urls,
          [value]: current.protocol_base_urls[value] || defaultBaseUrl(types, current.type),
        },
      }
    })
  }

  const changeType = (type: string) => {
    const protocols = defaultProtocols(types, type)
    setForm((current) => ({
      ...current, type, protocols,
      protocol_base_urls: Object.fromEntries(protocols.map((protocol) => [protocol, defaultBaseUrl(types, type)])),
    }))
    setFormError('')
  }

  const toggleReveal = async () => {
    if (keyRevealed) {
      setKeyRevealed(false)
      return
    }
    if (!editingId || !existingKey) {
      setKeyRevealed(true)
      return
    }
    try {
      const result = await providerApi.reveal(editingId)
      setForm((current) => ({ ...current, api_key: result.value || '' }))
      setKeyRevealed(true)
    } catch {
      setFormError(t('providerSettings.saveFailed'))
    }
  }

  const save = async () => {
    const name = form.name.trim()
    if (!name) {
      setFormError(t('providerSettings.needsName'))
      return
    }
    if (!form.protocols.length) {
      setFormError(t('providerSettings.protocolsRequired'))
      return
    }
    const protocolBaseUrls = Object.fromEntries(form.protocols.map((protocol) => [
      protocol, (form.protocol_base_urls[protocol] || '').trim(),
    ]))
    if (Object.values(protocolBaseUrls).some((value) => !value)) {
      setFormError(t('providerSettings.needsBaseUrl'))
      return
    }
    setFormSaving(true)
    setFormError('')
    try {
      const result = await providerApi.save({
        id: editingId || undefined,
        name,
        type: form.type,
        protocols: form.protocols,
        protocol: form.protocols[0],
        base_url: protocolBaseUrls[form.protocols[0]],
        protocol_base_urls: protocolBaseUrls,
        api_key: form.api_key,
        clear: form.clear_key ? { api_key: true } : undefined,
      })
      if (!result.saved || !result.provider) {
        setFormError(result.message || t('providerSettings.saveFailed'))
        return
      }
      await onSaved()
      onClose()
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : t('providerSettings.saveFailed'))
    } finally {
      setFormSaving(false)
    }
  }

  const saveDisabled = !form.name.trim()
    || !form.protocols.length
    || form.protocols.some((protocol) => !form.protocol_base_urls[protocol]?.trim())
    || formSaving
    || !copyReady
  const requestClose = () => {
    if (JSON.stringify(form) !== JSON.stringify(baseline)) setConfirmClose(true)
    else onClose()
  }

  return (
    <div className="modal-overlay provider-editor-overlay" role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
      <ResizablePanel className="modal provider-editor-panel" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header provider-editor-header">
          <span className="modal-title">{title}</span>
          <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={requestClose}>✕</Button>
        </div>
        <div className="modal-body provider-editor-body">
          <Field label={t('providerSettings.name')} htmlFor="provider-name" required>
            <Input id="provider-name" className="provider-editor-control" value={form.name}
              placeholder={t('providerSettings.namePlaceholder')} autoFocus
              onChange={(event) => { setForm((current) => ({ ...current, name: event.target.value })); setFormError('') }} />
          </Field>
          <Field label={t('providerSettings.type')} htmlFor="provider-type" required>
            <Select id="provider-type" className="provider-editor-control" value={form.type}
              onChange={(event) => changeType(event.target.value)}>
              {types.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
            </Select>
          </Field>
          <Field label={t('providerSettings.protocols')} required>
            <div className="provider-protocol-options">
              {PROTOCOLS.map((option) => {
                const enabled = form.protocols.includes(option.value)
                return (
                  <div className="provider-protocol-setting" key={option.value}>
                    <label className="provider-protocol-toggle">
                      <span>{t(option.labelKey)}</span>
                      <input type="checkbox" role="switch" checked={enabled} onChange={() => toggleProtocol(option.value)} />
                      <span className="provider-protocol-switch" aria-hidden="true" />
                    </label>
                    {enabled && <Field className="provider-protocol-address" label={t('providerSettings.baseUrl')}
                      htmlFor={`provider-base-url-${option.value}`} required>
                      <Input id={`provider-base-url-${option.value}`} className="provider-editor-control"
                        value={form.protocol_base_urls[option.value] || ''}
                        placeholder={t('providerSettings.baseUrlPlaceholder')}
                        onChange={(event) => {
                          const value = event.target.value
                          setForm((current) => ({ ...current, protocol_base_urls: { ...current.protocol_base_urls, [option.value]: value } }))
                          setFormError('')
                        }} />
                    </Field>}
                  </div>
                )
              })}
            </div>
            <div className="provider-editor-hint">{t('providerSettings.protocolsHint')}</div>
          </Field>
          <Field label={t('providerSettings.apiKey')} htmlFor="provider-api-key"
            help={editingId && !form.clear_key && existingKey ? t('providerSettings.apiKeyKept') : undefined}>
            <div className="provider-editor-key-row">
              <Input id="provider-api-key" className="provider-editor-key-input" type={keyRevealed ? 'text' : 'password'}
                value={form.api_key} placeholder={t('providerSettings.apiKeyPlaceholder')}
                onChange={(event) => { setForm((current) => ({ ...current, api_key: event.target.value })); setFormError('') }} />
              <Button variant="ghost" className="provider-editor-reveal" onClick={() => void toggleReveal()}>
                {keyRevealed ? t('providerSettings.hide') : t('providerSettings.reveal')}
              </Button>
              {editingId && existingKey && <label className="provider-editor-clear-key" title={t('providerSettings.clearKey')}>
                <input id="provider-clear-key" type="checkbox" checked={form.clear_key}
                  onChange={(event) => { setForm((current) => ({ ...current, clear_key: event.target.checked })); setFormError('') }} />
                {t('providerSettings.clearKey')}
              </label>}
            </div>
          </Field>
          <div className="field-hint provider-editor-feedback" aria-live="polite">
            {copyLoading && <span>{t('settings.readingEngines')}</span>}
            {copyError && <span className="provider-editor-error">{copyError}</span>}
            {formError && <span className="provider-editor-error">{formError}</span>}
          </div>
          <div className="provider-editor-actions">
            <Button variant="ghost" disabled={formSaving} onClick={requestClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={saveDisabled} loading={formSaving} onClick={() => void save()}>
              {t('providerSettings.save')}
            </Button>
          </div>
        </div>
      </ResizablePanel>
      <ConfirmDialog open={confirmClose} title={t('providerSettings.unsavedTitle')}
        message={t('providerSettings.unsavedMessage')} confirmText={t('layout.discardChanges')}
        cancelText={t('common.cancel')} danger
        onConfirm={() => { setConfirmClose(false); onClose() }}
        onCancel={() => setConfirmClose(false)} />
    </div>
  )
}
