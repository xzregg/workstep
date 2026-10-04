import { useEffect, useState } from 'react'
import { engineApi, type EngineInspectResult } from '../api/client'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import Button from './Button'
import ResizablePanel from './ResizablePanel'
import './EngineCapabilitiesDialog.css'

interface Props {
  engineId: string
  onClose: () => void
}

export default function EngineCapabilitiesDialog({ engineId, onClose }: Props) {
  const { t } = useI18n()
  const [result, setResult] = useState<EngineInspectResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const project = useProjectStore.getState().activeProject
    setLoading(true)
    setResult(null)
    setError('')
    void engineApi.inspect(engineId, project?.id, project?.path || undefined)
      .then((value) => {
        if (active) setResult(value)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t('settings.inspectFailed', { error: '' }))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [engineId, t])

  return (
    <div
      className="modal-overlay engine-capabilities-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.viewCapabilitiesTitle')}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <ResizablePanel className="modal engine-capabilities-panel" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header engine-capabilities-header">
          <span className="modal-title">{t('settings.viewCapabilitiesTitle')}</span>
          <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={onClose}>✕</Button>
        </div>
        <div className="modal-body engine-capabilities-body">
          {loading ? (
            <div className="engine-capabilities-loading">{t('settings.inspectLoading')}</div>
          ) : error ? (
            <div role="status" className="engine-capabilities-error">× {error}</div>
          ) : result ? (
            <div className="engine-capabilities-content">
              <div className="engine-capabilities-project">
                {result.project_root
                  ? t('settings.inspectProject', { path: result.project_root })
                  : t('settings.inspectProjectNone')}
              </div>
              <section>
                <div className="engine-capabilities-heading">
                  {t('settings.inspectSkills')} <span className="engine-capabilities-count">· {result.skills.length}</span>
                </div>
                {result.skills.length === 0 ? (
                  <div className="engine-capabilities-empty">{t('settings.inspectSkillsEmpty')}</div>
                ) : (
                  <div className="engine-capabilities-list">
                    {result.skills.map((skill) => (
                      <div className="engine-capabilities-card" key={`${skill.source_dir}:${skill.name}`}>
                        <div className="engine-capabilities-card-title">{skill.name}</div>
                        {skill.description && <div className="engine-capabilities-description">{skill.description}</div>}
                        <div className="engine-capabilities-source">{skill.source_dir}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <section>
                <div className="engine-capabilities-heading">
                  {t('settings.inspectMcp')} <span className="engine-capabilities-count">· {result.mcp_servers.length}</span>
                </div>
                <div className={result.mcp_supported ? 'engine-capabilities-supported' : 'engine-capabilities-unsupported'}>
                  {result.mcp_supported
                    ? `✓ ${t('settings.inspectMcpSupported')}`
                    : result.mcp_error || t('settings.inspectMcpUnsupported')}
                </div>
                {result.mcp_servers.length === 0 ? (
                  <div className="engine-capabilities-empty">{t('settings.inspectMcpEmpty')}</div>
                ) : (
                  <div className="engine-capabilities-list">
                    {result.mcp_servers.map((server) => (
                      <div className="engine-capabilities-card" key={server.name}>
                        <div className="engine-capabilities-card-title">{server.name}</div>
                        <div className="engine-capabilities-command">{server.command} {server.args.join(' ')}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </ResizablePanel>
    </div>
  )
}
