# 全引擎对齐 ACP + 前端事件统一为 AG-UI

## 摘要
- 内部事件层**直接采用 ACP 词汇**：`InternalEvent` 重构为 ACP session update 对齐模型，Codex / Codex SDK / Claude Code / Claude Agent SDK / Pydantic AI / Qoder / OpenClaw / Hermes(ACP) 全部适配器按 ACP 字段形状产出事件；内部=ACP，对外=AG-UI。
- 新增唯一翻译层 `ACP 对齐内部事件 → AG-UI 标准事件`（`engines/core/agui.py`），WebSocket 实时推送与历史回放共用；前端所有 store 只消费 AG-UI。
- A2UI 载荷改为通过 AG-UI `CUSTOM` 事件推送并持久化，` ```a2ui ` fence 仅作旧消息回退。
- 传输仍走 `/ws`；不引入 AG-UI capabilities/interrupt 完整栈；`events_json` 内部结构保持 dict 序列化，但词汇升级。
- `/ws` 支持按连接订阅过滤：客户端发送 `{"type":"subscribe","task_ids":[...],"status_only_task_ids":[...],"session_ids":[...],"channels":[...]}` 后，服务端只推送命中事件（未订阅时保持全量广播，向后兼容）；`EventBus` 按订阅谓词在入队前过滤。

## 后端改动（`apps/daemon`）

**内部事件模型 ACP 化（`engines/core/events.py` + 全部引擎适配器）**
- 引擎内容事件统一为 ACP session update 词汇：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`（`tool_call_id/title/kind/raw_input`）、`tool_call_update`（`status: pending|in_progress|completed|failed`，增量 `raw_input`、结果 `raw_output`）、`plan`、`plan_update`、`plan_removed`、`usage_update`（`used/size/cost{amount,currency}`）、`user_message_chunk`、`session_info_update`、`available_commands_update`、`config_option_update`、`current_mode_update`、`mcp_message`、`elicitation_completed`。
- 每类引擎映射：Codex CLI JSONL 的 `text_delta/thinking_delta/tool_use/tool_input_delta/tool_result/plan/usage` → 对应 ACP 类型；Claude Code / Claude Agent SDK 的 `AskUserQuestion`→elicitation、plan hook→`plan/plan_update`、工具流→`tool_call/tool_call_update`；Pydantic AI 表单/权限→elicitation/permission、工具→`tool_call*`、用量→`usage_update`；Qoder / OpenClaw 映射各自等价物；Hermes 由 `AcpEngineBase` 直接产出并补全缺失的 7 种。
- **能力缺口原则**：有原生等价就映射，没有原生来源的事件不发，各引擎声明 `acp_events: set[str]` capability 元数据（用于文档与测试断言），不合成默认值。
- 保留非 ACP 编排事件（`status/session_started/live_message/engine_state/subagent/compacted/error` 与新增 `a2ui`、`acp_raw` 透传），与 ACP 词汇共存于 `InternalEvent`；`compacted` 来源除 Codex / Claude / Qoder 外，PydanticAI 经 pydantic-ai-harness（`TieredCompaction` + receipts 排空）也可产出。
- 旧 `events_json` 兼容：`map_legacy_event` 提供旧词汇→新词汇映射（`text_delta→agent_message_chunk` 等），老消息 replay 不破。

**ACP 补齐（`engines/core/acp_base.py`）**
- `_map_notification` 补全 13 种 session update 全量映射（含 `ToolCallProgress` 中间态、`PlanUpdate/PlanRemoved`、`SessionInfoUpdate`、`AvailableCommandsUpdate`、`ConfigOptionUpdate`、`CurrentModeUpdate`、`UserMessageChunk`、`MessageMcpNotification`），未知 update 透传 `acp_raw` 不再静默丢弃。
- elicitation 能力声明补 `url`/`url_session` 模式（非 form 保留 decline 兜底）；`fs/*`、MCP servers 等 client→agent 方法维持现状。

