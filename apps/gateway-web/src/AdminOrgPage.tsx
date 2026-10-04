import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminIdentitySourcesPanel } from './AdminIdentitySourcesPanel'
import { AdminOrganizationDirectory } from './AdminOrganizationDirectory'

export function AdminOrgPage({ roles }: { roles: string[] }) {
  const [sourceId, setSourceId] = useState('')
  const [revision, setRevision] = useState(0)
  const superAdmin = roles.includes('super_admin')
  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>组织与同步</h2><Link to="/admin">返回管理概览</Link></div>
    {(superAdmin || roles.includes('org_admin')) && <AdminIdentitySourcesPanel onSourceChange={setSourceId}
      onReconciled={() => setRevision(value => value + 1)} />}
    <AdminOrganizationDirectory key={sourceId} sourceId={sourceId} revision={revision} superAdmin={superAdmin} />
  </section>
}
