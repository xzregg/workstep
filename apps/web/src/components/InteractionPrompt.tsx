import { useMemo, useState } from 'react'
import Button from './Button'
import Textarea from './Textarea'
import { useI18n } from '../i18n'
import {
  buildInteractionResponse,
  cancelInteractionResponse,
  interactionForm,
  interactionValuesValid,
  type InteractionFieldOption,
  type InteractionRequestData,
  type InteractionValues,
} from '../utils/interaction'

interface Props {
  request: InteractionRequestData
  response?: Record<string, unknown>
  onRespond: (
    interactionId: string,
    response: Record<string, unknown>,
  ) => Promise<void>
}

function InteractionOptionButton({
  option,
  active = false,
  disabled = false,
  onClick,
}: {
  option: InteractionFieldOption
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={option.description || option.label}
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'color-mix(in oklab, var(--accent), transparent 88%)' : 'var(--bg)',
        color: active ? 'var(--accent)' : 'var(--fg-2)',
        borderRadius: 7, padding: '6px 9px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontSize: 12, textAlign: 'left',
      }}
    >
      {option.label}
    </button>
  )
}

export default function InteractionPrompt({ request, response, onRespond }: Props) {
  const { t } = useI18n()
  const form = useMemo(() => interactionForm(request), [request])
  const [values, setValues] = useState<InteractionValues>({})
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [submittedResponse, setSubmittedResponse] = useState<Record<string, unknown>>()
  const effectiveResponse = response || submittedResponse

  // Once answered (locally after submit, or from a persisted event after a
  // reload), the permission/question card disappears instead of lingering.
  if (effectiveResponse) return null

  const responseValues = (): InteractionValues => {
    const next = { ...values }
    for (const field of form.fields) {
      const custom = (customInputs[field.id] || '').trim()
      if (!custom) continue
      if (field.type === 'multiple') {
        const selected = Array.isArray(next[field.id])
          ? next[field.id] as string[]
          : []
        next[field.id] = [...selected, custom]
      } else {
        next[field.id] = custom
      }
    }
    return next
  }

  const submit = async () => {
    const next = responseValues()
    if (!interactionValuesValid(form, next)) return
    await respond(buildInteractionResponse(request, next))
  }

  const respond = async (nextResponse: Record<string, unknown>) => {
    setSubmitting(true)
    setError('')
    try {
      await onRespond(request.interaction_id, nextResponse)
      setSubmittedResponse(nextResponse)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('interaction.submitFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const permissionOptions = form.fields[0]?.options || []

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 10,
      padding: 12, background: 'var(--surface)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
          color: 'var(--accent)', textTransform: 'uppercase',
        }}>
          {request.method === 'session/request_permission'
            ? t('interaction.permission')
            : t('interaction.question')}
        </span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--fg)' }}>
        {form.title}
      </div>
      {request.tool_call?.raw_input !== undefined && (
        <pre style={{
          margin: 0, padding: 8, borderRadius: 6, overflowX: 'auto',
          background: 'var(--bg)', color: 'var(--muted)', fontSize: 11,
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        }}>
          {typeof request.tool_call.raw_input === 'string'
            ? request.tool_call.raw_input
            : JSON.stringify(request.tool_call.raw_input, null, 2)}
        </pre>
      )}
      {request.method === 'session/request_permission' ? (
        <>
          {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
          {permissionOptions.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 }}>
              {permissionOptions.map((option) => (
                <InteractionOptionButton
                  key={option.value}
                  option={option}
                  disabled={submitting}
                  onClick={() => void respond(
                    buildInteractionResponse(request, { permission: option.value }),
                  )}
                />
              ))}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => void respond(cancelInteractionResponse(request))}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </>
      ) : (
        <>
          {form.fields.map((field) => {
            const selected = values[field.id]
            return (
              <div key={field.id} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)' }}>
                    {field.title}
                  </span>
                  {!field.required && (
                    <span style={{ marginLeft: 5, color: 'var(--meta)', fontSize: 11 }}>
                      {t('common.optional')}
                    </span>
                  )}
                  {field.description && (
                    <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>
                      {field.description}
                    </div>
                  )}
                </div>
                {field.options.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {field.options.map((option) => {
                      const active = field.type === 'multiple'
                        ? Array.isArray(selected) && selected.includes(option.value)
                        : selected === option.value
                      return (
                        <InteractionOptionButton
                          key={option.value}
                          option={option}
                          active={active}
                          onClick={() => setValues((current) => {
                            if (field.type !== 'multiple') {
                              return { ...current, [field.id]: option.value }
                            }
                            const valuesForField = Array.isArray(current[field.id])
                              ? current[field.id] as string[]
                              : []
                            return {
                              ...current,
                              [field.id]: valuesForField.includes(option.value)
                                ? valuesForField.filter((value) => value !== option.value)
                                : [...valuesForField, option.value],
                            }
                          })}
                        />
                      )
                    })}
                  </div>
                )}
                {field.type === 'boolean' && (
                  <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(selected)}
                      onChange={(event) => setValues((current) => ({
                        ...current, [field.id]: event.target.checked,
                      }))}
                    />
                    {t('interaction.enabled')}
                  </label>
                )}
                {(field.allowInput || field.type === 'text' || field.type === 'number') && (
                  <Textarea
                    rows={2}
                    value={customInputs[field.id] || ''}
                    onChange={(event) => setCustomInputs((current) => ({
                      ...current, [field.id]: event.target.value,
                    }))}
                    placeholder={field.options.length
                      ? t('interaction.customPlaceholder')
                      : t('interaction.inputPlaceholder')}
                  />
                )}
              </div>
            )
          })}
          {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => void respond(cancelInteractionResponse(request))}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={!interactionValuesValid(form, responseValues())}
              onClick={() => void submit()}
            >
              {t('interaction.submit')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
