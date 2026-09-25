import { useEffect, useState } from 'react'
import type { ChatQuickButton } from '../api/client'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'
import Field from './Field'
import Input from './Input'

export default function ActionConfirmDialog({ button, directory, loading, onCancel, onConfirm }: {
  button: ChatQuickButton | null
  directory: string
  loading: boolean
  onCancel: () => void
  onConfirm: (input: string) => void
}) {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const inputPrompt = button?.confirmation_input_prompt?.trim() || ''

  useEffect(() => { setInput('') }, [button?.id])

  return <ConfirmDialog
    open={Boolean(button)}
    title={t('actionShortcuts.confirmTitle', { title: button?.label || '' })}
    message={button ? t('actionShortcuts.confirmMessage', { script: button.script_path || '', directory }) : ''}
    confirmText={t('actionShortcuts.confirm')}
    loading={loading}
    confirmDisabled={Boolean(inputPrompt && !input.trim())}
    onCancel={onCancel}
    onConfirm={() => onConfirm(input)}
  >
    {inputPrompt && <div style={{ paddingTop: 14 }}>
      <Field label={inputPrompt} required>
        <Input
          data-testid="action-confirmation-input"
          autoFocus
          maxLength={4000}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && input.trim() && !loading) onConfirm(input)
          }}
          placeholder={inputPrompt}
        />
      </Field>
      <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))' }}>
        {t('actionShortcuts.confirmationInputRuntimeHint')}
      </div>
    </div>}
  </ConfirmDialog>
}
