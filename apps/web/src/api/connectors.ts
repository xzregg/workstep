import { request } from './transport'
export const CONNECTORS_CHANGED = 'workstep:connectors-changed'
function changed<T>(promise: Promise<T>): Promise<T> {
  return promise.then(value => { window.dispatchEvent(new CustomEvent(CONNECTORS_CHANGED)); return value })
}
export interface Connector {
  id: string; name: string; description: string; kind: 'mcp' | 'cli'; transport: 'stdio' | 'http' | 'sse'
  command: string; args: string[]; url: string; project_ids: string[]; enabled: boolean
  revision: number; has_credentials: boolean; header_names: string[]; env_names: string[]
}
export type ConnectorWrite = Partial<Connector> & { name: string; headers?: Record<string, string>; env?: Record<string, string> }
export interface AvailableConnector { id: string; name: string; description: string; kind: string; selected: boolean; available: boolean }
export interface DiscoveredConnector { id: string; name: string; source: string; kind: 'mcp' | 'cli'; transport: 'stdio' | 'http'; command: string; requires_credentials: boolean }
export interface ConnectorTool { name: string; description: string; input_schema: Record<string, unknown> }
export interface ConnectorDiagnostic {
  ok: boolean; status: 'connected' | 'cli_available' | 'auth_required' | 'forbidden' | 'timeout' | 'error' | 'tool_error'
  message: string; tool_count: number; tools: ConnectorTool[]; has_more?: boolean; auth_scheme?: string; result?: unknown
}
export interface ConnectorInvocation { tool_name: string; arguments: Record<string, unknown> }
export const connectorApi = {
  list: () => request<{ connectors: Connector[] }>('/connectors'),
  save: (value: ConnectorWrite) => changed(request<Connector>('/connectors', { method: 'POST', body: JSON.stringify(value) })),
  delete: (id: string) => changed(request<{ ok: boolean }>(`/connectors/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  test: (id: string) => request<{ ok: boolean; message: string; tool_count: number }>(`/connectors/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  diagnose: (definition: ConnectorWrite, invocation?: ConnectorInvocation, signal?: AbortSignal) => request<ConnectorDiagnostic>('/connectors/test', { method: 'POST', body: JSON.stringify({ definition, ...invocation }), signal }),
  scan: () => request<{ items: DiscoveredConnector[] }>('/connectors/scan', { method: 'POST' }),
  available: (projectId: string, sessionId: string, engineId: string) => request<{ connectors: AvailableConnector[] }>(`/connectors/available?${new URLSearchParams({ project_id: projectId, session_id: sessionId, engine_id: engineId })}`),
  select: (projectId: string, sessionId: string, connectorIds: string[]) => request<{ ok: boolean }>('/connectors/selection', { method: 'PUT', body: JSON.stringify({ project_id: projectId, session_id: sessionId, connector_ids: connectorIds }) }),
}
export const openConnectorSettings = () => window.dispatchEvent(new CustomEvent('workstep:open-connector-settings'))
