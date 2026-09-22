import { useI18n } from '../i18n'

export default function StepPromptVariablesHint() {
  const { t } = useI18n()

  return (
    <div
      style={{
        marginTop: 6,
        color: 'var(--fg-3)',
        fontSize: 'calc(11px * var(--font-scale))',
        lineHeight: 1.5,
      }}
    >
      {t('flow.promptVariablesHint')}
    </div>
  )
}
