import { useI18n } from '../i18n'
import type { StepNodeData } from './flowCanvasData'
import type { ProposalChange } from '../utils/flowProposalPreview'

export default function FlowProposalBadge({ data }: { data: StepNodeData }) {
  const { t } = useI18n()
  if (!data.proposalChange) return null
  const change = data.proposalChange as ProposalChange
  const labels = { added: t('aiFlow.stepChangeAdded'), updated: t('aiFlow.stepChangeUpdated'), removed: t('aiFlow.stepChangeRemoved') }
  return <div className="flow-proposal-node-badge">
    <span>{labels[change]}</span>
    {data.proposalPhase === 'preview' && change === 'updated' && data.proposalPreviousTitle !== data.label &&
      <span className="flow-proposal-previous-title" title={String(data.proposalPreviousTitle || '')}>
        {t('aiFlow.previewPreviousTitle', { title: String(data.proposalPreviousTitle || '') })}
      </span>}
  </div>
}
