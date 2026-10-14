export interface SystemProcessMetrics {
  cpu_percent: number | null
  memory_rss: number | null
  threads: number | null
  descriptors: number | null
}
export interface SystemProcess extends SystemProcessMetrics {
  pid: number
  name: string | null
  uptime_seconds: number | null
}
export interface SystemTrendPoint {
  sampled_at: string
  host_cpu_percent: number | null
  host_memory_used: number | null
  total_cpu_percent: number | null
  total_memory_rss: number | null
  total_descriptors: number | null
  daemon_descriptors: number | null
}
export interface SystemStatisticsReport {
  status: 'warming' | 'ok' | 'error'
  interval_seconds: number
  retention_seconds: number
  sample_age_seconds: number | null
  collection_duration_ms: number | null
  sample: {
    sampled_at: string
    platform: string
    descriptor_kind: 'fds' | 'handles'
    partial: boolean
    host: {
      cpu_count: number
      cpu_percent: number | null
      memory_total: number | null
      memory_used: number | null
      memory_available: number | null
      memory_percent: number | null
      swap_total: number | null
      swap_used: number | null
      disk_total: number | null
      disk_used: number | null
      disk_free: number | null
      disk_percent: number | null
      network_recv_per_second: number | null
      network_sent_per_second: number | null
    }
    daemon: SystemProcess & { descriptor_limit: number | null }
    children: SystemProcess[]
    children_summary: SystemProcessMetrics & { process_count: number | null }
    total: SystemProcessMetrics
  } | null
  history: SystemTrendPoint[]
}
