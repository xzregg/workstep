import { useEffect, useRef, useState } from 'react'
import { decisionModelsApi, validDecisionEndpoint, type DecisionModelSource } from '../api/decisionModels'
import { useI18n } from '../i18n'
import Button from './Button'
import Select from './Select'
import './DecisionServiceModels.css'

export default function DecisionServiceModels({ source, value, disabled, onSelect }: {
  source: DecisionModelSource; value: string; disabled: boolean; onSelect: (model: string) => void
}) {
  const { t } = useI18n()
  const [models, setModels] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    pending.current?.abort(); setModels(null); setError(''); setLoading(false)
    return () => pending.current?.abort()
  }, [source.mode, source.base_url, source.api_key])
  const load = async () => {
    if (loading || disabled || !validDecisionEndpoint(source.base_url)) return
    const controller = new AbortController(); pending.current = controller
    setLoading(true); setError(''); setModels(null)
    try {
      const response = await decisionModelsApi.models(source, controller.signal)
      if (!controller.signal.aborted) setModels(response.models)
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('decisionModels.modelsLoadFailed'))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  return <div className="decision-service-models">
    <div className="decision-service-models-controls">
      <Button size="sm" disabled={disabled || loading || !validDecisionEndpoint(source.base_url)} loading={loading} onClick={() => void load()}>{t('decisionModels.readModels')}</Button>
      {models !== null && models.length > 0 && <Select aria-label={t('decisionModels.chooseServiceModel')} disabled={disabled || loading} value={models.includes(value) ? value : ''} onChange={event => onSelect(event.target.value)}>
        <option value="">{t('decisionModels.chooseServiceModel')}</option>{models.map(model => <option key={model} value={model}>{model}</option>)}
      </Select>}
    </div>
    {error && <p role="alert" className="decision-error">{error}</p>}
    {models !== null && <p role="status">{models.length ? t('decisionModels.modelsLoaded', { count: models.length }) : t('decisionModels.noServiceModels')}</p>}
    <p>{t('decisionModels.serviceModelsHint')}</p>
  </div>
}
