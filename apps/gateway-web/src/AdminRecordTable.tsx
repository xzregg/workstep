import { Children, isValidElement } from 'react'
import type { ReactNode } from 'react'

export function AdminRecordTable({ children, columns = ['信息', '操作'] }: { children: ReactNode; columns?: string[] }) {
 return <div className="gateway-admin-table-scroll" tabIndex={0} role="region" aria-label="数据表格，可左右滚动"><table className="gateway-admin-table"><thead><tr>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
}

export function AdminRecordRow({ children }: { children: ReactNode }) {
 const cells = Children.toArray(children)
 const action = (node: ReactNode) => isValidElement<{ className?: string }>(node) &&
   (node.type === 'button' || (node.props.className ?? '').includes('actions'))
 return <tr><td>{cells.filter(node => !action(node))}</td><td>{cells.filter(action)}</td></tr>
}