**AG-UI 翻译层（新增 `engines/core/agui.py`）**
- `to_agui_events(event, ctx) -> list[AGUIEvent]`，ctx 携带 `task_id/step_key/message_id/channel/session_id/engine/model/event_sequence/timestamp`（AG-UI passthrough 扩展字段）。
- 映射约定：`agent_message_chunk`→`TEXT_MESSAGE_CHUNK(role=assistant)`、`user_message_chunk`/`live_message`→`TEXT_MESSAGE_CHUNK(role=user)`；`agent_thought_chunk`→`REASONING_MESSAGE_CHUNK`；`tool_call`→`TOOL_CALL_START`+`TOOL_CALL_ARGS`、`tool_call_update`→`TOOL_CALL_CHUNK`/`TOOL_CALL_RESULT`；`status`→`RUN_STARTED/RUN_FINISHED/RUN_ERROR`（`threadId=task_id`、`runId=task_id::step_key`，助手渠道用 `session_id`）；`message_started/message_snapshot/message_completed`→`TEXT_MESSAGE_START/CONTENT/END`；其余（plan 系列、interaction、usage、session_info 等、`a2ui`、编排事件）→ `CUSTOM{name:"workstep.*"}` / `CUSTOM{name:"a2ui.surface"}`。
- `task_runner.py` / `agent_assistants/coordinator.py` / `agent_assistants/base.py` publish 出口与 `services/history.py` 回放读路径统一调用该翻译层；`share.py` 脱敏名单改为按 `CUSTOM name`（`workstep.interaction_*`、`workstep.engine_state`）。

**WebSocket 订阅过滤（`main.py` + `streaming/bus.py`）**
- `EventBus.subscribe(predicate)` / `set_filter(queue, predicate)`：谓词拒绝的事件不入队，慢客户端不再为无关事件付费；`/ws/share` 的脱敏过滤也改为入队前谓词。
- `WsSubscription` 四维过滤：`task_ids`（任务全量流，任务详情页）、`status_only_task_ids`（仅状态类事件：`RUN_*`、`workstep.status/step_retrying/step_rework/run_recovered`，任务列表页）、`session_ids`（助手会话流，`flow_gen` / `task_create` / `session_chat`）、`channels`（按 channel）。
- 未收到 `subscribe` 消息前连接保持全量模式（向后兼容）；`subscribe` 不含任何订阅键时重置为全量。

**A2UI 事件化（`agent_assistants/workflow_gen.py`）**
- `_ensure_a2ui_choice_ui` 改为产出 `a2ui` 事件（`createSurface`+`updateComponents`），reply 只留文本摘要；模型自带 fence 保留并继续走 fence 渲染。

## 前端改动（`apps/web`）

- 新增 `@ag-ui/core`（仅类型）+ `src/utils/agui.ts`：`AGUIEvent` / `EventLike` 宽松类型、`CUSTOM` 常量表、`isCustom(name)`、载荷提取（`customValue/messageId/toolCallId/toolName/toolArgs/toolOutput`）、消息累加（`appendMessageContent`）、`TOOL_CALL_*`/`REASONING_*`/`RUN_*` 识别。
- `useWebSocket.ts` 按扩展字段 `channel` + `session_id` 分流；`taskStore` / `assistantStore`（含 workflowGen / taskDraft / chatSession 配置实例）`handleWsEvent` 改为消费 AG-UI；`messageTimeline` / `interaction` / `plan` / `taskDetailChat` 的工具、推理、plan、interaction、subagent 事件按 AG-UI 匹配（CUSTOM 兼容旧字段）。
- `useWebSocket.ts` 连接后主动订阅：打开的任务详情订阅全量流（`TaskList` 经 `setDetailTaskIds` 同步），当前项目所有任务订阅状态事件，活跃助手会话按 `session_id` 订阅；订阅集合只在用户动作（开详情、建会话、刷新列表）时变化并即时重发，避免收到无关任务的完整流。
- `assistantStore` 新增 `AssistantSessionState.a2uiMessages`，`CUSTOM a2ui.surface` 按 `messageId` 追加；`hydrateSession` 从历史事件重建 A2UI；`A2uiMessage` 优先渲染 store 载荷，fence 解析仅作旧消息回退。
- `MessageMetaBar` / `MessageResponseFooter` / `ProcessTrace` / `ChatMessageBubble` / `AssistantChatPanel` / `AiFlowChat` / `SharedTaskView` 同步适配 AG-UI 字段。
- 新文案先写 `zh-CN.ts`，键集合保持一致。

