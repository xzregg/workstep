import type { PrototypeSelection } from '../../api/prototype'

/** Keep the selected target visible in the shared message bubble and history. */
export function prototypeMessage(path: string, content: string, selection: PrototypeSelection | null) {
  if (!selection) return content
  const code = (value: string) => '`' + value.replaceAll('`', '').replace(/[\r\n]/g, ' ') + '`'
  const selector = selection.tag + (selection.id ? `#${selection.id}` : '')
    + (selection.classes ? '.' + selection.classes.trim().split(/\s+/).join('.') : '')
  const location = selection.source_location?.line ? `${path}:${selection.source_location.line}` : path
  const text = selection.text.replace(/[\r\n]/g, ' ').slice(0, 120)
  return `> ${code(location)}  \n> ${code(selector)} ${code(selection.node_id || 'dynamic')}  \n> ${text}\n\n${content}`
}
