import { useEffect, useRef, useState } from 'react'
import Button from './Button'
import { useI18n, type TKey } from '../i18n'
import { applyWorkflowPatch, changedStepIds } from '../utils/workflowPatch'
import type { GenProposalCard } from '../stores/workflowGenStore'
import './FlowProposalPreview.css'

export interface FlowStepApplyPanelProps {
  cards: GenProposalCard[]
  currentSteps: () => any
  onApply: (steps: any, card: GenProposalCard) => unknown
  onPreview?: (steps: any | null, card?: GenProposalCard) => void
  appliedCardId?: string | null
  disabled?: boolean
}

const CHANGE_LABEL: Record<string, TKey> = {
  added: 'aiFlow.stepChangeAdded', updated: 'aiFlow.stepChangeUpdated', removed: 'aiFlow.stepChangeRemoved',
}

/** Inline selection lets the user see the canvas while deciding what to apply. */
export default function FlowStepApplyPanel({ cards, currentSteps, onApply, onPreview, appliedCardId, disabled }: FlowStepApplyPanelProps) {
  const { t } = useI18n()
  const [selection, setSelection] = useState<Map<GenProposalCard, Set<number>>>(new Map())
  const [previewCard, setPreviewCard] = useState<GenProposalCard | null>(null)
  const [applying, setApplying] = useState(false)
  const callbacks = useRef({ currentSteps, onPreview })
  useEffect(() => { callbacks.current = { currentSteps, onPreview } })
  const active = cards.find(card => card === previewCard) ?? cards[0]
  const selectedFor = (card: GenProposalCard) => selection.get(card) ?? changedStepIds(card.stepChanges)
  const resolve = (card: GenProposalCard) => card.patch
    ? applyWorkflowPatch(callbacks.current.currentSteps(), card.patch, selectedFor(card))
    : card.steps

  useEffect(() => {
    if (!active) { callbacks.current.onPreview?.(null); return }
    // loadSteps owns the applied animation. Do not clear it when the card settles.
    if (active.id === appliedCardId) return
    const steps = active.patch
      ? applyWorkflowPatch(callbacks.current.currentSteps(), active.patch, selection.get(active) ?? changedStepIds(active.stepChanges))
      : active.steps
    callbacks.current.onPreview?.(steps, active)
  }, [active, selection, appliedCardId])
  useEffect(() => () => callbacks.current.onPreview?.(null), [])

  const toggle = (card: GenProposalCard, id: number) => {
    const next = new Set(selectedFor(card))
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelection(current => new Map([...current].filter(([item]) => cards.includes(item))).set(card, next))
  }
  const apply = async (card: GenProposalCard) => {
    if (applying || disabled) return
    setApplying(true)
    try { await onApply(resolve(card), card) } finally { setApplying(false) }
  }

  if (!active) return null
  return <div className="flow-step-apply-panel flow-proposal-panel">
    {cards.map(card => {
      const isActive = card === active
      const done = card.id === appliedCardId
      const changes = card.stepChanges ?? []
      return <section className="flow-proposal-card" key={card.id} aria-label={card.title}>
        <div className="flow-proposal-card-heading">
          <strong>{card.title}</strong>
          <span>{done ? t('aiFlow.applied') : isActive ? t('aiFlow.previewPending') : t('aiFlow.previewAlternative')}</span>
        </div>
        {card.summary && <p>{card.summary}</p>}
        {isActive && changes.map(change => <label className="flow-step-apply-option" key={change.id}>
          <input className="flow-step-apply-checkbox" type="checkbox"
            checked={selectedFor(card).has(change.id)} disabled={disabled || applying || done}
            onChange={() => toggle(card, change.id)} />
          <span className="flow-step-apply-option-title" title={change.title || change.key}>{change.title || change.key || `#${change.id}`}</span>
          <span className={`flow-step-apply-change flow-step-apply-change--${change.change}`}>
            {t(CHANGE_LABEL[change.change] ?? 'aiFlow.stepChangeUpdated')}
          </span>
        </label>)}
        <div className="flow-proposal-card-footer">
          <span>{changes.length ? t('aiFlow.stepApplyCount', { count: selectedFor(card).size, total: changes.length }) : t('flow.nodeCount', { count: card.nodeCount })}</span>
          {isActive ? <Button size="sm" variant="primary" data-apply-proposal={card.id}
            disabled={disabled || applying || done || (!!card.patch && selectedFor(card).size === 0)}
            loading={applying} onClick={() => void apply(card)}>
            {done ? t('aiFlow.applied') : t('aiFlow.stepApplyButton')}
          </Button> : <Button size="sm" variant="ghost" disabled={disabled || applying} onClick={() => setPreviewCard(card)}>{t('aiFlow.previewProposal')}</Button>}
        </div>
      </section>
    })}
    {onPreview && <p className="flow-proposal-hint">{t('aiFlow.previewHint')}</p>}
  </div>
}
