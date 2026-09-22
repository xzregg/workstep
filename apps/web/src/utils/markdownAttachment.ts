type MarkdownAttachment = Pick<File, 'name' | 'type'>

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&')
}

export function formatMarkdownAttachment(
  file: MarkdownAttachment,
  url: string,
): string {
  const label = escapeMarkdownLabel(file.name || 'attachment')
  return file.type.startsWith('image/')
    ? `![${label}](${url})`
    : `[${label}](${url})`
}
