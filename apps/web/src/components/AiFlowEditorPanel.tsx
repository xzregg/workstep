import { useRef, useState } from 'react'
import { useI18n } from '../i18n'
import AiFlowChat from './AiFlowChat'
import Button from './Button'
import type { GenProposalCard } from '../stores/workflowGenStore'

interface AiFlowEditorPanelProps {
  projectId: string
  workflowId?: string
  workflowName?: string
  getCanvasSteps?: () => any
  onProposal: (steps: any, proposal?: GenProposalCard) => void
  onRestore: (steps: any) => void
  onBusyChange: (busy: boolean) => void
  onRequestClose: () => void
  title: string
}

export default function AiFlowEditorPanel({
  projectId,
  workflowId,
  workflowName,
  getCanvasSteps,
  onProposal,
  onRestore,
  onBusyChange,
  onRequestClose,
  title,
}: AiFlowEditorPanelProps) {
  const { t } = useI18n()
  const [width, setWidth] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? 400
    const onMove = (moveEvent: MouseEvent) => {
      setWidth(Math.min(720, Math.max(280, startWidth - (moveEvent.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }

  return (
    <>
      <div
        className="ai-flow-editor-handle"
        onMouseDown={startDrag}
        title={t('layout.dragResizeChat')}
        style={{
          width: 3, flexShrink: 0, cursor: 'col-resize', position: 'relative',
          background: 'transparent',        }}
      >
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: '50%', transform: 'translateX(-50%)',
          width: 1, background: 'var(--border-soft)',
        }} />
      </div>
      <div ref={panelRef} className="ai-flow-editor-panel" style={{
        width: width ?? '33.333%', maxWidth: '90vw', flexShrink: 0,
        background: 'var(--surface)', borderLeft: '1px solid var(--border-soft)',
        display: 'flex', flexDirection: 'column', minHeight: 0,
      }}>
        <header className="ai-flow-editor-mobile-header">
          <strong>{title}</strong>
          <Button variant="ghost" size="sm" onClick={onRequestClose}>
            {t('common.close')}
          </Button>
        </header>
        <AiFlowChat
          projectId={projectId}
          workflowId={workflowId}
          workflowName={workflowName}
          getCanvasSteps={getCanvasSteps}
          onProposal={onProposal}
          onRestore={onRestore}
          onBusyChange={onBusyChange}
          onClose={onRequestClose}
          title={title}
        />
      </div>
    </>
  )
}
