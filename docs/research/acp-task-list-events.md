# ACP 是否支持执行任务列表事件

> 调研日期：2026-08-11。仅使用 ACP、OpenAI Codex、Anthropic Claude Code / Agent SDK 的官方协议文档、官方 schema 与官方仓库。

## 结论

**支持。ACP v1 稳定协议已经有与截图中的执行任务列表直接对应的标准事件：Agent 通过 `session/update` 通知发送 `sessionUpdate: "plan"`。** 它不是名为 `todo` 或 `task_list` 的独立方法，而是 `session/update` 的一种更新类型。[ACP v1 Agent Plan](https://agentclientprotocol.com/protocol/v1/agent-plan)；[官方 `SessionUpdate` schema](https://docs.rs/agent-client-protocol-schema/latest/agent_client_protocol_schema/v1/enum.SessionUpdate.html)。

稳定 `plan` 是**整表快照**：Agent 每次更新都必须发送完整 `entries`，Client 必须整体替换现有计划。每项只有 `content`、`priority` 和 `status`，没有标准的任务 ID、依赖关系或百分比进度。[ACP v1 Agent Plan：Updating Plans](https://agentclientprotocol.com/protocol/v1/agent-plan#updating-plans)；[官方 `Plan` / `PlanEntry` 源码](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/agent-client-protocol-schema/src/v1/plan.rs)。

这与 Codex 的执行计划事件几乎同构；Claude Code 当前的 Task 系统则更像“按任务 ID 增量维护的任务库”，映射到 ACP stable 时需要先聚合为完整快照。

## ACP v1 稳定协议

当前稳定 ACP wire protocol 是 `1`；crate/schema 的发布版本不能代替初始化时协商的 `protocolVersion`。[ACP 官方仓库：Versioning](https://github.com/agentclientprotocol/agent-client-protocol#versioning)。

标准通知形态：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_123",
    "update": {
      "sessionUpdate": "plan",
      "entries": [
        {
          "content": "核对 ACP 任务列表协议",
          "priority": "high",
          "status": "completed"
        },
        {
          "content": "统一各引擎事件映射",
          "priority": "high",
          "status": "in_progress"
        },
        {
          "content": "运行回归测试",
          "priority": "medium",
          "status": "pending"
        }
      ]
    }
  }
}
```

字段与语义：

| 字段 | 类型 / 枚举 | 语义 |
|---|---|---|
| `method` | `session/update` | Agent → Client 的实时通知 |
| `params.sessionId` | string | 所属会话 |
| `update.sessionUpdate` | `plan` | 执行计划更新类型 |
| `entries[].content` | string | 人类可读的任务描述 |
| `entries[].priority` | `high` / `medium` / `low` | 相对优先级 |
| `entries[].status` | `pending` / `in_progress` / `completed` | 当前执行状态 |
| `_meta` | object，可选 | ACP 扩展元数据；`Plan` 和 `PlanEntry` 均可携带 |

ACP 明确允许计划在执行中增加、删除或修改条目，但仍然通过下一份完整列表表达；条目在 stable 模型中只能按数组位置跟踪，没有标准 `id`。[ACP v1 Agent Plan](https://agentclientprotocol.com/protocol/v1/agent-plan)；[ACP Message ID RFD 对 plan 身份的说明](https://agentclientprotocol.com/rfds/message-id#does-this-apply-to-other-session-updates-like-tool-calls-or-plan-updates)。

`session/update` 是所有 Agent 的基线能力之一，stable `plan` 没有额外的 capability 开关；Agent 创建计划时是 `SHOULD` 上报，不是 `MUST`，所以协议支持不等于每个 Agent 一定会产生任务列表。[ACP 初始化：Session Capabilities](https://agentclientprotocol.com/protocol/v1/initialization#session-capabilities)；[ACP v1 Agent Plan：Creating Plans](https://agentclientprotocol.com/protocol/v1/agent-plan#creating-plans)。

## unstable plan operations 扩展

最新官方 v1 schema 还包含 feature-gated 的 `unstable_plan_operations`，但源码明确标记为“not part of the spec yet”，不能当作稳定互操作要求。[官方 unstable plan schema 源码](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/agent-client-protocol-schema/src/v1/plan.rs)。

它增加：

- `sessionUpdate: "plan_update"`：更新一个带 `planId` 的命名计划。
- `sessionUpdate: "plan_removed"`：用 `planId` 删除一个计划。
- `plan_update.plan.type` 支持 `items`、`file`、`markdown`。
  - `items`：`{ type, planId, entries }`，其中 `entries` 仍是完整替换，不是单项 patch。
  - `file`：`{ type, planId, uri }`。
  - `markdown`：`{ type, planId, content }`。
- Client 需在 `initialize.params.clientCapabilities.plan` 中提供 `{}`，才表示能接收 `plan_update` 和 `plan_removed`；省略或 `null` 表示不支持。[官方 `ClientCapabilities.plan` schema](https://docs.rs/agent-client-protocol-schema/latest/agent_client_protocol_schema/v1/struct.ClientCapabilities.html)；[官方序列化测试](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/agent-client-protocol-schema/src/v1/client.rs)。

因此，若只需要截图中的一个执行 checklist，**优先使用 stable `plan`**。只有确实需要多个命名计划、外部 Markdown/文件计划或显式删除时，才值得在双方 capability 协商后试验 unstable 扩展。

## 与 Codex、Claude Code 对照

| 引擎 | 官方原语 | 更新模型 | 映射 ACP stable `plan` |
|---|---|---|---|
| Codex app-server | `turn/plan/updated`，载荷 `{ turnId, explanation?, plan }`；每项 `{ step, status }`，status 为 `pending` / `inProgress` / `completed` | 完整计划快照 | `step → content`；`inProgress → in_progress`；ACP 要求补 `priority` |
| Claude Code / Agent SDK | `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`；当前 SDK 要求消费者按 task ID 累积，而不是替换快照 | 按 task ID 创建、更新和查询 | Adapter 维护任务表，每次变化后投影为完整 `entries`；Claude 的额外字段保留在内部或 namespaced `_meta` |
| ACP v1 stable | `session/update` + `sessionUpdate: "plan"` | 完整列表替换 | 统一前端最合适的公共最小集合 |

Codex 事件和字段来自其官方 app-server 协议文档：[Codex app-server Turn events](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#turn-events)。Claude 的现行 Task 工具以及“按 task ID 累积”的迁移要求来自官方 Agent SDK changelog：[Claude Agent SDK TypeScript changelog 0.3.142](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03142)。

注意不要混淆 Claude 的 `task_started`、`task_progress`、`task_notification`：官方 changelog 将它们描述为后台 subagent 的运行/完成事件，它们不是截图这种计划 checklist；执行清单应以 `TaskCreate` / `TaskUpdate` / `TaskList` 为源。[Claude Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)。

## WorkStep 落地状态

调研完成后的实现已将该能力接入公共 seam：

- `InternalEvent.type = "plan"` 使用 ACP stable `entries` 快照。
- ACP/Hermes 映射 `schema.Plan`，Codex 映射 `turn/plan/updated`。
- Base 的 `normalize_event()` 聚合 Claude/Qoder 的 `TodoWrite` 与 `TaskCreate` / `TaskUpdate` / `TaskList`。
- Pydantic AI 提供面向模型的 `update_plan` 工具。
- Web 共享消息组件渲染并持续替换 checklist，历史与实时事件保留最新快照。

因此，截图所示列表现在可由所有 Adapter 通过同一 Base 事件进入共享 UI；是否实际产生计划仍取决于 Agent 是否发布原生 Plan 或调用任务工具。

## 对 WorkStep 的建议

1. Base 引擎增加统一的“计划快照”内部事件，语义直接采用 stable ACP `plan`：`entries[{content, priority, status}]`。
2. ACP/Hermes 直接透传 `sessionUpdate: "plan"`；Codex 映射 `turn/plan/updated`；Claude Code / SDK 聚合 Task 工具事件后再发布快照。
3. Pydantic AI 没有原生 ACP plan wire event 时，可提供一个受控的 `update_plan` 工具，让模型提交同一份结构，然后由 adapter 发布统一事件。
4. 前端按快照替换渲染，并只显示 `pending` / `in_progress` / `completed` 三态；它与截图的圆点 checklist 完全匹配。
5. 若内部确实需要 Claude task ID、依赖关系或 Codex explanation，可保留为 WorkStep 内部扩展字段；跨 ACP 边界时放入 namespaced `_meta`。ACP 允许 `_meta`，但自定义内容不具备通用互操作语义。[ACP Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility)。

## 最终判断

ACP 并非“只能传文本和工具调用”。**执行任务列表已经是 v1 stable 的一等 `SessionUpdate::Plan`。** WorkStep 不需要自造一套 todo 协议；应以 stable ACP `plan` 作为 Base 引擎公共语义，再把 Codex 的计划快照和 Claude 的 Task 工具状态归一化进来。unstable `plan_update` / `plan_removed` 可以保留为将来的增强层，不应成为首期依赖。
