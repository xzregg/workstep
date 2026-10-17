import type { ReactNode } from 'react'
import type { SkinLayout } from '../skins/contract'
import './ConversationLayout.css'

/** Geometry only: children keep their original component identity across layout changes. */
export default function ConversationLayout({ position, editable, children }: { position: SkinLayout['composerPosition']; editable: boolean; children: ReactNode }) {
  return <div className="skin-conversation-layout" data-ui="conversation-layout" data-composer-position={editable ? position : 'bottom'}>{children}</div>
}
