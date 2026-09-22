import type { EngineModel } from '../api/client'

export interface ProviderProtocolModels {
  protocol: string
  models: EngineModel[]
  fetchedAt: string | null
}

export interface ProviderModelSummary {
  groups: ProviderProtocolModels[]
  uniqueCount: number
  latestFetchedAt: string | null
}

export function summarizeProviderProtocolModels(
  entries: ProviderProtocolModels[],
): ProviderModelSummary {
  const uniqueIds = new Set<string>()
  let latestFetchedAt: string | null = null
  const groups = entries.map((entry) => {
    const modelsById = new Map<string, EngineModel>()
    entry.models.forEach((model) => {
      modelsById.set(model.id, model)
      uniqueIds.add(model.id)
    })
    if (entry.fetchedAt && (!latestFetchedAt || entry.fetchedAt > latestFetchedAt)) {
      latestFetchedAt = entry.fetchedAt
    }
    return { ...entry, models: [...modelsById.values()] }
  })

  return { groups, uniqueCount: uniqueIds.size, latestFetchedAt }
}
