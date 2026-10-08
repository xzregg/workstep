import { lazy, Suspense } from 'react'
const Picker = lazy(() => import('./GatewayDateRangePicker').then(module => ({ default: module.GatewayDateRangePicker })))
export function GatewayDateRange(props: Parameters<typeof import('./GatewayDateRangePicker').GatewayDateRangePicker>[0]) {
 return <Suspense fallback={<div className="gateway-usage-date-field">正在加载日期选择器…</div>}><Picker {...props} /></Suspense>
}
