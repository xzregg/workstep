import Button from './Button'
import Spinner from './Spinner'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'

/** Shared loading/retry state before workflow-dependent controls are mounted. */
export default function WorkflowDetailLoadStatus() {
  const { t } = useI18n()
  const error = useProjectStore(s => s.workflowLoadError)
  const workflowId = useProjectStore(s => s.activeWorkflowId)
  return <div role={error ? 'alert' : 'status'}>
    {error || <><Spinner />{t('common.loading')}</>}
    {error && <Button onClick={() => void useProjectStore.getState().setActiveWorkflow(workflowId)}>{t('common.retry')}</Button>}
  </div>
}
