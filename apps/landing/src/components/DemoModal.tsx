import type { DemoDef } from '../demo/demos'
import { useI18n } from '../i18n'
import { DemoPlayer } from './DemoPlayer'
import { Modal } from './Modal'

const DEMO_INDEX: Record<DemoDef['id'], number> = {
  canvas: 1,
  stream: 2,
  parallel: 3,
}

interface DemoModalProps {
  demo: DemoDef
  onClose: () => void
}

export function DemoModal({ demo, onClose }: DemoModalProps) {
  const { t } = useI18n()
  const index = DEMO_INDEX[demo.id]

  return (
    <Modal onClose={onClose} className="demo-modal">
      <div className="demo-modal-head">
        <div>
          <h3>{t(`demos.item${index}Title`)}</h3>
          <p>{t(`demos.item${index}Desc`)}</p>
        </div>
      </div>
      <DemoPlayer demo={demo} autoplay />
    </Modal>
  )
}
