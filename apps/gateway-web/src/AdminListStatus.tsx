export function AdminListStatus({ loading, label }: { loading: boolean; label: string }) {
  return <div className="gateway-admin-list-status" role="status" aria-live="polite">
    {loading && <><span className="gateway-spinner" aria-hidden="true"/> {label}</>}
  </div>
}
