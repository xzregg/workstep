/**
 * engineAvailabilityStore — 引擎「能否选中」的唯一实时来源。
 *
 * 各个引擎下拉都按 installed / configured / verified / supports_coordinator 决定选项是否禁用
 * （见 `EngineSelect.isEngineSelectable`）。这份数据原本是每个使用方在挂载时各自拉的一份快照，
 * 而设置页是渲染在 Layout 里的浮层 —— 打开它不会卸载底下的页面，所以在设置里安装引擎、测试
 * 通过、保存配置、改二进制路径之后，聊天框仍然拿着旧快照、选项一直禁用，只能刷新整页。
 *
 * 提供两种消费方式，按使用方手里的数据形态选：
 * - `useCoordinatorEngines()`：助手 / 协调聊天下拉直接用这份摘要。它可由 `assistantApi.list()`
 *   或 `taskApi.coordinatorConfig()` 本来就拉到的结果播种，所以接入不新增任何请求；
 * - `useEngineRevision()`：阶段引擎下拉（`TaskStageConfigController`、画布节点）用的 `EngineInfo`
 *   还带 `config.stage_fields` / `default_model` 这些摘要里没有的字段，且来自各自的任务级接口
 *   —— 它们不换数据源，只把这个版本号并入已有加载 effect 的依赖去重新拉取。
 *
 * 写入方是设置页（它本来就维护整份引擎目录）和各聊天入口的首次加载播种。后端每个引擎写操作都会
 * `refresh_registry()` 失效扫描缓存，所以只要重新拉取就一定拿得到最新状态。
 */

import { create } from 'zustand'
import type { CoordinatorEngineSummary, EngineInfo } from '../api/client'

/**
 * 收敛成助手 / 协调聊天下拉用的摘要。过滤条件镜像后端两处同源实现：
 * `apps/daemon/api/assistant.py:_available_engines()` 与
 * `agent_assistants/coordinator.py` 的 `get_config()`：已安装且支持协调模式，内置 Pydantic AI 例外。
 */
export function toCoordinatorEngines(
  engines: readonly (EngineInfo | CoordinatorEngineSummary)[],
): CoordinatorEngineSummary[] {
  return engines
    .filter((engine) => (
      engine.installed
      && (engine.supports_coordinator || engine.id === 'pydantic_ai')
    ))
    .map((engine) => ({
      id: engine.id,
      mode: engine.mode,
      installed: engine.installed,
      configured: engine.configured,
      verified: engine.verified,
      built_in: engine.built_in,
      supports_coordinator: engine.supports_coordinator,
      supports_session_fork: engine.supports_session_fork,
      supports_provider: engine.supports_provider,
      provider_protocols: engine.provider_protocols,
    }))
}

/** 只比较决定「能否选中」的字段，无关字段变化不触发重渲染与重拉。 */
function availabilityKey(engines: readonly Partial<CoordinatorEngineSummary>[]) {
  return engines.map((engine) => [
    engine.id,
    engine.installed,
    engine.configured,
    engine.verified,
    engine.supports_coordinator,
    engine.built_in,
  ].join(':')).join('|')
}

interface EngineAvailabilityState {
  /** 助手 / 协调聊天引擎下拉共用的可用性摘要。 */
  engines: CoordinatorEngineSummary[]
  /** 可用性每次真实变化 +1；阶段引擎下拉用它作为重新拉取的触发信号。 */
  revision: number
  /** 用一份引擎目录覆盖摘要；内容未变时保持引用不变，避免无谓重渲染。 */
  publish: (engines: readonly (EngineInfo | CoordinatorEngineSummary)[]) => void
}

export const useEngineAvailabilityStore = create<EngineAvailabilityState>((set, get) => ({
  engines: [],
  revision: 0,
  publish: (source) => {
    const engines = toCoordinatorEngines(source)
    if (availabilityKey(engines) === availabilityKey(get().engines)) return
    set({ engines, revision: get().revision + 1 })
  },
}))

/** 订阅助手 / 协调聊天引擎下拉共用的可用性摘要。 */
export function useCoordinatorEngines() {
  return useEngineAvailabilityStore((state) => state.engines)
}

/** 订阅引擎可用性版本号：阶段引擎下拉用它触发重新拉取。 */
export function useEngineRevision() {
  return useEngineAvailabilityStore((state) => state.revision)
}

/** 用已经拉到的引擎目录同步可用性（设置页写操作后、聊天入口加载后）。 */
export function publishEngineCatalog(
  engines: readonly (EngineInfo | CoordinatorEngineSummary)[],
) {
  useEngineAvailabilityStore.getState().publish(engines)
}

/** 测试专用：复位共享可用性。 */
export function resetEngineAvailabilityStoreForTests() {
  useEngineAvailabilityStore.setState({ engines: [], revision: 0 })
}
