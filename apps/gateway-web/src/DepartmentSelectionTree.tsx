import { useState } from 'react'
import type { ReactNode } from 'react'
import { subtreeIds, TreeCheckbox } from './TreeSelection'

export type Department = { external_id: string; display_name: string; parent_external_id?: string | null }
export function DepartmentSelectionTree({ departments, selected, search, disabled, onChange }: {
 departments: Department[]; selected: string[]; search: string; disabled: boolean; onChange: (ids:string[])=>void
}) {
 const [collapsed,setCollapsed] = useState<Set<string>>(new Set())
 const nodes=departments.map(node=>({id:node.external_id,parent_id:node.parent_external_id}))
 const ids=new Set(nodes.map(node=>node.id))
 const choices=new Set(selected)
 const query=search.trim().toLowerCase()
 const matches=(node:Department)=>node.display_name.toLowerCase().includes(query)
 function visible(node:Department,seen=new Set<string>()):boolean {
  if(seen.has(node.external_id))return false
  seen.add(node.external_id)
  return !query || matches(node) || departments.some(child=>child.parent_external_id===node.external_id && visible(child,new Set(seen)))
 }
 function toggle(id:string,value:boolean) {
  const next=new Set(selected)
  for(const child of subtreeIds(nodes,id)){if(value)next.add(child);else next.delete(child)}
  // Ancestors retain their explicit selection: selecting a leaf must not import
  // the parent's direct members. A cancelled descendant makes ancestors partial.
  if(!value){let parent=nodes.find(node=>node.id===id)?.parent_id;const seen=new Set<string>()
   while(parent && !seen.has(parent)){seen.add(parent);next.delete(parent);parent=nodes.find(node=>node.id===parent)?.parent_id}}
  onChange([...next])
 }
 function branch(items:Department[],seen=new Set<string>(),parentMatches=false):ReactNode {
  return items.filter(node=>!seen.has(node.external_id) && (parentMatches || visible(node))).map(node=>{
   const next=new Set(seen).add(node.external_id)
   const children=departments.filter(child=>child.parent_external_id===node.external_id && !next.has(child.external_id))
   const open=!!query || !collapsed.has(node.external_id)
   const subtree=subtreeIds(nodes,node.external_id)
   const checked=subtree.every(id=>choices.has(id))
   const partial=!checked && subtree.some(id=>choices.has(id))
   return <li role="treeitem" aria-checked={partial?'mixed':checked} aria-expanded={children.length?open:undefined} key={node.external_id}>
    <div className="gateway-sync-tree-row">
     {children.length?<button type="button" className="gateway-sync-tree-toggle" aria-label={`${open?'收起':'展开'}${node.display_name}`} aria-expanded={open}
      onClick={()=>setCollapsed(current=>{const updated=new Set(current);if(open)updated.add(node.external_id);else updated.delete(node.external_id);return updated})}>{open?'▾':'▸'}</button>:<span className="gateway-sync-tree-spacer"/>}
     <label><TreeCheckbox label={node.display_name} checked={checked} partial={partial} disabled={disabled} onChange={value=>toggle(node.external_id,value)}/><strong>{node.display_name}</strong></label>
    </div>
    {!!children.length && open && <ul role="group">{branch(children,next,parentMatches || (!!query && matches(node)))}</ul>}
   </li>
  })
 }
 return <ul className="gateway-sync-tree" role="tree" aria-label="同步组织">{branch(departments.filter(node=>!node.parent_external_id || !ids.has(node.parent_external_id)))}</ul>
}
