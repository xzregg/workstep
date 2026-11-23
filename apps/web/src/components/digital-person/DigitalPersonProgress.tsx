import { memo } from 'react'
import type { AssistantChatMessage } from '../../stores/assistantStore'
import { recordedCommentary } from './digitalPersonCommentary'
import './DigitalPersonProgress.css'

export default memo(function DigitalPersonProgress({ message }: { message: AssistantChatMessage }) {
  const sentences = recordedCommentary(message)
  if (!sentences.length) return null
  return <div className="digital-person-progress">{sentences.map((sentence, index) =>
    <p key={index}>{sentence}</p>,
  )}</div>
})
