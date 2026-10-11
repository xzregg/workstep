import { useState } from 'react'
import { useI18n, type TKey } from '../i18n'
import { maxNotificationTemplateLength, notificationTemplateIssue } from '../utils/notificationTemplate'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import MarkdownEditor from './MarkdownEditor'
import './NotificationTemplateEditor.css'

interface Props {
  value: string | null | undefined
  defaultTemplate: string
  variables: string[]
  disabled: boolean
  onChange: (value: string | null) => void
}

export default function NotificationTemplateEditor({value,defaultTemplate,variables,disabled,onChange}:Props) {
  const {t}=useI18n()
  const [confirmReset,setConfirmReset]=useState(false)
  const [notice,setNotice]=useState('')
  const issue=notificationTemplateIssue(value,variables)
  const copy=async(key:string)=>{
    try {
      await navigator.clipboard.writeText(`{${key}}`)
      setNotice(t('notificationTemplate.copied',{variable:`{${key}}`}))
    } catch { setNotice(t('notificationTemplate.copyFailed')) }
  }
  return <section className="notification-template-editor" aria-label={t('notificationTemplate.title')}>
    <div className="notification-hooks-actions">
      <h3>{t('notificationTemplate.title')}</h3>
      <Button disabled={disabled||value==null} onClick={()=>setConfirmReset(true)}>{t('notificationTemplate.reset')}</Button>
    </div>
    <p className="workflow-hooks-hint">{t('notificationTemplate.hint')}</p>
    <MarkdownEditor value={value??defaultTemplate} onChange={next=>{onChange(next);setNotice('')}} disabled={disabled} maxLength={maxNotificationTemplateLength} ariaLabel={t('notificationTemplate.title')}/>
    <div className="notification-template-feedback">
      {issue?<span role="alert">{t(`notificationTemplate.errors.${issue.kind}`,{variables:issue.variables})}</span>:<span role="status">{notice}</span>}
    </div>
    <details className="notification-template-catalog">
      <summary>{t('notificationTemplate.variablesTitle')}</summary>
      <div className="notification-template-variables">{variables.map(key=><Button key={key} data-template-variable={key} disabled={disabled} onClick={()=>void copy(key)} title={t('notificationTemplate.copyVariable',{variable:`{${key}}`})}>
        <code>{`{${key}}`}</code><small>{t(`notificationTemplate.variables.${key}` as TKey)}</small>
      </Button>)}</div>
    </details>
    <ConfirmDialog open={confirmReset} title={t('notificationTemplate.reset')} message={t('notificationTemplate.resetConfirm')} confirmText={t('workflowHooks.confirm')} onCancel={()=>setConfirmReset(false)} onConfirm={()=>{onChange(null);setNotice('');setConfirmReset(false)}}/>
  </section>
}
