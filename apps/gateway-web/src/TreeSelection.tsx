import { useEffect, useRef } from 'react'

export function subtreeIds(nodes: {id:string;parent_id?:string|null}[], id: string, seen = new Set<string>()): string[] {
 if (seen.has(id)) return []
 seen.add(id)
 return [id, ...nodes.filter(node=>node.parent_id===id).flatMap(node=>subtreeIds(nodes,node.id,seen))]
}
export function TreeCheckbox({ label, checked, partial, disabled, onChange }: {
 label: string; checked: boolean; partial: boolean; disabled: boolean; onChange: (checked: boolean) => void
}) {
 const ref = useRef<HTMLInputElement>(null)
 useEffect(() => { if (ref.current) ref.current.indeterminate = partial }, [partial])
 return <input ref={ref} type="checkbox" aria-label={label} aria-checked={partial ? 'mixed' : checked}
  checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
}