## 接口与格式
- 助手文字的阶段信息是跨引擎扩展：内部 `agent_message_chunk.data` 与外部 `TEXT_MESSAGE_CHUNK` 保留可选 `phase: commentary | final_answer`、`source_item_id`。`commentary` 是过程播报，不是模型推理；任务、审核、助手的正文和结构化解析不累加它，完整日志保留它，摘要单独记录 `commentary_characters`。前端在 `ProcessTrace` 中与思考、工具按顺序展示，运行时展开、结束后折叠；正文和复制回复只取非 commentary 文字。
- 原生阶段来源：Codex SDK 按消息项 ID 关联 started/delta/completed，按项去重；Codex CLI 保留 item 的 phase；Pydantic AI 保留 TextPart 的 `provider_details.phase` 并关联同 part 的后续增量；缺少 phase 时先缓存文字，SDK 发起工具调用则将该轮文字归为 commentary，收到被接受的 agent_run_result 才归为 final_answer，中断时未完成文字保留为过程。该路径的无标记文字需等待 SDK 确定分类后展示。其他引擎继续复用同一消费链路；没有原生阶段字段时保持原行为，不按措辞或段落位置猜测，旧历史不重写。
- 内部事件示例：`{"type":"agent_message_chunk","data":{"content":{"text":"..."}},"timestamp":...}`；`{"type":"tool_call_update","data":{"tool_call_id":"...","status":"completed","raw_output":"..."}}`。
- AG-UI 负载示例：`{"type":"TEXT_MESSAGE_CHUNK","messageId":"...","role":"assistant","delta":"...","channel":"execution","task_id":"...","step_key":"...","sequence":n,"timestamp":...}`；A2UI：`{"type":"CUSTOM","name":"a2ui.surface","value":{"version":"v0.9.1","createSurface":{...}},"channel":"flow_gen","messageId":"...","session_id":"..."}`。
- 历史接口 `events` 数组返回 AG-UI 同格式；DB 只存新词汇内部事件，旧数据读时经兼容映射再翻译。

## 测试计划
- 后端：`test_acp_full_events.py`（13 种 session update 映射 + elicitation 模式 + `MessageMcpNotification` + 未知透传）；`test_agui.py`（全映射表、扩展字段、历史回放翻译、旧词汇兼容映射）；各引擎 capability 断言（`acp_events` 集合与抽查映射）；`workflow_gen`/`share` 测试更新；`uv run pytest` 全量回归。
- 前端：`agui.test.ts`（AG-UI 工具函数 + assistantStore/taskStore 消费 AG-UI）、既有 store 测试更新为 AG-UI 事件形状、`npm run build`（tsc + vite）通过、`node --test` 全量回归。

## 假设
- "所有引擎对齐 ACP"指**事件语义与字段形状**对齐，非要求引擎原生跑 ACP 子进程；非 ACP 引擎继续用各自协议，仅统一产出 ACP 词汇的内部事件。
- 引擎无原生来源的事件不发（capability 元数据声明），不合成默认值。
- AG-UI 用当前规范词汇（`REASONING_*`，废弃 `THINKING_*` 不用）；一次发布直接切换，不做新旧双格式并存。
- 前端测试用 Node 内置 `node:test`（`node --test`，需 Node ≥ 23.6 支持 TS 类型擦除；本机用 bundled Node v24）。

### Pydantic 子代理实时进度

Pydantic harness 的 `SubAgents.shared_capabilities` 注入运行观察器，以子代理
`run_id` 区分同名调用。`wrap_run` 发布一次开始及完成／失败／停止状态；
`wrap_run_event_stream` 转发各模型和工具节点的文字、思考与工具事件，节点流结束不代表子代理结束。
内部 `subagent.data.event` 保存原始子事件，公共 AG-UI 翻译层将其转换为
`workstep.subagent.value.events`。子事件仅保存在子代理时间线，不进入主代理正文。
共享展示组件按顺序展示这些事件，运行中展开，结束后折叠，并支持手动展开及日志回放。

### 其他引擎的子代理来源

Claude Code、Claude Agent SDK、Qoder SDK 根据 `parent_tool_use_id` 隔离子消息及去重状态；
前端将父工具 ID 与生命周期消息中的 task ID 关联到同一子代理记录。
DeepSeek Harness 将已登记的子会话 `session.event` 包进同一嵌套事件格式。
Codex CLI / SDK 将 `agents_states` 原生协作快照展示为子代理状态和摘要，工具调用结束不等于子代理结束。
这些快照不承诺包含完整子会话逐字流。Hermes 沿用 ACP 原生事件；OpenClaw 的一次性信封没有独立子代理流来源，未合成此能力。
