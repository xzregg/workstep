import { forwardRef, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, type UIEvent } from 'react'
import { highlightedLines } from '../CodeFilePreview'

interface Props {
  filename: string
  value: string
  targetLine: number
  editable?: boolean
  ariaLabel: string
  onChange?: (value: string) => void
  onSave?: () => void
  gutter?: 'left' | 'right'
  onVerticalScroll?: (scrollTop: number) => void
}

export interface GitCodeEditorHandle {
  setScrollTop: (scrollTop: number) => void
}

export default forwardRef<GitCodeEditorHandle, Props>(function GitCodeEditor({ filename, value, targetLine, editable, ariaLabel, onChange, onSave, gutter = 'left', onVerticalScroll }, ref) {
  const deferredValue = useDeferredValue(value)
  const highlighted = useMemo(() => highlightedLines(filename, deferredValue), [filename, deferredValue])
  const highlightRef = useRef<HTMLPreElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const targetRef = useRef<HTMLSpanElement>(null)

  function setScrollTop(scrollTop: number) {
    if (textareaRef.current) textareaRef.current.scrollTop = scrollTop
    if (highlightRef.current) highlightRef.current.scrollTop = scrollTop
  }
  useImperativeHandle(ref, () => ({ setScrollTop }))

  useEffect(() => {
    if (editable && textareaRef.current) {
      const lines = value.split('\n')
      const offset = lines.slice(0, Math.max(0, targetLine - 1)).reduce((total, line) => total + line.length + 1, 0)
      textareaRef.current.focus()
      textareaRef.current.setSelectionRange(offset, offset)
      textareaRef.current.scrollTop = Math.max(0, (targetLine - 1) * 19.44 - textareaRef.current.clientHeight / 3)
      if (highlightRef.current) highlightRef.current.scrollTop = textareaRef.current.scrollTop
      onVerticalScroll?.(textareaRef.current.scrollTop)
    } else {
      targetRef.current?.scrollIntoView({ block: 'center' })
    }
  }, [editable, targetLine, onVerticalScroll])

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (!highlightRef.current) return
    highlightRef.current.scrollTop = event.currentTarget.scrollTop
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft
    onVerticalScroll?.(event.currentTarget.scrollTop)
  }

  return <div className={`code-preview git-source-editor gutter-${gutter}${editable ? ' is-editable' : ''}`} data-language={highlighted.language} data-target-line={targetLine}>
    <div className="code-preview-language">{highlighted.language}</div>
    <pre ref={highlightRef} className="code-preview-scroll git-source-highlight" aria-label={editable ? undefined : ariaLabel} aria-hidden={editable || undefined} tabIndex={editable ? -1 : 0} onScroll={event => { if (!editable) onVerticalScroll?.(event.currentTarget.scrollTop) }}><code>{highlighted.lines.map((line, index) => {
      const number = <span className="code-preview-line-number" aria-hidden="true">{index + 1}</span>
      const content = <span className="code-preview-line-content" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
      return <span className={`code-preview-line${targetLine === index + 1 ? ' is-target' : ''}`} data-line={index + 1} ref={targetLine === index + 1 ? targetRef : undefined} key={index}>{gutter === 'right' ? <>{content}{number}</> : <>{number}{content}</>}</span>
    })}</code></pre>
    {editable && <textarea ref={textareaRef} aria-label={ariaLabel} spellCheck={false} wrap="off" value={value} onChange={event => onChange?.(event.target.value)} onScroll={syncScroll} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); onSave?.() } }} />}
  </div>
})
