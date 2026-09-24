import { useState } from 'react'
import { actionDirectoryApi } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import Field from './Field'
import Input from './Input'
import ProjectDirectoryBrowserDialog from './ProjectDirectoryBrowserDialog'
import Select from './Select'

export interface ActionButtonValue {
  actionId: string
  scriptPath: string
  cwdMode: 'project' | 'task' | 'worktrees'
  requireConfirmation: boolean
}

interface Props {
  projectId: string
  workflowId?: string
  value: ActionButtonValue
  onChange: (next: ActionButtonValue) => void
}

export default function ActionButtonFields({ projectId, workflowId, value, onChange }: Props) {
  const { t } = useI18n()
  const [browser, setBrowser] = useState<'select' | 'preview' | null>(null)
  const [error, setError] = useState('')
  const [directory, setDirectory] = useState('')

  const openBrowser = async (mode: 'select' | 'preview') => {
    if (!value.actionId.trim()) return
    setError('')
    try {
      const result = await actionDirectoryApi.ensure(projectId, value.actionId.trim(), workflowId)
      setDirectory(result.path)
      setBrowser(mode)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('actionShortcuts.directoryFailed'))
    }
  }

  return <>
    <Field label="Action ID" required>
      <Input value={value.actionId} onChange={(event) => onChange({ ...value, actionId: event.target.value })} placeholder="restart-services" />
    </Field>
    <Field label={t('actionShortcuts.scriptFile')} required error={error || undefined} help={t('actionShortcuts.scriptHelp')}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input value={value.scriptPath} readOnly placeholder={t('actionShortcuts.selectScript')} style={{ flex: 1, minWidth: 0 }} />
        <Button variant="ghost" disabled={!value.actionId.trim()} onClick={() => void openBrowser('select')}>{t('actionShortcuts.select')}</Button>
        {value.scriptPath && <Button variant="ghost" onClick={() => void openBrowser('preview')}>{t('actionShortcuts.preview')}</Button>}
      </div>
    </Field>
    <Field label={t('actionShortcuts.executionDirectory')}>
      <Select value={value.cwdMode} onChange={(event) => onChange({ ...value, cwdMode: event.target.value as ActionButtonValue['cwdMode'] })}>
        <option value="project">{t('actionShortcuts.projectDirectory')}</option>
        <option value="task">{t('actionShortcuts.taskDirectory')}</option>
        <option value="worktrees">{t('actionShortcuts.worktreesDirectory')}</option>
      </Select>
    </Field>
    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input type="checkbox" checked={value.requireConfirmation} onChange={(event) => onChange({ ...value, requireConfirmation: event.target.checked })} />
      {t('actionShortcuts.requireConfirmation')}
    </label>
    {browser && <ProjectDirectoryBrowserDialog
      projectId={projectId}
      title={browser === 'select' ? t('actionShortcuts.selectScript') : t('actionShortcuts.fileDirectory')}
      rootPath={directory}
      displayPath={directory}
      initialFilePath={browser === 'preview' && value.scriptPath ? `${directory}/${value.scriptPath}` : undefined}
      onSelectFile={browser === 'select' ? (path) => {
        const prefix = `${directory}/`
        if (!path.startsWith(prefix)) { setError(t('actionShortcuts.outsideDirectory')); return }
        onChange({ ...value, scriptPath: path.slice(prefix.length) })
        setBrowser(null)
      } : undefined}
      onClose={() => setBrowser(null)}
    />}
  </>
}
