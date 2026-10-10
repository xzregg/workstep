import { useI18n } from '../i18n'
import Icon from './Icon'

export default function WorkflowHookTypeTabs({ kind, onSwitch, disabled }: {kind:'trigger'|'notification';onSwitch?:()=>void;disabled?:boolean}) {
  const { t } = useI18n()
  return <nav className="workflow-hooks-tabs workflow-hooks-types" aria-label={t('notificationHooks.typeLabel')}>
    <button aria-pressed={kind==='trigger'} disabled={disabled} onClick={kind==='notification'?onSwitch:undefined}><Icon name="webhook" size={16}/>{t('notificationHooks.trigger')}</button>
    <button aria-pressed={kind==='notification'} disabled={disabled} onClick={kind==='trigger'?onSwitch:undefined}><Icon name="bell" size={16}/>{t('notificationHooks.notification')}</button>
  </nav>
}
