import {useEffect, useId, useState, type ReactNode} from 'react'
import {digitalRuntimeApi, type DigitalRunKnowledge, type DigitalRunProcessing} from '../../api/digitalPerson'
import {ApiError} from '../../api/transport'
import {localizeErrorDisplay, useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import './DigitalPersonRunKnowledge.css'

function KnowledgePreview({runId}: {runId:string}) {
  const {t, fallbackLocale} = useI18n()
  const [result, setResult] = useState<DigitalRunKnowledge | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void digitalRuntimeApi.runKnowledge(runId, controller.signal).then(
      data => { if (!controller.signal.aborted) setResult(data) },
      reason => { if (!controller.signal.aborted) setError(reason) },
    )
    return () => controller.abort()
  }, [runId, attempt])
  const denied = error instanceof ApiError && [401, 403].includes(error.status)
  if (result?.status === 'empty') return null
  return <div className="digital-run-knowledge-preview" aria-busy={!result && !error}>
    {!result && !error && <Spinner/>}
    {error && <>
      <p role="alert">{denied ? t('digitalPerson.runKnowledgeDenied') : localizeErrorDisplay(String(error))}</p>
      {!denied && <Button size="sm" onClick={() => {setError(null);setAttempt(value => value + 1)}}>{t('common.retry')}</Button>}
    </>}
    {result?.status === 'legacy' && <p>{t('digitalPerson.runKnowledgeLegacy')}</p>}
    {!!result?.items.length && <ul>{result.items.map(item => <li key={item.id}>{item.summary}</li>)}</ul>}
    {!!result?.unavailable && <p>{t('digitalPerson.runKnowledgeUnavailable', {count:result.unavailable.toLocaleString(fallbackLocale)})}</p>}
  </div>
}

const countPlaceholder = '\uFFFC'

function useProcessedSources(processing?: DigitalRunProcessing) {
  const {t, fallbackLocale} = useI18n()
  return processing ? t('digitalPerson.runProcessedSources', {
    messages:processing.messages.toLocaleString(fallbackLocale),
    sessions:processing.sessions.toLocaleString(fallbackLocale),
  }) : ''
}

export function DigitalPersonProcessedSources({processing}: {processing: DigitalRunProcessing}) {
  return <p>{useProcessedSources(processing)}</p>
}

export default function DigitalPersonRunKnowledge({runId, processing, fallback, children}: {
  runId: string
  processing?: DigitalRunProcessing
  fallback?: string
  children: (summary: ReactNode, summaryId: string) => ReactNode
}) {
  const {t, fallbackLocale} = useI18n()
  const sources = useProcessedSources(processing)
  const [open, setOpen] = useState(false)
  const id = useId()
  const summaryId = `${id}-summary`
  if (!processing) return children(<span id={summaryId}>{fallback}</span>, summaryId)
  const {memories} = processing
  if (!memories) return children(<span id={summaryId} className="digital-run-knowledge">
    <span className="digital-run-knowledge-text">{sources}</span>
  </span>, summaryId)
  const label = t('digitalPerson.runMemoriesAdded', {count:memories.toLocaleString(fallbackLocale)})
  const template = t('digitalPerson.runProcessingSummary', {
    sources,
    knowledge:countPlaceholder,
  })
  const [before, after] = template.split(countPlaceholder, 2)
  const compact = t('digitalPerson.runProcessedSourcesCompact', {
    messages:processing.messages.toLocaleString(fallbackLocale),
    sessions:processing.sessions.toLocaleString(fallbackLocale),
  })
  const [compactBefore, compactAfter] = t('digitalPerson.runProcessingSummary', {
    sources:compact,
    knowledge:countPlaceholder,
  }).split(countPlaceholder, 2)
  return <>
    {children(<span id={summaryId} className="digital-run-knowledge">
      <span className="digital-run-knowledge-text">
        <span className="digital-run-knowledge-full">{before}{after === undefined && ' '}</span>
        <span className="digital-run-knowledge-compact" aria-hidden="true" data-text={compactBefore}/>
      </span>
      <Button type="button" className="digital-run-knowledge-toggle" aria-expanded={open}
        aria-controls={id} onClick={() => setOpen(value => !value)}>
        {label}<Icon name="chevron-down" size={12}/>
      </Button>
      {after && <span className="digital-run-knowledge-text">
        <span className="digital-run-knowledge-full">{after}</span>
        <span className="digital-run-knowledge-compact" aria-hidden="true" data-text={compactAfter}/>
      </span>}
    </span>, summaryId)}
    <div id={id} className="digital-run-knowledge-region" hidden={!open}>
      {open && <KnowledgePreview key={runId} runId={runId}/>}
    </div>
  </>
}
