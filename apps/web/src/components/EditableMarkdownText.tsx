import { useContext, useLayoutEffect, useRef } from 'react'
import { MarkdownTextEditContext } from '../contexts/MarkdownTextEditContext'

export default function EditableMarkdownText({ node }: { node?: { properties?: Record<string, unknown> } }) {
  const editor = useContext(MarkdownTextEditContext)
  const ref = useRef<HTMLSpanElement>(null)
  const text = String(node?.properties?.text ?? '')
  const accepted = useRef(text)
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = text
    accepted.current = text
  }, [text])
  const update = () => {
    const element = ref.current
    if (!element || !editor) return
    const next = element.innerText ?? element.textContent ?? ''
    if (next === accepted.current) return
    if (editor.replace(Number(node?.properties?.sourceStart), Number(node?.properties?.sourceEnd), next)) accepted.current = next
    else element.textContent = accepted.current
  }
  return <span ref={ref} className="markdown-editable-text" contentEditable={Boolean(editor)}
    suppressContentEditableWarning role={editor ? 'textbox' : undefined} aria-label={editor?.label}
    aria-multiline={editor ? true : undefined}
    onInput={update} onCompositionEnd={update}
    onPaste={event => {
      // Paste text only; the shared editor handles attachment files above this node.
      const text = event.clipboardData.getData('text/plain')
      if (event.defaultPrevented || !text || !editor) return
      event.preventDefault()
      const selection = window.getSelection()
      if (!selection?.rangeCount) return
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const inserted = document.createTextNode(text)
      range.insertNode(inserted)
      range.setStartAfter(inserted)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      update()
    }} />
}
