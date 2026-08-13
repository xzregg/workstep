# 全引擎对齐 ACP + 前端事件统一为 AG-UI

## 摘要
- 内部事件层**直接采用 ACP 词汇**：`InternalEvent` 重构为 ACP session update 对齐模型，Codex / Codex SDK / Claude Code / Claude Agent SDK / Pydantic AI / Qoder / OpenClaw / Hermes(ACP) 全部适配器按 ACP 字段形状产出事件；内部=ACP，对外=AG-UI。
- 新增唯一翻译层 `ACP 对齐内部事件 → AG-UI 标准事件`（`engines/core/agui.py`），WebSocket 实时推送与历史回放共用；前端所有 store 只消费 AG-UI。
- A2UI 载荷改为通过 AG-UI `CUSTOM` 事件推送并持久化，` ```a2ui ` fence 仅作旧消息回退。
- 传输仍走 `/ws`；不引入 AG-UI capabilities/interrupt 完整栈；`events_json` 内部结构保持 dict 序列化，但词汇升级。

## 后端改动（`apps/daemon`）

**内部事件模型 ACP 化（`engines/core/events.py` + 全部引擎适配器）**
- 引擎内容事件统一为 ACP session update 词汇：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`（`tool_call_id/title/kind/raw_input`）、`tool_call_update`（`status: pending|in_progress|completed|failed`，增量 `raw_input`、结果 `raw_output`）、`plan`、`plan_update`、`plan_removed`、`usage_update`（`used/size/cost{amount,currency}`）、`user_message_chunk`、`session_info_update`、`available_commands_update`、`config_option_update`、`current_mode_update`、`mcp_message`、`elicitation_completed`。
- 每类引擎映射：Codex CLI JSONL 的 `text_delta/thinking_delta/tool_use/tool_input_delta/tool_result/plan/usage` → 对应 ACP 类型；Claude Code / Claude Agent SDK 的 `AskUserQuestion`→elicitation、plan hook→`plan/plan_update`、工具流→`tool_call/tool_call_update`；Pydantic AI 表单/权限→elicitation/permission、工具→`tool_call*`、用量→`usage_update`；Qoder / OpenClaw 映射各自等价物；Hermes 由 `AcpEngineBase` 直接产出并补全缺失的 7 种。
- **能力缺口原则**：有原生等价就映射，没有原生来源的事件不发，各引擎声明 `acp_events: set[str]` capability 元数据（用于文档与测试断言），不合成默认值。
- 保留非 ACP 编排事件（`status/session_started/live_message/engine_state/subagent/compacted/error` 与新增 `a2ui`、`acp_raw` 透传），与 ACP 词汇共存于 `InternalEvent`。
- 旧 `events_json` 兼容：`map_legacy_event` 提供旧词汇→新词汇映射（`text_delta→agent_message_chunk` 等），老消息 replay 不破。

**ACP 补齐（`engines/core/acp_base.py`）**
- `_map_notification` 补全 13 种 session update 全量映射（含 `ToolCallProgress` 中间态、`PlanUpdate/PlanRemoved`、`SessionInfoUpdate`、`AvailableCommandsUpdate`、`ConfigOptionUpdate`、`CurrentModeUpdate`、`UserMessageChunk`、`MessageMcpNotification`），未知 update 透传 `acp_raw` 不再静默丢弃。
- elicitation 能力声明补 `url`/`url_session` 模式（非 form 保留 decline 兜底）；`fs/*`、MCP servers 等 client→agent 方法维持现状。

**AG-UI 翻译层（新增 `engines/core/agui.py`）**
- `to_agui_events(event, ctx) -> list[AGUIEvent]`，ctx 携带 `task_id/step_key/message_id/channel/session_id/engine/model/event_sequence/timestamp`（AG-UI passthrough 扩展字段）。
- 映射约定：`agent_message_chunk`→`TEXT_MESSAGE_CHUNK(role=assistant)`、`user_message_chunk`/`live_message`→`TEXT_MESSAGE_CHUNK(role=user)`；`agent_thought_chunk`→`REASONING_MESSAGE_CHUNK`；`tool_call`→`TOOL_CALL_START`+`TOOL_CALL_ARGS`、`tool_call_update`→`TOOL_CALL_CHUNK`/`TOOL_CALL_RESULT`；`status`→`RUN_STARTED/RUN_FINISHED/RUN_ERROR`（`threadId=task_id`、`runId=task_id::step_key`，助手渠道用 `session_id`）；`message_started/message_snapshot/message_completed`→`TEXT_MESSAGE_START/CONTENT/END`；其余（plan 系列、interaction、usage、session_info 等、`a2ui`、编排事件）→ `CUSTOM{name:"workstep.*"}` / `CUSTOM{name:"a2ui.surface"}`。
- `task_runner.py` / `agent_assistants/coordinator.py` / `agent_assistants/base.py` publish 出口与 `services/history.py` 回放读路径统一调用该翻译层；`share.py` 脱敏名单改为按 `CUSTOM name`（`workstep.interaction_*`、`workstep.engine_state`）。

**A2UI 事件化（`agent_assistants/workflow_gen.py`）**
- `_ensure_a2ui_choice_ui` 改为产出 `a2ui` 事件（`createSurface`+`updateComponents`），reply 只留文本摘要；模型自带 fence 保留并继续走 fence 渲染。

## 前端改动（`apps/web`）

- 新增 `@ag-ui/core`（仅类型）+ `src/utils/agui.ts`：`AGUIEvent` / `EventLike` 宽松类型、`CUSTOM` 常量表、`isCustom(name)`、载荷提取（`customValue/messageId/toolCallId/toolName/toolArgs/toolOutput`）、消息累加（`appendMessageContent`）、`TOOL_CALL_*`/`REASONING_*`/`RUN_*` 识别。
- `useWebSocket.ts` 按扩展字段 `channel` + `session_id` 分流；`taskStore` / `assistantStore`（含 workflowGen / taskDraft / chatSession 配置实例）`handleWsEvent` 改为消费 AG-UI；`messageTimeline` / `interaction` / `plan` / `taskDetailChat` 的工具、推理、plan、interaction、subagent 事件按 AG-UI 匹配（CUSTOM 兼容旧字段）。
- `assistantStore` 新增 `AssistantSessionState.a2uiMessages`，`CUSTOM a2ui.surface` 按 `messageId` 追加；`hydrateSession` 从历史事件重建 A2UI；`A2uiMessage` 优先渲染 store 载荷，fence 解析仅作旧消息回退。
- `MessageMetaBar` / `MessageResponseFooter` / `ProcessTrace` / `ChatMessageBubble` / `AssistantChatPanel` / `AiFlowChat` / `SharedTaskView` 同步适配 AG-UI 字段。
- 新文案先写 `zh-CN.ts`，键集合保持一致。

## 接口与格式
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
