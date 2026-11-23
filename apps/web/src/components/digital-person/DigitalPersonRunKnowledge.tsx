import {useEffect, useId, useState, type ReactNode} from 'react'
import {digitalRuntimeApi, type DigitalRunKnowledge, type DigitalRunProcessing} from '../../api/digitalPerson'
import {ApiError} from '../../api/transport'
import {localizeErrorDisplay, useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import './DigitalPersonRunKnowledge.css'

const memoryKinds = ['fact','event','preference','experience'] as const
const changeLabels = {added:'digitalPerson.runKindAdded',updated:'digitalPerson.runKindUpdated'} as const

export default function DigitalPersonRunKnowledge({runId}: {runId:string}) {
  const {t, fallbackLocale} = useI18n()
  const [result, setResult] = useState<DigitalRunKnowledge | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void digitalRuntimeApi.runKnowledge(runId, controller.signal).then(
      data => {
        if (controller.signal.aborted) return
        setResult(data)
      },
      reason => { if (!controller.signal.aborted) setError(reason) },
    )
    return () => controller.abort()
  }, [runId, attempt])
  if (result?.status === 'empty') return null
  const denied = error instanceof ApiError && [401, 403].includes(error.status)
  const title = t('digitalPerson.runKnowledgeTitle')
  return <section className="digital-run-knowledge-preview" aria-label={title} aria-busy={!result && !error}>
    <strong>{title}</strong>
    {!result && !error && <Spinner/>}
    {error && <>
      <p role="alert">{denied ? t('digitalPerson.runKnowledgeDenied') : localizeErrorDisplay(String(error))}</p>
      {!denied && <Button size="sm" onClick={() => {setError(null);setAttempt(value => value + 1)}}>{t('common.retry')}</Button>}
    </>}
    {result?.status === 'legacy' && <p>{t('digitalPerson.runKnowledgeLegacy')}</p>}
    {!!result?.items.length && <ul>{result.items.map(item => <li key={item.id}>
      {item.kind && item.operation && <span className="digital-run-knowledge-kind">{t(changeLabels[item.operation], {
        count:(1).toLocaleString(fallbackLocale),kind:t(`digitalMemoryView.${item.kind}Short`),
      })}</span>}
      {item.summary}
    </li>)}</ul>}
    {!!result?.unavailable && <p>{t('digitalPerson.runKnowledgeUnavailable', {count:result.unavailable.toLocaleString(fallbackLocale)})}</p>}
  </section>
}

export function DigitalPersonRunSummary({processing, fallback, children}: {
  processing?: DigitalRunProcessing
  fallback?: string
  children: (summary: ReactNode, summaryId: string) => ReactNode
}) {
  const {t, fallbackLocale} = useI18n()
  const summaryId = useId()
  if (!processing) return children(<span id={summaryId}>{fallback}</span>, summaryId)
  return children(<span id={summaryId} className={`digital-run-knowledge${processing.changes ? ' digital-run-knowledge--typed' : ''}`}>
      <span>{t('digitalPerson.runProcessedSources', {
        messages:processing.messages.toLocaleString(fallbackLocale),
        sessions:processing.sessions.toLocaleString(fallbackLocale),
      })}</span>
      {processing.changes ? (['added','updated'] as const).flatMap(operation => memoryKinds.map(kind => {
        const count=processing.changes?.[operation]?.[kind] ?? 0
        return count>0 ? <span key={`${operation}-${kind}`}>{t(changeLabels[operation], {
          count:count.toLocaleString(fallbackLocale),kind:t(`digitalMemoryView.${kind}Short`),
        })}</span> : null
      })) : processing.memories > 0 && <span>{t('digitalPerson.runMemoriesAdded', {count:processing.memories.toLocaleString(fallbackLocale)})}</span>}
    </span>, summaryId)
}

export function DigitalPersonRunHeader({runId, expanded, onToggle, processing, fallback, leadingIcon, children, className}: {
  runId: string
  expanded: boolean
  onToggle: () => void
  processing?: DigitalRunProcessing
  fallback: string
  leadingIcon?: ReactNode
  children: ReactNode
  className: string
}) {
  return <DigitalPersonRunSummary processing={processing} fallback={fallback}>
    {(summary, summaryId) => <Button type="button" className={`digital-run-header digital-run-detail-toggle ${className}`}
      aria-labelledby={summaryId} aria-expanded={expanded} aria-controls={expanded ? `digital-run-${runId}` : undefined} onClick={onToggle}>
      <span className="digital-run-header-summary">{leadingIcon}{summary}</span>
      <span className="digital-run-header-arrow" aria-hidden="true"><Icon name={expanded ? 'chevron-down' : 'chevron-right'}/></span>
      <span className="digital-run-meta">{children}</span>
    </Button>}
  </DigitalPersonRunSummary>
}
