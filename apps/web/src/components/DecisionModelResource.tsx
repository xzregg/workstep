import Button from './Button'
import Icon from './Icon'
import Spinner from './Spinner'
import { useI18n, type TKey } from '../i18n'
import { decisionResourceBusy, type DecisionModel, type DecisionResource, type DecisionResourceKind } from '../api/decisionModels'

export default function DecisionModelResource({ kind, resource, disabled, downloadDisabled = false, selectDisabled = false, onDownload, onCancel, onDelete, model, selected, onSelect }: {
  model?: DecisionModel; selected?: boolean; onSelect?: () => void
  kind: DecisionResourceKind; resource: DecisionResource; disabled: boolean; downloadDisabled?: boolean; selectDisabled?: boolean
  onDownload: () => void; onCancel: () => void; onDelete: () => void
}) {
  const { t } = useI18n(); const busy = decisionResourceBusy(resource)
  const runtime = kind === 'runtime' || kind === 'runtime-gguf'
  const native = kind === 'runtime-gguf'
  const stage = resource.installed && !busy ? 'installed' : resource.stage
  return <article className="decision-resource" data-resource={kind}>
    <div className="decision-resource-icon"><Icon name={runtime ? 'terminal' : 'layers'} size={20} /></div>
    <div className="decision-resource-body"><div className="decision-resource-title"><strong>{model?.name ?? t(native ? 'decisionModels.nativeRuntime' : runtime ? 'decisionModels.runtime' : 'decisionModels.modelName')}</strong>
      <span className="decision-badge" data-state={stage}>{busy && <Spinner size={11} />}{t(`decisionModels.${stage}` as TKey)}</span></div>
      <p>{model?.description ?? t(native ? 'decisionModels.nativeRuntimeHint' : runtime ? 'decisionModels.runtimeHint' : 'decisionModels.modelHint')}</p>
      <p className="decision-meta">{resource.size_bytes ? t('decisionModels.size', { size: Math.round(resource.size_bytes / 1e6) }) : t('decisionModels.runtimeSize')}</p>
      {model?.min_memory_gib != null && <p className="decision-meta">{t('decisionModels.modelRequirements', { total: model.min_memory_gib, available: model.min_available_gib ?? 2 })} · {model.backend === 'gguf' ? 'llama.cpp' : 'Laya SDK'}</p>}
      {model?.environment && !model.environment.supported && <p className="decision-error">{model.environment.reasons.join('；')}</p>}
      <code className="decision-resource-path">{resource.path}</code>
      {!runtime && <a className="decision-source" href={`https://huggingface.co/${model?.repo_id ?? `convaiinnovations/${model?.id ?? 'laya-multilingual'}`}`} target="_blank" rel="noreferrer">{t('decisionModels.downloadSource')}</a>}
      {busy && <div className="decision-progress"><progress aria-label={model?.name ?? t(native ? 'decisionModels.nativeRuntime' : runtime ? 'decisionModels.runtime' : 'decisionModels.modelName')}
        max={resource.total_bytes || 1} value={resource.total_bytes ? resource.downloaded_bytes : undefined} />
        {resource.total_bytes != null && <span>{Math.round(resource.downloaded_bytes / 1e6)} / {Math.round(resource.total_bytes / 1e6)} MB</span>}</div>}
      {resource.error && <p role="alert" className="decision-error">{resource.error}</p>}
    </div><div className="decision-resource-actions">{onSelect && <Button size="sm" aria-pressed={selected} disabled={disabled || selected || selectDisabled} onClick={onSelect}>{t(selected ? 'decisionModels.modelSelected' : 'decisionModels.useModel')}</Button>}{busy ? <Button size="sm" disabled={disabled} onClick={onCancel}>{t('decisionModels.cancel')}</Button>
      : resource.installed ? <Button size="sm" disabled={disabled} onClick={onDelete}>{t('decisionModels.delete')}</Button>
      : <Button size="sm" disabled={disabled || downloadDisabled} onClick={onDownload}>{t(resource.stage === 'error' ? 'decisionModels.retry' : runtime ? 'decisionModels.downloadRuntime' : 'decisionModels.downloadModel')}</Button>}</div>
  </article>
}
