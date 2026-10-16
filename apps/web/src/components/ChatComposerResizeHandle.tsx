import type { useChatComposerResize } from '../hooks/useChatComposerResize'
import { useI18n } from '../i18n'

type Props = Pick<ReturnType<typeof useChatComposerResize>, 'startResize' | 'resetHeight' | 'handleResizeKey'>

export default function ChatComposerResizeHandle({ startResize, resetHeight, handleResizeKey }: Props) {
  const { t } = useI18n()
  return <div
    role="separator"
    aria-orientation="horizontal"
    aria-label={t('layout.dragResizeComposer')}
    title={t('layout.dragResizeComposer')}
    tabIndex={0}
    onMouseDown={startResize}
    onDoubleClick={resetHeight}
    onKeyDown={handleResizeKey}
    className="chat-composer-resize-handle"
  />
}
