/**
 * FlowStageApplyPanel — apply only some of an AI flow patch's stages.
 *
 * The AI flow assistant returns incremental patches when editing an existing
 * workflow. Rather than overwriting the whole canvas, this panel lists the
 * stages a proposal touched and lets the user apply just the ones they want,
 * merging them onto the current canvas via `applyWorkflowPatch`.
 */
import { useMemo, useState } from 'react'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import { useI18n } from '../i18n'
import { applyWorkflowPatch, changedStageIds } from '../utils/workflowPatch'
import type { GenProposalCard } from '../stores/workflowGenStore'

export interface FlowStageApplyPanelProps {
  /** Proposals that came from an incremental patch (have stageChanges). */
  cards: GenProposalCard[]
  /** Snapshot of the current canvas to merge the selected stages onto. */
  currentSteps: () => any
  /** Apply the merged canvas (parent decides how to handle unsaved edits). */
  onApply: (steps: any, card: GenProposalCard) => void
  /** Currently applied proposal id, for the applied highlight. */
  appliedCardId?: string | null
  disabled?: boolean
}

import type { TKey } from '../i18n'

const CHANGE_LABEL: Record<string, TKey> = {
  added: 'aiFlow.stageChangeAdded',
  updated: 'aiFlow.stageChangeUpdated',
  removed: 'aiFlow.stageChangeRemoved',
}

export default function FlowStageApplyPanel({
  cards,
  currentSteps,
  onApply,
  appliedCardId,
  disabled,
}: FlowStageApplyPanelProps) {
  const { t } = useI18n()
  // Per-card selection of stage ids; unknown ⇒ default to every changed stage.
  const [selection, setSelection] = useState<Record<string, Set<number>>>({})
  const [activeCardId, setActiveCardId] = useState<string | null>(null)

  const defaults = useMemo(() => {
    const map: Record<string, Set<number>> = {}
    for (const card of cards) map[card.id] = changedStageIds(card.stageChanges)
    return map
  }, [cards])

  const selectedFor = (card: GenProposalCard) =>
    selection[card.id] ?? defaults[card.id] ?? new Set<number>()
  const activeCard = cards.find((card) => card.id === activeCardId)

  const toggleStage = (card: GenProposalCard, stageId: number) => {
    const next = new Set(selectedFor(card))
    if (next.has(stageId)) next.delete(stageId)
    else next.add(stageId)
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
    const changes = card.stageChanges ?? []
    if (changes.length === 1) {
      applyCard(card)
      return
    }
    setActiveCardId(card.id)
  }

  if (cards.length === 0) return null

  return (
    <div className="flow-stage-apply-panel">
      {cards.map((card) => {
        const changes = card.stageChanges ?? []
        return <div key={card.id} className="flow-stage-apply-card">
          <div className="flow-stage-apply-card-copy">
            <strong>{card.title}</strong>
            {card.summary && <span>{card.summary}</span>}
          </div>
          <span className="flow-stage-apply-card-count">
            {changes.length === 1
              ? `${t(CHANGE_LABEL[changes[0].change] ?? 'aiFlow.stageChangeUpdated')}：${changes[0].title || changes[0].key || `#${changes[0].id}`}`
              : t('aiFlow.stageChangeCount', { count: changes.length })}
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={disabled}
            onClick={() => requestApply(card)}
          >
            {appliedCardId === card.id ? t('aiFlow.applied') : t('aiFlow.stageApplyOpen')}
          </Button>
        </div>
      })}

      <ConfirmDialog
        open={Boolean(activeCard)}
        title={t('aiFlow.stageApplyTitle')}
        message={t('aiFlow.stageApplyHint')}
        confirmText={t('aiFlow.stageApplyButton')}
        confirmDisabled={!activeCard || selectedFor(activeCard).size === 0}
        width={440}
        onConfirm={() => { if (activeCard) applyCard(activeCard) }}
        onCancel={() => setActiveCardId(null)}
      >
        {activeCard && (
          <div className="flow-stage-apply-dialog">
            <div className="flow-stage-apply-dialog-toolbar">
              <span>
                {t('aiFlow.stageApplyCount', {
                  count: selectedFor(activeCard).size,
                  total: activeCard.stageChanges?.length ?? 0,
                })}
              </span>
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelection((current) => ({
                    ...current,
                    [activeCard.id]: changedStageIds(activeCard.stageChanges),
                  }))}
                >
                  {t('aiFlow.stageSelectAll')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelection((current) => ({
                    ...current,
                    [activeCard.id]: new Set(),
                  }))}
                >
                  {t('aiFlow.stageSelectNone')}
                </Button>
              </div>
            </div>
            {activeCard?.stageChanges?.map((change) => (
              <label key={`${activeCard.id}-${change.id}`} className="flow-stage-apply-option">
                <input
                  className="flow-stage-apply-checkbox"
                  type="checkbox"
                  checked={selectedFor(activeCard).has(change.id)}
                  onChange={() => toggleStage(activeCard, change.id)}
                />
                <span className="flow-stage-apply-option-title">
                  {change.title || change.key || `#${change.id}`}
                </span>
                <span className={`flow-stage-apply-change flow-stage-apply-change--${change.change}`}>
                  {t(CHANGE_LABEL[change.change] ?? 'aiFlow.stageChangeUpdated')}
                </span>
              </label>
            ))}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
