import type {MouseEventHandler,ReactNode} from 'react'
import type {DiffHunk,DiffLine} from './gitDiff'
import './git.css'

export function GitDiffCodeCell({line,side,children,onContextMenu,gutterRight=false}:{
  line:DiffLine|undefined;side:'before'|'after';children?:ReactNode;onContextMenu?:MouseEventHandler<HTMLDivElement>;gutterRight?:boolean
}){
  const number=<span className="git-line-number">{line?.number}</span>
  const source=<code>{line?.text??' '}</code>
  return <div className={`git-code-cell ${line?.changed?side==='before'?'removed':'added':''}`} onContextMenu={onContextMenu}>
    {children??(gutterRight?<>{source}{number}</>:<>{number}{source}</>)}
  </div>
}

/** Shared read-only hunk presentation; Git can supply its editing/blame slots. */
export default function GitDiffHunks({hunks,split=false,leftWidth=50,renderCell,renderSplitHunk,idPrefix='git-hunk'}:{
  hunks:DiffHunk[];split?:boolean;leftWidth?:number;idPrefix?:string;
  renderCell?:(line:DiffLine|undefined,side:'before'|'after',sourceLine?:number)=>ReactNode;
  renderSplitHunk?:(hunk:DiffHunk,index:number)=>ReactNode
}){
  const cell:NonNullable<typeof renderCell>=renderCell??((line,side)=><GitDiffCodeCell line={line} side={side} gutterRight={split&&side==='before'}/>)
  return <>{hunks.map((hunk,index)=><section key={index} id={`${idPrefix}-${index}`} data-hunk-index={index}>
    {hunk.header&&<h4>{hunk.header}</h4>}
    {split?(renderSplitHunk?renderSplitHunk(hunk,index):<div className="git-hunk-panes" style={{gridTemplateColumns:`${leftWidth}% minmax(0,1fr)`}}>
      <div className="git-code-pane" data-diff-side="before">{hunk.rows.map((row,rowIndex)=><div key={rowIndex}>{cell(row.before,'before')}</div>)}</div>
      <div className="git-code-pane" data-diff-side="after">{hunk.rows.map((row,rowIndex)=><div key={rowIndex}>{cell(row.after,'after',row.before?.number)}</div>)}</div>
    </div>):hunk.rows.map((row,rowIndex)=><div key={rowIndex}>
      {row.before?.changed&&cell(row.before,'before')}{row.after&&cell(row.after,'after',row.before?.number)}
    </div>)}
  </section>)}</>
}
