import { useState } from 'react'
import { useI18n } from '../../i18n'
import Icon from '../Icon'

export function parseArguments(text: string): string[] | null {
  if (!text.trim()) return []
  if (!text.trimStart().startsWith('[')) return text.split('\n')
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null
  } catch { return null }
}

export default function ConnectorArgumentsEditor({ text, onChange, cli }: { text: string; onChange: (text: string) => void; cli: boolean }) {
  const { t } = useI18n()
  const [source, setSource] = useState(false)
  const args = parseArguments(text)
  const update = (next: string[]) => onChange(JSON.stringify(next, null, 2))
  return <div className="connector-arguments">
    <div className="connector-field-heading"><span>{t('connectors.arguments')}</span><div className="connector-edit-mode" role="group" aria-label={t('connectors.editMode')}>
      <button type="button" aria-pressed={!source} disabled={args === null} onClick={() => setSource(false)}>{t('connectors.visual')}</button>
      <button type="button" data-connector-args-source aria-pressed={source} onClick={() => setSource(true)}>{t('connectors.source')}</button>
    </div></div>
    {source ? <label className="connector-source-field"><span className="connector-muted">{t('connectors.args')}</span><textarea className="connector-args-input" value={text}
      placeholder={cli ? '[\n  "--help"\n]' : '[\n  "-y",\n  "@modelcontextprotocol/server-filesystem",\n  "/path/to/project"\n]'}
      aria-invalid={args === null || undefined} onChange={e => onChange(e.target.value)} /></label> : <>
      {(args || []).map((argument, index) => <div className="connector-argument-row" key={index}>
        <span>{index + 1}</span><input value={argument} aria-label={t('connectors.argumentNumber', { count: index + 1 })} placeholder={index === 0 ? '-y / --help' : t('connectors.argumentValue')} onChange={e => update((args || []).map((item, i) => i === index ? e.target.value : item))} />
        <button type="button" className="connector-icon" aria-label={t('connectors.removeArgument', { count: index + 1 })} onClick={() => update((args || []).filter((_, i) => i !== index))}><Icon name="x" size={14} /></button>
      </div>)}
      <button type="button" className="connector-add-row" onClick={() => update([...(args || []), ''])}><Icon name="plus" size={14} />{t('connectors.addArgument')}</button>
    </>}
    {args === null && <small className="connector-error">{t('connectors.argsInvalid')}</small>}
  </div>
}
