import type { PrototypeState } from '../../api/prototype'
import GitDiffFileTree from '../git/GitDiffFileTree'

export default function PrototypeFiles({work, path, disabled, onSelect, onClose}: {
  work: PrototypeState; path: string; disabled: boolean; onSelect: (path:string)=>void; onClose: ()=>void
}) {
  const directory = path.slice(0,path.lastIndexOf('/')+1)
  const files = work.files.filter(file=>file.startsWith(directory)).map(file=>file.slice(directory.length))
  const documents = new Set(work.documents.map(doc=>doc.path))
  return <div className="prototype-tree">
    <GitDiffFileTree key={directory} files={files} path={path.slice(directory.length)} disabled={disabled}
      isFileDisabled={file=>!documents.has(directory+file)}
      onSelect={file=>{onSelect(directory+file);onClose()}}/>
  </div>
}
