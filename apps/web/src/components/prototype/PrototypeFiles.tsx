import { useState } from 'react'
import type { PrototypeState } from '../../api/prototype'
import { useI18n } from '../../i18n'

export default function PrototypeFiles({work, path, disabled, onSelect, onClose}: {
  work: PrototypeState; path: string; disabled: boolean; onSelect: (path:string)=>void; onClose: ()=>void
}) {
  const {t} = useI18n()
  const [pinned,setPinned] = useState(false)
  const render = (prefix: string) => {
    const names = [...new Set(work.files.filter(file=>file.startsWith(prefix)).map(file=>file.slice(prefix.length).split('/')[0]))].sort()
    return names.map(name=>{
      const full = prefix+name
      return work.files.includes(full) ? <button key={full} title={full} className={full===path?'prototype-tree-selected':''}
        disabled={disabled||!work.documents.some(doc=>doc.path===full)}
        onClick={()=>{onSelect(full);if(!pinned)onClose()}}>{name}</button> :
        <details key={full} open><summary>{name}</summary><div className="prototype-tree-children">{render(full+'/')}</div></details>
    })
  }
  return <div className="prototype-tree">
    <label><input type="checkbox" checked={pinned} onChange={event=>setPinned(event.target.checked)}/>{t('prototype.pin')}</label>
    {render('')}
  </div>
}
