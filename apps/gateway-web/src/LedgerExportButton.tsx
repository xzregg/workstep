type Column = { name: string; key: string }

export function ledgerCsv(columns: Column[], rows: object[]) {
  function cell(value: unknown) {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  return '\ufeff' + [columns.map(column => cell(column.name)).join(','), ...rows.map(row =>
    columns.map(column => cell((row as Record<string, unknown>)[column.key])).join(','))].join('\r\n')
}

export function LedgerExportButton({ columns, rows, filename, disabled = false }: {
  columns: Column[]; rows: object[]; filename: string; disabled?: boolean
}) {
  function download() {
    const url = URL.createObjectURL(new Blob([ledgerCsv(columns, rows)], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = filename; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return <button type="button" disabled={disabled || rows.length === 0} onClick={download}>
    导出本页 CSV
  </button>
}
