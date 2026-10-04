import { useI18n } from '../i18n'
import ActionConfirmDialog from './ActionConfirmDialog'
import { useProjectActions } from './useActionRuns'

export function ProjectActionMessages({ state }: { state: ReturnType<typeof useProjectActions> }) {
  const { t } = useI18n()
  return <>
    {state.error && <div role="alert" style={{ color: 'var(--danger)' }}>{state.error}</div>}
    <ActionConfirmDialog
      button={state.pending} directory={t('actionShortcuts.projectDirectory')} loading={state.busy}
      onCancel={() => state.setPending(null)}
      onConfirm={(input) => { if (state.pending) void state.run(state.pending, true, input) }}
    />
  </>
}
