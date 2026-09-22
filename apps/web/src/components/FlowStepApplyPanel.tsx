/**
 * FlowStepApplyPanel — apply only some of an AI flow patch's steps.
 *
 * The AI flow assistant returns incremental patches when editing an existing
 * workflow. Rather than overwriting the whole canvas, this panel lists the
 * steps a proposal touched and lets the user apply just the ones they want,
 * merging them onto the current canvas via `applyWorkflowPatch`.
 */
import { useMemo, useState } from 'react'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import { useI18n } from '../i18n'
import { applyWorkflowPatch, changedStepIds } from '../utils/workflowPatch'
import type { GenProposalCard } from '../stores/workflowGenStore'

export interface FlowStepApplyPanelProps {
  /** Proposals that came from an incremental patch (have stepChanges). */
  cards: GenProposalCard[]
  /** Snapshot of the current canvas to merge the selected steps onto. */
  currentSteps: () => any
  /** Apply the merged canvas (parent decides how to handle unsaved edits). */
  onApply: (steps: any, card: GenProposalCard) => void
  /** Currently applied proposal id, for the applied highlight. */
  appliedCardId?: string | null
  disabled?: boolean
}

import type { TKey } from '../i18n'

const CHANGE_LABEL: Record<string, TKey> = {
  added: 'aiFlow.stepChangeAdded',
  updated: 'aiFlow.stepChangeUpdated',
  removed: 'aiFlow.stepChangeRemoved',
}

export default function FlowStepApplyPanel({
  cards,
  currentSteps,
  onApply,
  appliedCardId,
  disabled,
}: FlowStepApplyPanelProps) {
  const { t } = useI18n()
  // Per-card selection of step ids; unknown ⇒ default to every changed step.
  const [selection, setSelection] = useState<Record<string, Set<number>>>({})
  const [activeCardId, setActiveCardId] = useState<string | null>(null)

  const defaults = useMemo(() => {
    const map: Record<string, Set<number>> = {}
    for (const card of cards) map[card.id] = changedStepIds(card.stepChanges)
    return map
  }, [cards])

  const selectedFor = (card: GenProposalCard) =>
    selection[card.id] ?? defaults[card.id] ?? new Set<number>()
  const activeCard = cards.find((card) => card.id === activeCardId)

  const toggleStep = (card: GenProposalCard, stepId: number) => {
    const next = new Set(selectedFor(card))
    if (next.has(stepId)) next.delete(stepId)
    else next.add(stepId)
    setSelection((current) => ({ ...current, [card.id]: next }))
  }

  const applyCard = (card: GenProposalCard) => {
    const selected = selectedFor(card)
    if (selected.size === 0) return
    const merged = applyWorkflowPatch(currentSteps(), card.patch ?? {}, selected)
    onApply(merged, card)
    setActiveCardId(null)
  }

  const requestApply = (card: GenProposalCard) => {
    const changes = card.stepChanges ?? []
    if (changes.length === 1) {
      applyCard(card)
      return
    }
    setActiveCardId(card.id)
  }

  if (cards.length === 0) return null

  return (
    <div className="flow-step-apply-panel">
      {cards.map((card) => {
        const changes = card.stepChanges ?? []
        return <div key={card.id} className="flow-step-apply-card">
          <div className="flow-step-apply-card-copy">
            <strong>{card.title}</strong>
            {card.summary && <span>{card.summary}</span>}
          </div>
          <span className="flow-step-apply-card-count">
            {changes.length === 1
              ? `${t(CHANGE_LABEL[changes[0].change] ?? 'aiFlow.stepChangeUpdated')}：${changes[0].title || changes[0].key || `#${changes[0].id}`}`
              : t('aiFlow.stepChangeCount', { count: changes.length })}
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={disabled}
            onClick={() => requestApply(card)}
          >
            {appliedCardId === card.id ? t('aiFlow.applied') : t('aiFlow.stepApplyOpen')}
          </Button>
        </div>
      })}

      <ConfirmDialog
        open={Boolean(activeCard)}
        title={t('aiFlow.stepApplyTitle')}
        message={t('aiFlow.stepApplyHint')}
        confirmText={t('aiFlow.stepApplyButton')}
        confirmDisabled={!activeCard || selectedFor(activeCard).size === 0}
        width={440}
        onConfirm={() => { if (activeCard) applyCard(activeCard) }}
        onCancel={() => setActiveCardId(null)}
      >
        {activeCard && (
          <div className="flow-step-apply-dialog">
            <div className="flow-step-apply-dialog-toolbar">
              <span>
                {t('aiFlow.stepApplyCount', {
                  count: selectedFor(activeCard).size,
                  total: activeCard.stepChanges?.length ?? 0,
                })}
              </span>
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelection((current) => ({
                    ...current,
                    [activeCard.id]: changedStepIds(activeCard.stepChanges),
                  }))}
                >
                  {t('aiFlow.stepSelectAll')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelection((current) => ({
                    ...current,
                    [activeCard.id]: new Set(),
                  }))}
                >
                  {t('aiFlow.stepSelectNone')}
                </Button>
              </div>
            </div>
            {activeCard?.stepChanges?.map((change) => (
              <label key={`${activeCard.id}-${change.id}`} className="flow-step-apply-option">
                <input
                  className="flow-step-apply-checkbox"
                  type="checkbox"
                  checked={selectedFor(activeCard).has(change.id)}
                  onChange={() => toggleStep(activeCard, change.id)}
                />
                <span className="flow-step-apply-option-title">
                  {change.title || change.key || `#${change.id}`}
                </span>
                <span className={`flow-step-apply-change flow-step-apply-change--${change.change}`}>
                  {t(CHANGE_LABEL[change.change] ?? 'aiFlow.stepChangeUpdated')}
                </span>
              </label>
            ))}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
