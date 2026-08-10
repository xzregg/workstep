import { useEffect, useState } from 'react'
import {
  engineApi,
  type EngineConfigField,
  type EngineConfigPayload,
  type EngineConfigSchema,
} from '../api/client'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Input from './Input'
import Select from './Select'
import Textarea from './Textarea'
import { useI18n } from '../i18n'

interface Props {
  engineId: string
  /** Config template + masked values, embedded in /api/engine/list. */
  config: EngineConfigPayload | null
  onSaved?: (result: EngineConfigSchema) => void
}

/**
 * Schema-driven engine configuration form.
 *
 * The backend embeds each engine's config template (fields + masked values)
 * in /api/engine/list, so this component renders controls directly from the
 * ``config`` prop without extra requests. Saving goes through
 * PUT /api/engine/{id}/config and the returned engine entry refreshes the
 * embedded payload.
 */
export default function EngineConfigForm({ engineId, config, onSaved }: Props) {
  const { t } = useI18n()
  const fields = config?.fields ?? []
  const [values, setValues] = useState<Record<string, string>>({})
  const [secrets, setSecrets] = useState<Record<string, boolean>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [clearKeys, setClearKeys] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [revealing, setRevealing] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'error' | 'success' | ''>('')
  const [confirmField, setConfirmField] = useState<EngineConfigField | null>(null)

  // Sync form state whenever the embedded payload changes (mount or after save).
  useEffect(() => {
    setValues(config?.values ?? {})
    setSecrets(config?.secrets ?? {})
    setRevealed({})
    setClearKeys({})
  }, [config])

  if (!config || fields.length === 0) return null

  const needsConfirmation = (): EngineConfigField | null => {
    for (const field of fields) {
      const value = values[field.key] ?? ''
      if (field.confirm_values.includes(value)) return field
    }
    return null
  }

  const doSave = async (confirmed: EngineConfigField | null) => {
    setSaving(true)
    setMessage('')
    setMessageKind('')
    try {
      const result = await engineApi.saveConfig(engineId, {
        values,
        clear: clearKeys,
        confirmed: confirmed ? { [confirmed.key]: true } : {},
      })
      if (!result.saved || !result.engine) {
        setMessage(result.message || t('engineForm.saveFailed'))
        setMessageKind('error')
        return
      }
      setValues(result.values)
      setSecrets(result.secrets)
      setRevealed({})
      setClearKeys({})
      setMessage(t('engineForm.saved'))
      setMessageKind('success')
      onSaved?.(result)
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : t('engineForm.saveFailed'))
      setMessageKind('error')
    } finally {
      setSaving(false)
      setConfirmField(null)
    }
  }

  const save = () => {
    const field = needsConfirmation()
    if (field) {
      setConfirmField(field)
      return
    }
    void doSave(null)
  }

  const toggleReveal = async (field: EngineConfigField) => {
    if (revealed[field.key]) {
      setRevealed((current) => {
        const next = { ...current }
        delete next[field.key]
        return next
      })
      return
    }
    const typed = (values[field.key] || '').trim()
    if (typed || !secrets[field.key]) {
      setRevealed((current) => ({ ...current, [field.key]: true }))
      return
    }
    setRevealing(field.key)
    try {
      const result = await engineApi.revealConfig(engineId, field.key)
      setValues((current) => ({ ...current, [field.key]: result.value || '' }))
      setRevealed((current) => ({ ...current, [field.key]: true }))
    } catch (revealError) {
      setMessage(revealError instanceof Error ? revealError.message : t('engineForm.revealFailed'))
      setMessageKind('error')
    } finally {
      setRevealing(null)
    }
  }

  const setFieldValue = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }))
    if (clearKeys[key]) {
      setClearKeys((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
    }
  }

  const hasRequiredGaps = fields.some((field) => (
    field.required && !((values[field.key] ?? '').trim())
  ))

  const renderField = (field: EngineConfigField) => {
    const value = values[field.key] ?? ''
    const isSelect = field.type === 'select'
    const isPassword = field.type === 'password'
    const isCheckbox = field.type === 'checkbox'
    const isTextarea = field.type === 'textarea'

    return (
      <div key={field.key} style={{ minWidth: 0 }}>
        <label
          htmlFor={`engine-config-${engineId}-${field.key}`}
          style={{ display: 'block', marginBottom: 4, fontSize: 11, fontWeight: 600 }}
        >
          {field.label}
          {field.required && <span style={{ color: 'var(--danger)', marginLeft: 2 }}>*</span>}
        </label>
        {isSelect ? (
          <Select
            id={`engine-config-${engineId}-${field.key}`}
            value={value}
            disabled={saving}
            onChange={(event) => setFieldValue(field.key, event.target.value)}
          >
            <option value="">
              {field.placeholder || (field.required ? t('engineForm.selectPlaceholder') : '')}
            </option>
            {(field.options || []).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        ) : isPassword ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Input
              id={`engine-config-${engineId}-${field.key}`}
              type={revealed[field.key] ? 'text' : 'password'}
              autoComplete="off"
              value={value}
              disabled={saving || revealing === field.key}
              onChange={(event) => setFieldValue(field.key, event.target.value)}
              placeholder={
                field.placeholder
                || (secrets[field.key] ? t('engineForm.savedHint') : '')
              }
              style={{ flex: 1, minWidth: 0 }}
            />
            <Button
              variant="ghost"
              disabled={saving || revealing === field.key}
              loading={revealing === field.key}
              onClick={() => void toggleReveal(field)}
              style={{ minWidth: 54, height: 30, justifyContent: 'center' }}
            >
              {revealed[field.key] ? t('engineForm.hide') : t('engineForm.show')}
            </Button>
            {field.sensitive && secrets[field.key] && (
              <label
                title={t('engineForm.clearSavedWithLabel', { label: field.label })}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  flexShrink: 0, cursor: 'pointer', fontSize: 11,
                  color: 'var(--muted)', whiteSpace: 'nowrap',
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(clearKeys[field.key])}
                  disabled={saving}
                  onChange={(event) => {
                    setClearKeys((current) => ({
                      ...current,
                      [field.key]: event.target.checked,
                    }))
                    if (event.target.checked) setFieldValue(field.key, '')
                  }}
                  style={{
                    width: 14, height: 14, padding: 0, margin: 0,
                    flexShrink: 0, accentColor: 'var(--accent)',
                  }}
                />
                {t('engineForm.clearSaved')}
              </label>
            )}
          </div>
        ) : isCheckbox ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
            <input
              id={`engine-config-${engineId}-${field.key}`}
              type="checkbox"
              checked={value === 'true'}
              disabled={saving}
              onChange={(event) => setFieldValue(
                field.key,
                event.target.checked ? 'true' : 'false',
              )}
              style={{
                width: 16, height: 16, padding: 0, margin: 0,
                accentColor: 'var(--accent)',
              }}
            />
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {field.placeholder || field.label}
            </span>
          </div>
        ) : isTextarea ? (
          <Textarea
            id={`engine-config-${engineId}-${field.key}`}
            value={value}
            disabled={saving}
            onChange={(event) => setFieldValue(field.key, event.target.value)}
            placeholder={field.placeholder}
            rows={3}
            style={{ resize: 'vertical' }}
          />
        ) : (
          <Input
            id={`engine-config-${engineId}-${field.key}`}
            type={field.type === 'number' ? 'number' : 'text'}
            value={value}
            disabled={saving}
            onChange={(event) => setFieldValue(field.key, event.target.value)}
            placeholder={field.placeholder}
          />
        )}
        {field.sensitive && secrets[field.key] && !isPassword && (
          <label
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              marginTop: 4, cursor: 'pointer', fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(clearKeys[field.key])}
              disabled={saving}
              onChange={(event) => {
                setClearKeys((current) => ({
                  ...current,
                  [field.key]: event.target.checked,
                }))
                if (event.target.checked) setFieldValue(field.key, '')
              }}
              style={{
                width: 14, height: 14, padding: 0, margin: 0,
                flexShrink: 0, accentColor: 'var(--accent)',
              }}
            />
            {t('engineForm.clearSavedWithLabel', { label: field.label })}
          </label>
        )}
        {field.help && (
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--meta)' }}>
            {field.help}
          </div>
        )}
        {field.required && !value.trim() && (
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>
            {t('engineForm.requiredField')}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{
      padding: '10px 14px 12px',
      borderTop: '1px solid var(--border-soft)',
      background: 'var(--surface)',
    }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
      }}>
        {fields.map((field) => renderField(field))}
      </div>
      <div style={{
        marginTop: 8, display: 'flex', alignItems: 'center', gap: 10,
        color: 'var(--muted)', fontSize: 11,
      }}>
        <div
          role="status"
          style={{
            flex: 1, minHeight: 18,
            color: messageKind === 'error'
              ? 'var(--danger)'
              : messageKind === 'success'
                ? 'var(--success)'
                : 'var(--muted)',
          }}
        >
          {message || t('engineForm.keyHint')}
        </div>
        <Button
          variant="primary"
          disabled={saving || hasRequiredGaps}
          loading={saving}
          onClick={() => save()}
          style={{ minWidth: 84, height: 30, justifyContent: 'center' }}
        >
          {t('engineForm.saveConfig')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmField !== null}
        title={t('engineForm.confirmTitle', { label: confirmField?.label ?? '' })}
        message={t('engineForm.confirmMessage', { label: confirmField?.label ?? '' })}
        confirmText={t('engineForm.confirmSave')}
        danger
        onConfirm={() => void doSave(confirmField)}
        onCancel={() => setConfirmField(null)}
      />
    </div>
  )
}
