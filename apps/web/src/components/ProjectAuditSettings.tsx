import { useEffect, useState } from 'react'
import { projectAuditApi, type ProjectAuditPage } from '../api/projectAudit'
import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import './ProjectAuditSettings.css'

export default function ProjectAuditSettings({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const [filters, setFilters] = useState({ action: '', result: '', before: undefined as string | undefined })
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<ProjectAuditPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const actions: Record<string, string> = {
    'file.upload': t('projectAudit.upload'), 'workflow.create': t('projectAudit.createWorkflow'),
    'workflow.update': t('projectAudit.updateWorkflow'), 'workflow.delete': t('projectAudit.deleteWorkflow'),
    'workflow.restore': t('projectAudit.restoreWorkflow'), 'task.create': t('projectAudit.createTask'),
    'task.start': t('projectAudit.startTask'), 'task.cancel': t('projectAudit.stopTask'),
    'task.resume': t('projectAudit.resumeTask'), 'task.archive': t('projectAudit.archiveTask'),
    'task.unarchive': t('projectAudit.unarchiveTask'), 'task.copy': t('projectAudit.copyTask'),
    'step.cancel': t('projectAudit.cancelStep'), 'request.denied': t('projectAudit.requestDenied'),
    'request.failed': t('projectAudit.requestFailed'),
    'task.pause': t('projectAudit.pauseTask'), 'task.delete': t('projectAudit.deleteTask'),
  }
  const sources: Record<string, string> = {
    remote_project: t('projectAudit.remoteProject'), gateway: t('projectAudit.gateway'),
    gateway_share: t('projectAudit.gatewayShare'), task_share: t('projectAudit.taskShare'),
    remote_browser: t('projectAudit.remoteBrowser'),
  }
  const results: Record<string, string> = { succeeded: t('projectAudit.succeeded'), denied: t('projectAudit.denied'), failed: t('projectAudit.failed') }

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setPage(null)
    void projectAuditApi.list(projectId, { ...filters, signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setPage(data) })
      .catch(() => { if (!controller.signal.aborted) setError(t('projectAudit.error')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [projectId, filters, revision, t])

  return <div className="project-audit-settings">
    <p className="project-audit-hint">{t('projectAudit.hint', { days: page?.retention_days ?? 30 })}</p>
    <div className="project-audit-controls">
      <label>{t('projectAudit.action')}<select aria-label={t('projectAudit.action')} value={filters.action}
        onChange={event => setFilters(previous => ({ ...previous, action: event.target.value, before: undefined }))}>
        <option value="">{t('projectAudit.all')}</option>
        {Object.entries(actions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>{t('projectAudit.result')}<select aria-label={t('projectAudit.result')} value={filters.result}
        onChange={event => setFilters(previous => ({ ...previous, result: event.target.value, before: undefined }))}>
        <option value="">{t('projectAudit.all')}</option>
        {Object.entries(results).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <Button disabled={loading} onClick={() => { setFilters(previous => ({ ...previous, before: undefined })); setRevision(value => value + 1) }}>
        <Icon name="refresh" size={14} />{t('projectAudit.refresh')}
      </Button>
    </div>
    {loading && <p className="project-audit-loading" role="status"><Icon name="loader-circle" size={16} className="project-audit-spinner" />{t('common.loading')}</p>}
    {error && <p role="alert">{error}<Button onClick={() => setRevision(value => value + 1)}>{t('projectAudit.retry')}</Button></p>}
    {!loading && !error && page?.items.length === 0 && <p>{t('projectAudit.empty')}</p>}
    <ol className="project-audit-list">
      {page?.items.map(item => <li key={item.id} className="project-audit-row">
        <div className="project-audit-event"><strong title={item.actor_id ?? ''}>{item.actor_name || item.actor_username || t('projectAudit.unknown')}</strong>
          <span>{actions[item.action] ?? item.action}</span>
          <span className="project-audit-object">{String(item.metadata.object_name || item.metadata.file_name || item.task_id || item.metadata.workflow_id || '')}</span>
        </div>
        <div className="project-audit-meta"><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
          <span>{results[item.result] ?? item.result}</span><span>{sources[String(item.metadata.access_source)] ?? ''}</span>
        </div>
        {item.metadata.file_path && <div className="project-audit-path">{String(item.metadata.file_path)}</div>}
      </li>)}
    </ol>
    <div className="project-audit-pagination">
      <Button disabled={loading || !filters.before} onClick={() => setFilters(previous => ({ ...previous, before: undefined }))}>{t('projectAudit.first')}</Button>
      <Button disabled={loading || !page?.next_before} onClick={() => setFilters(previous => ({ ...previous, before: page?.next_before ?? undefined }))}>{t('projectAudit.next')}</Button>
    </div>
  </div>
}
