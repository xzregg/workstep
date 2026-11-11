import { useEffect, useRef, useState } from 'react'
import { connectorApi, type ConnectorDiagnostic, type ConnectorWrite } from '../../api/connectors'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import './ConnectorTestPanel.css'

export default function ConnectorTestPanel({ definition, valid, active, onConfigureAuth, onBusyChange }: {
  definition: ConnectorWrite; valid: boolean; active: boolean; onConfigureAuth: () => void; onBusyChange: (busy: boolean) => void
}) {
  const { t } = useI18n()
  const [result, setResult] = useState<ConnectorDiagnostic | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'connect' | 'invoke' | ''>('')
  const [toolName, setToolName] = useState('')
  const [argumentsText, setArgumentsText] = useState('{}')
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    pending.current?.abort(); pending.current = null
    setResult(null); setError(''); setBusy(''); setToolName(''); setArgumentsText('{}'); onBusyChange(false)
    return () => { pending.current?.abort(); pending.current = null; onBusyChange(false) }
  }, [definition, active, onBusyChange])
  let args: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
  } catch { /* Invalid JSON keeps execution disabled. */ }
  const run = async (invoke = false) => {
    if (pending.current || !valid || (invoke && (!args || !toolName))) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(invoke ? 'invoke' : 'connect'); onBusyChange(true); setError('')
    if (!invoke) { setResult(null); setToolName('') }
    try {
      const response = await connectorApi.diagnose(definition, invoke ? { tool_name: toolName, arguments: args! } : undefined, controller.signal)
      if (pending.current !== controller) return
      setResult(response)
      if (!invoke) setToolName(response.tools?.[0]?.name || '')
    } catch (reason) {
      if (pending.current === controller) {
        setResult(null)
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(''); onBusyChange(false) }
    }
  }
  const selected = result?.tools.find(tool => tool.name === toolName)
  const authRequired = result?.status === 'auth_required' || result?.status === 'forbidden'
  return <section className="connector-test-panel" hidden={!active} aria-busy={!!busy}>
    <header className="connector-test-heading"><div><h3>{t('connectors.testTitle')}</h3><p>{t('connectors.testDraftHint')}</p></div>
      <Button data-connector-diagnose disabled={!valid || !!busy} loading={busy === 'connect'} onClick={() => void run()}><Icon name="refresh" size={14} />{t('connectors.test')}</Button>
    </header>
    {!valid && <p className="connector-muted">{t('connectors.testInvalid')}</p>}
    {busy && <p className="connector-test-status" role="status"><span className="task-status-spinner" />{t(busy === 'connect' ? 'connectors.testing' : 'connectors.invoking')}</p>}
    {error && <p className="connector-error" role="alert">{error}</p>}
    {result && <div className="connector-test-status" data-ok={result.ok} role="status"><Icon name={result.ok ? 'check' : 'x'} size={16} /><span>{result.message}</span></div>}
    {authRequired && <div className="connector-test-auth"><Button data-connector-configure-auth onClick={onConfigureAuth}>{t('connectors.configureAuthentication')}</Button><p>{t('connectors.oauthNotAvailable')}</p></div>}
    {result?.status === 'cli_available' && <p className="connector-muted">{t('connectors.cliTestHint')}</p>}
    {!!result?.tools.length && <div className="connector-test-tools">
      <h3>{t('connectors.toolsCount', { count: result.tool_count })}</h3>
      {result.has_more && <p className="connector-muted">{t('connectors.toolsPartial')}</p>}
      <div className="connector-test-tool-list" role="group" aria-label={t('connectors.selectTestTool')}>
        {result.tools.map(tool => <button key={tool.name} type="button" disabled={!!busy} aria-pressed={toolName === tool.name} onClick={() => { setToolName(tool.name); setArgumentsText('{}') }}><strong>{tool.name}</strong><span>{tool.description}</span></button>)}
      </div>
      {selected && <div className="connector-test-invocation">
        <details><summary>{t('connectors.toolSchema')}</summary><pre>{JSON.stringify(selected.input_schema, null, 2)}</pre></details>
        <label>{t('connectors.toolArguments')}<textarea value={argumentsText} disabled={!!busy} spellCheck={false} placeholder={'{\n  "text": "Hello MCP"\n}'} onChange={event => setArgumentsText(event.target.value)} /></label>
        {!args && <p className="connector-error" role="alert">{t('connectors.toolArgumentsInvalid')}</p>}
        <div className="connector-test-invoke-actions"><p>{t('connectors.toolExecutionHint')}</p><Button data-connector-invoke disabled={!!busy || !args} loading={busy === 'invoke'} onClick={() => void run(true)}>{t('connectors.invokeTool')}</Button></div>
      </div>}
    </div>}
    {result?.result !== undefined && <div className="connector-test-output"><h3>{t('connectors.toolResult')}</h3><pre>{JSON.stringify(result.result, null, 2)}</pre></div>}
  </section>
}
