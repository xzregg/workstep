# 按功能查找代码

修改功能时先找所属模块，再沿前端页面或组件 → API → 服务 → 数据模型追踪。行为测试放在实际拥有该行为的模块附近；不要把页面、`src/api/client.ts` 或通用服务文件作为新功能的默认落点。

| 功能 | Web 入口 | Daemon 入口 | 深入阅读 |
|---|---|---|---|
| 任务列表、详情、执行 | `src/pages/TaskList.tsx`、`TaskDetail.tsx`，`src/components/TaskDetailView.tsx`；详情内部见下表，API 在 `src/api/task.ts` | `api/task.py`、`services/task.py`、`task_creation.py`、`task_runner.py` | `docs/workflow-engine-execution.md` |
| 任务卡片与详情读取投影、步骤前次状态、产物轮次和用量 | `src/pages/TaskList.tsx`、`src/pages/TaskDetail.tsx`、`src/pages/SharedTaskView.tsx` | `services/task_read_model.py` 在项目数据库执行器内生成任务载荷；`services/task.py` 和 `services/share.py` 共用 | `tests/test_task.py`、`tests/test_share.py`、`tests/test_api_contracts.py` |
| 任务归档、恢复、归档经验草稿与确认写入项目记忆 | `src/components/ArchiveExperienceDialog.tsx`、`src/pages/TaskList.tsx` | `api/task_archive.py` 持有归档和经验接口；`api/task_context.py` 提供项目数据库执行入口；`agent_assistants/archive_experience.py` 自主管理草稿证据、生成、停止、实时事件及日志交接，复用 `coordinator.py` 的引擎调用与配置 | `tests/test_api_contracts.py`、`tests/test_coordinator.py` |
| 任务步骤启动、会话供应商切换、运行记录与产物轮次分配 | `src/components/TaskStepProgressGraph.tsx` 展示状态 | `services/task_step_start.py` 是同步数据库工作单元；`services/task_runner.py` 经项目数据库执行器调用，并在线程中创建执行引擎 | `tests/test_task_step_start.py`、`tests/test_pipeline.py` |
| 步骤执行提示词、会话标识及执行消息生命周期 | `src/components/TaskConversationMessage.tsx` 展示执行消息 | `services/step_execution_messages.py` 选择首轮、续聊或重试提示词，持久化开始/完成/引擎不可用消息与事件日志；`services/task_runner.py` 负责引擎执行和步骤状态 | `tests/test_pipeline.py`、`tests/test_review_gate.py` |
| 任务步骤执行引擎配置、供应商切换交接与重置 | `src/components/TaskStepConfigController.tsx`、`src/components/TaskStepIoPanel.tsx` | `services/step_execution_config.py` 持有读取、校验、保存和重置；`services/workflow_runtime.py` 提供流程快照、任务锁及数据库执行入口 | `tests/test_api_contracts.py`、`tests/test_workflow_runtime.py` |
| 人工审核历史、决策、标记步骤/任务完成与产物返回线处理 | `src/hooks/useTaskReviewActions.ts` 接入确认与提交 | `api/task_reviews.py` 持有审核历史和决定接口；`services/review_decision.py` 是同步数据库事务；`services/workflow_runtime.py` 负责异步事件发布和恢复调度 | `tests/test_api_contracts.py`、`tests/test_review_gate.py`、`tests/test_workflow_runtime.py` |
| 失败执行消息沿用已有产物并设置步骤完成 | `src/hooks/useTaskReviewActions.ts` 提交产物轮次和下游调度选择 | `services/failed_step_completion.py` 在项目数据库线程内完成校验、产物轮次和返回线事务；`services/workflow_runtime.py` 负责锁和后续恢复调度 | `tests/test_api_contracts.py`、`tests/test_review_gate.py` |
| 审核配置覆盖、执行后审核恢复、自动/人工审核接线及消息生命周期 | `src/components/TaskConversationMessage.tsx` 展示审核消息 | `services/review_messages.py` 合并审核配置，在项目数据库执行器读取审核恢复检查点，管理审核门禁、即时消息接线和消息创建/完成/结果事件；`services/review_gate.py` 执行审核引擎；`services/task_runner.py::_apply_review_result` 统一正常执行与恢复后的步骤状态、重试和返工决策，运行器继续负责产物路由 | `tests/test_review_gate.py`、`tests/test_recovery.py`、`tests/test_live_step_message.py` |
| 审核拒绝与产物返回线触发的步骤返工 | `src/components/TaskStepProgressGraph.tsx` 展示步骤状态 | `services/step_rework.py` 持有 DAG 回退范围、步骤持久状态及事件；`services/task_runner.py` 在审核或产物路由完成后触发 | `tests/test_step_rework.py`、`tests/test_rework_loop.py`、`tests/test_artifact_port_routing.py` |
| 步骤产物端口路由、输入快照与运行恢复 | `src/components/TaskStepIoPanel.tsx`、`src/components/TaskStepProgressGraph.tsx` 展示输入及状态 | `services/step_artifact_routes.py` 持有路由状态、输入轮次、执行范围、前向边恢复与返回线应用；`services/artifact_routing.py` 提供无状态规则，`services/task_runner.py` 负责调度 | `tests/test_step_artifact_routes.py`、`tests/test_artifact_port_routing.py` |
| 执行引擎交互请求、响应与刷新后恢复 | `src/components/TaskConversationMessage.tsx` 展示交互卡片 | `services/step_interaction_messages.py` 保存请求与响应的消息投影、登记待响应请求并发布结果；`services/intervention.py` 管理响应，`services/task_runner.py` 在执行事件流中调用 | `tests/test_pipeline.py` |
| 运行中步骤消息注入、执行与审核消息分段及取消 | `src/components/ChatInput.tsx`、`src/components/TaskConversationMessage.tsx` | `services/step_live_messages.py` 持有活跃引擎、队列、提示词缓存、取消标记、执行与审核消息分段及持久化；`services/task_runner.py` 提供执行与审核的调用时机 | `tests/test_live_step_message.py`、`tests/test_review_gate.py`、`tests/test_pipeline.py` |
| 从指定步骤重跑、输入产物轮次校验、关闭父运行与旧消息、复用上游步骤 | `src/hooks/useTaskStepControls.ts`、`src/components/TaskStepIoPanel.tsx` | `services/workflow_restart.py` 持有输入轮次与当前流程校验、重跑前检查及子运行创建事务；`services/workflow_runtime.py` 负责停止旧执行器、任务锁和启动子运行 | `tests/test_workflow_runtime.py`、`tests/test_coordinator.py` |
| 失联执行器的步骤停止、租约校验与会话恢复 | `src/hooks/useTaskStepControls.ts` | `services/orphan_step_stop.py` 持有持久状态收尾；`services/workflow_runtime.py` 负责锁、租约释放及 AG-UI 事件 | `tests/test_workflow_runtime.py`、`tests/test_api_contracts.py` |
| 已停止步骤补充消息后重跑、失败执行消息重试资格 | `src/hooks/useTaskStepControls.ts`、`src/hooks/useTaskPendingInserts.ts` | `services/step_message_restart.py` 持有消息持久化、已提交队列项清除及失败消息校验；`services/workflow_runtime.py` 负责重跑和事件发布 | `tests/test_workflow_runtime.py`、`tests/test_api_contracts.py` |
| 运行结束后消费待插入消息 | `src/hooks/useTaskPendingInserts.ts` 管理待插入队列 | `services/pending_message_inserts.py::oldest_task_pending_batch` 选择最早目标并按队列顺序合并；`services/workflow_runtime.py` 在项目数据库执行器读取后触发步骤重跑 | `tests/test_pending_message_inserts.py`、`tests/test_workflow_runtime.py` |
| 流程运行租约、心跳续约与失效后的延迟恢复 | `src/components/TaskStepProgressGraph.tsx` 展示运行状态 | `services/workflow_lease.py` 持有实例身份、租约状态与后台任务；`services/workflow_runtime.py` 在启动、结束及恢复时调用 | `tests/test_workflow_lease.py`、`tests/test_recovery.py` |
| 流程运行启动、入口范围、用户首条消息及无父运行的步骤启动 | `src/hooks/useTaskStepControls.ts` 发起步骤重跑 | `services/workflow_start.py` 在项目数据库线程内准备运行与复用上游步骤；`services/workflow_runtime.py` 持有并发控制、事件发布和执行调度 | `tests/test_workflow_runtime.py`、`tests/test_recovery.py` |
| 流程定义与画布 | `src/components/FlowCanvas.tsx`、`flowCanvasData.ts`、`NodeConfigPanel.tsx` | `api/workflow.py`、`services/workflow_definition.py`、`workflow_runtime.py`；恢复决策在 `workflow_recovery.py` | `docs/workflow-engine-execution.md` |
| 助手与聊天 | `src/components/AssistantChatPanel.tsx` 装配通用聊天，`ChatInput.tsx` 管理输入区展示和编辑，`src/hooks/useChatInputAttachments.ts` 管理附件上传、粘贴、拖放、光标插入及失败恢复，`useChatInputDraft.ts` 管理会话/任务草稿归属切换与持久化，`ChatInputUsage.tsx` 管理额度及上下文用量浮层，`src/api/conversations.ts` 提供会话请求 | `agent_assistants/base.py` 持有通用回合与会话调度，`engine_invocation.py` 持有引擎能力判断、调用参数、事件流和交互审批；`chat_session.py` 持有会话操作，`chat_row_persistence.py` 持有会话/消息行加载与保存；其他助手共用 `session_state.py`、`persistence.py`、`history.py` | `AGENTS.md` 助手架构与事件边界；`apps/web/tests/chatInputImages.test.tsx`、`apps/web/tests/chatInputDraft.test.tsx`、`apps/web/tests/chatInputUsage.test.tsx`、`tests/test_assistant_engine_invocation.py`、`tests/test_chat_session.py` |
| 聊天会话引擎交接与分叉 | `src/pages/ChatPage.tsx` 打开交接/分叉入口并展示结果 | `agent_assistants/chat_session_transitions.py` 持有同会话引擎交接、原生分叉、历史交接包、复制消息、失败清理；`chat_session.py` 继承该业务模块并提供会话操作，异步分叉中的同步引擎工厂与项目路径读取隔离到工作线程 | `tests/test_chat_session.py`（含真实分叉 API 慢工厂健康检查 canary） |
| 聊天会话分叉/交接界面与请求 | `src/hooks/useChatSessionTransitions.tsx` 持有目标判断、弹框状态、分叉/交接请求、失败重试与成功后会话更新；`ChatPage.tsx` 只传当前会话/引擎选择和成功回调，复用 `ChatSessionForkDialog.tsx`、`ChatEngineHandoffDialog.tsx` | `api/chat_session.py`、`agent_assistants/chat_session_transitions.py` | `apps/web/tests/useChatSessionTransitions.test.tsx`、`apps/web/tests/chatSessionFork.test.ts` |
| 聊天会话发送、运行中追加与停止 | `src/hooks/useChatSessionActions.ts` 持有普通发送、待插入消息回退、停止、错误状态和首条消息后的标题更新；`ChatPage.tsx` 负责输入草稿和会话装配 | `api/chat_session.py`、`agent_assistants/chat_session.py` | `apps/web/tests/useChatSessionActions.test.tsx`、`apps/web/tests/chatSessionLiveMessage.test.mjs` |
| 聊天会话历史与消息事件详情 | `src/hooks/useChatSessionHistory.ts` 按路由会话/项目加载历史，按当前会话标识分页读取事件详情并写入共享 store；`ChatPage.tsx` 处理路由选择，加载详情后交给引擎选择模块恢复配置 | `api/chat_session.py`、`agent_assistants/chat_session.py` | `apps/web/tests/useChatSessionHistory.test.tsx`、`apps/web/tests/chatComposerPersistence.test.tsx` |
| 聊天会话引擎选择与本地恢复 | `src/hooks/useChatSessionEngineSelection.ts` 管理引擎/供应商/模型选择、依赖清空、会话切换保存、详情恢复和目录迟到后的兼容性校验；`ChatPage.tsx` 装配助手默认配置与交接入口 | `api/assistant.py` 提供助手默认值，`api/chat_session.py` 提供会话详情 | `apps/web/tests/useChatSessionEngineSelection.test.tsx`、`apps/web/tests/chatComposerPersistence.test.tsx`、`apps/web/tests/chatAssistantResolvedOptional.test.tsx` |
| 通用聊天输入区尺寸 | `src/hooks/useChatComposerResize.ts` 管理高度恢复、拖动、边界、键盘调整和重置；`src/components/AssistantChatPanel.tsx` 装配分隔条和输入区 | 无后端依赖 | `apps/web/tests/useChatComposerResize.test.tsx`、`apps/web/tests/chatComposerResize.test.mjs` |
| 通用助手对话待插入消息 | `src/hooks/useAssistantPendingInserts.tsx` 管理运行中消息对应的队列加载、添加、编辑、发送、删除、排序与错误状态，并装配共用的 `PendingMessageInserts.tsx`；`AssistantChatPanel.tsx` 仅接入运行中输入和浮层 | `api/pending_message_inserts.py` 提供项目队列接口 | `apps/web/tests/useAssistantPendingInserts.test.tsx`、`apps/web/tests/pendingInsertsClearance.test.tsx` |
| 聊天会话重命名 | `src/components/ChatSessionRenameDialog.tsx` 管理草稿、校验、请求、错误重试及侧栏标题更新；`src/pages/ChatPage.tsx` 只负责打开入口和当前标题投影 | `api/chat_session.py` 与 `agent_assistants/chat_session.py` 提供重命名接口 | `apps/web/tests/chatSessionRenameDialog.test.tsx`、`tests/test_chat_session.py` |
| 聊天引擎额度 | `src/hooks/useEngineQuota.ts` 按项目、引擎与运行状态请求额度，丢弃过期响应并提供手动刷新；`src/components/ChatInputUsage.tsx` 展示详情和刷新状态 | `api/engine.py` 提供额度接口 | `apps/web/tests/useEngineQuota.test.tsx`、`apps/web/tests/chatInputQuotaRefresh.test.tsx` |
| AI 流程助手方案选择 | `src/components/AiFlowChat.tsx` 展示提案并触发应用 | `agent_assistants/workflow_gen.py` 解析、合并、校验和发布流程方案；`workflow_choice_ui.py` 将已验证方案投影为 A2UI 选择事件，或为模型提供的选择界面补齐步骤数据 | `tests/test_workflow_choice_ui.py`、`tests/test_workflow_gen.py` |
| 协调助手任务上下文、历史裁剪与产物索引 | `src/components/TaskConversationMessage.tsx` 展示协调消息 | `agent_assistants/coordinator_context.py` 在项目数据库工作单元中组装提示词、审核与步骤快照、近期消息及安全的产物索引；`coordinator.py` 负责回合调度与调用 | `tests/test_coordinator.py`、`tests/test_live_step_message.py`、`tests/test_workstep_tools_injection.py` |
| 协调助手提案、确认与执行 | `src/components/TaskConversationMessage.tsx` 展示提案与确认入口 | `agent_assistants/coordinator_actions.py` 持有提案校验、幂等确认、取消、步骤补充、审核决定、步骤重跑和流程 Action 创建；同步数据库工作单元经项目执行器运行，`coordinator.py` 仅保留 API 入口和回合交接 | `tests/test_coordinator.py`（含慢确认健康检查 canary） |
| 引擎与安装 | `src/api/engine.ts`、`src/pages/SettingsPage.tsx` | `api/engine.py`、`engines/core/`、`services/engine_runtime.py` | `docs/multi-engine-architecture.md`、`docs/engine-runtime-management.md` |
| ACP 流式通知队列、工具审批选项与 elicitation 回复 | 前端接收 AG-UI 的交互请求并提交结果 | `engines/core/acp_streaming_client.py` 持有 ACP 客户端回调与等待中的交互；`engines/core/acp_base.py` 负责协议会话和执行 | `tests/test_acp_full_events.py`、`tests/test_p2_engines.py` |
| ACP 原生会话创建、加载、恢复、分叉、配置和扩展命令 | 前端通过会话与引擎设置接口调用 | `engines/core/acp_sessions.py` 持有协议会话命令；`engines/core/acp_base.py` 负责连接建立、流式执行与审批调度 | `tests/test_acp_full_events.py`、`tests/test_p2_engines.py`、`tests/test_engine_base_hierarchy.py` |
| ACP 会话更新到内部事件、工具调用、计划和用量的映射 | 前端通过 AG-UI 消费事件 | `engines/core/acp_event_mapper.py` 持有 ACP 通知映射；`engines/core/acp_base.py` 继承映射器并处理协议执行 | `tests/test_acp_full_events.py`、`tests/test_engine_base_hierarchy.py` |
| Codex SDK 通知到内部事件的映射、消息阶段、工具调用、用量与目标状态 | 前端通过 AG-UI 消费事件 | `engines/codex_sdk_events.py` 持有通知映射；`engines/codex_sdk.py` 持有 SDK 会话与执行循环并继承映射器 | `tests/test_p2_engines.py`、`tests/test_engine_base_hierarchy.py` |
| Codex CLI JSONL 事件、工具调用及沙箱拒绝交互 | 前端通过 AG-UI 消费事件与交互请求 | `engines/codex_cli_events.py` 持有 CLI 事件翻译；`engines/codex.py` 持有子进程、会话与审批后的重试 | `tests/test_p2_engines.py`、`tests/test_engine_base_hierarchy.py` |
| Claude CLI JSONL 事件、工具调用及权限拒绝交互 | 前端通过 AG-UI 消费事件与交互请求 | `engines/claude_code_events.py` 持有事件翻译；`engines/claude_code.py` 持有子进程、会话及项目权限规则写入 | `tests/test_p2_engines.py` |
| Claude Agent SDK 消息、工具、用量与结果事件 | 前端通过 AG-UI 消费事件 | `engines/claude_agent_sdk_events.py` 持有 SDK 消息翻译；`engines/claude_agent_sdk.py` 持有 SDK 执行与会话 | `tests/test_p2_engines.py` |
| Qoder SDK 消息、工具、用量与结果事件 | 前端通过 AG-UI 消费事件 | `engines/qoder_sdk_events.py` 持有 SDK 消息翻译；`engines/qoder_sdk.py` 持有 SDK 执行与会话 | `tests/test_p2_engines.py` |
| Pydantic AI Harness 能力装配、压缩、会话持久化与历史续接 | 前端通过 AG-UI 消费压缩事件 | `engines/pydantic_ai/harness_runtime.py` 持有 Harness 生命周期；`engines/pydantic_ai/engine.py` 持有代理运行和流式事件 | `tests/test_pydantic_ai_harness.py`、`tests/test_engine_base_hierarchy.py` |
| 项目与远程项目 | `src/api/project.ts`、`src/pages/SettingsPage.tsx` | `api/project.py`、`remote_project.py`、`services/project.py`、`remote_project.py` | `docs/architecture.md` |
| 远程访问身份、浏览器访问密钥、分享邀请和设备授权 | `src/api/project.ts::remoteProjectApi`、远程项目设置与分享入口 | `services/remote_access.py` 持有身份上下文、HTTP/WebSocket 访问判断与授权生命周期；`api/remote_project.py` 在工作线程执行同步配置操作，`streaming/ws.py` 在工作线程执行 WebSocket 授权判断 | `tests/test_remote_project.py`（含慢配置健康协程 canary） |
| 远程项目分享导入、本地标识、凭据保存与连接状态 | `src/api/project.ts::remoteProjectApi`、远程项目列表 | `services/remote_registry.py` 持有带锁的远程项目登记簿；`services/remote_project.py` 持有连接与请求转发，保留旧导入入口 | `tests/test_remote_project.py` |
| 远程项目服务端路由分发、授权 WebSocket 与请求事件转发 | 前端通过远程项目连接调用原有 API | `services/remote_host.py` 持有 FastAPI 路由目录和远程 WebSocket；`services/remote_protocol.py` 定义 HTTP 形状的请求/响应；`services/remote_project.py` 负责客户端连接并兼容旧导入 | `tests/test_remote_project.py`、`tests/test_git_api.py`（Git API 不进入远程路由目录） |
| Git 与任务工作区 | `src/components/git/`、`src/api/git.ts` | `api/git.py`、`services/git/` | `services/git/task_workspace.py` 负责任务工作区 |
| 分享、定时、统计 | `src/api/share.ts`、`schedule.ts`、`statistics.ts` | `api/share.py`、`schedule.py`、`statistics.py`；对应 `services/` | 各模块测试 |
| 用量与费用计算 | `src/api/statistics.ts` | `services/usage_accounting.py`，由 `statistics.py` 与 `task_execution_report.py` 共用 | `tests/test_usage_accounting.py` |
| 通用控件与移动样式 | `src/components/Button.tsx`、`Input.tsx`、`Select.tsx`、`Textarea.tsx`、`src/index.css`、`src/mobile.css` | — | `docs/frontend-design.md`、`tests/mobileButtonSizing.test.mjs` |
| 供应商导入来源、候选选择及导入结果 | `src/components/ProviderImportDialog.tsx` 持有导入弹窗的加载、选择、提交和反馈；`src/pages/ProviderSettings.tsx` 只打开弹窗并刷新供应商列表；固定样式在 `ProviderImportDialog.css` | `api/providers.py`、`services/providers.py` | `apps/web/tests/providerImportDialog.test.tsx` |
| 供应商新建、编辑、复制与协议/密钥配置 | `src/components/ProviderEditorDialog.tsx` 持有草稿、密钥读取、校验、保存及未保存关闭确认；`src/pages/ProviderSettings.tsx` 负责列表操作与刷新；固定样式在 `ProviderEditorDialog.css`、`ProviderSettings.css` | `api/providers.py`、`services/providers.py` | `apps/web/tests/providerEditorDialog.test.tsx`、`providerEngineCompatibility.test.mjs` |
| 定时规则编译、时区校验与下次运行预览 | `src/pages/SchedulePage.tsx` 提供规则编辑入口 | `services/schedule_rules.py` 持有纯规则计算，`services/schedule.py` 保留兼容导入并负责持久化与调度 | `apps/daemon/tests/test_schedule.py` |

表中的前端路径均相对于 `apps/web/`，后端路径均相对于 `apps/daemon/`。后端请求模型在 `schemas/`，持久化模型在 `models/`；服务里的同步数据库工作单元通过 `services/project_database.py` 的项目执行器运行。实时事件从 `engines/core/events.py` 经 `engines/core/agui.py` 到前端 `src/utils/agui.ts`。

## 任务详情内部定位

以下组件位于 `apps/web/src/components/`，测试位于 `apps/web/tests/`。`TaskDetailView.tsx` 负责组装和跨区域协调；新增行为应放到实际拥有它的组件，并同步更新此表。

| 功能 | 代码入口 | 行为测试 |
|---|---|---|
| 页头、创建者、关闭操作 | `TaskDetailHeader.tsx` | `actorVisibility.test.mjs`、`taskDetailPageReuse.test.mjs` |
| 任务弹窗位置、尺寸、四边四角缩放与键盘移动 | `TaskDetailWindow.tsx`；`TaskDetail.tsx` 只装配内容 | `taskDetailWindow.test.tsx` |
| 任务描述展示、编辑保存及定时启动时间调整 | `TaskDetailDescription.tsx`；任务页启用编辑，分享页只读 | `taskDescriptionEditing.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 步骤提示词快速编辑、保存和错误恢复 | `StepPromptEditor.tsx`；`TaskDetail.tsx` 只选择步骤并在保存后更新项目状态 | `stepPromptEditor.test.tsx` |
| 当前步骤提示词展示与快捷编辑入口 | `TaskStepPrompt.tsx`；任务页可编辑，分享页只读；固定样式在 `src/index.css` 的 `task-step-prompt-*` 类 | `taskStepPrompt.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 桌面、移动及产物轮次页签 | `TaskDetailTabs.tsx` | `taskDetailTabs.test.tsx` |
| 任务详情两栏分割比例、拖动与会话持久化 | `TaskDetailSplitLayout.tsx`；`TaskDetailView.tsx` 只装配步骤、对话和移动端产物内容 | `taskDetailSplitLayout.test.tsx` |
| 任务消息发送目标、步骤可恢复状态提示 | `TaskChatTargetTabs.tsx`；任务详情 View 仅提供目标与步骤状态 | `taskChatTargetTabs.test.tsx`、`mobileTaskTargetTabs.test.mjs` |
| 步骤进度图交互和渲染 | `TaskStepProgressGraph.tsx` | `taskStepProgressGraph.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 步骤进度图的依赖布局、连线几何与轮次 | `taskStepProgressLayout.ts` | `taskStepProgressLayout.test.ts`、`taskStepProgressGraph.test.tsx` |
| 步骤输入、输出、产物轮次及重新执行 | `TaskStepIoPanel.tsx` | `taskStepIoPanel.test.tsx`、`taskDetailProgressLayout.test.mjs` |
| 审核结果展示与操作入口 | `TaskReviewResult.tsx` | `taskReviewResult.test.tsx`、`reviewTerminateAction.test.mjs` |
| 审核消息关联、最新可操作审核、人工审核识别及停止后的标记完成资格 | `src/pages/taskReviewRules.ts`；任务消息、审核结果和移动端入口共用 | `taskReviewRules.test.ts` |
| 审核列表刷新、决策提交、失败执行标记完成与下游调度确认 | `src/hooks/useTaskReviewActions.ts`；`TaskDetail.tsx` 只接入审核面板和确认框 | `useTaskReviewActions.test.tsx` |
| 步骤审核设置的草稿、保存与错误恢复 | `TaskReviewConfigPanel.tsx`；任务页仅开启编辑，分享页不显示设置 | `taskReviewConfigPanel.test.tsx` |
| 消息时间线与滚动 | `taskConversationFeed.ts`；滚动行为由 `src/hooks/useTaskConversationScroll.ts` 管理，任务、助手和过程追踪共用规则在 `src/utils/conversationScroll.ts` | `conversationScroll.test.ts`、`streamingSelection.test.tsx` 及对应 conversation 测试 |
| 单条任务消息的发送者、执行状态、审核操作、产物与元数据 | `TaskConversationMessage.tsx`；`TaskDetailView.tsx` 只选择消息顺序并接入时间线，`TaskMessageArtifacts.tsx` 展示产物入口 | `taskConversationMessage.test.tsx`、`taskConversationRuntime.test.ts`、`taskMessageArtifacts.test.tsx` |
| 任务历史、向上分页与消息事件详情 | `src/hooks/useTaskHistory.ts` | `taskHistory.test.tsx`、`remoteChatSync.test.mjs` |
| 任务对话待插入队列的加载、编辑、排序、立即发送与失败回滚 | `src/hooks/useTaskPendingInserts.ts`；队列持久状态在 `src/stores/pendingMessageInsertStore.ts`，`TaskDetail.tsx` 只选定目标消息并接入对话 | `useTaskPendingInserts.test.tsx`、`pendingMessageInsertStore.test.ts` |
| 任务协调引擎配置与供应商/模型选择 | `src/hooks/useTaskCoordinatorConfig.ts`；`TaskDetail.tsx` 负责接入任务详情输入区 | `useTaskCoordinatorConfig.test.tsx` |
| 步骤停止、丢失会话重启与失败消息重试 | `src/hooks/useTaskStepControls.ts`；任务详情提供历史刷新和错误展示回调 | `useTaskStepControls.test.tsx` |
| 任务历史刷新合并、事件详情归并与失败重试 | `src/pages/taskHistoryModel.ts`；本地详情、分享页及历史 hook 共用 | `taskDetailChat.test.ts`、`taskHistory.test.tsx` |
| 任务产物选择、轮次、步骤输入输出映射与接口变更判断 | `src/pages/taskArtifactRules.ts`；`TaskStepIoPanel.tsx` 展示结果，本地详情与分享页共用产物查找 | `taskDetailChat.test.ts`、`taskStepIoPanel.test.tsx` |
| 任务产物列表加载、生成后刷新、预览与打开本地目录 | `src/hooks/useTaskArtifacts.ts`；`TaskDetail.tsx` 负责将状态接入详情页，远端项目禁用本地目录操作 | `useTaskArtifacts.test.tsx` |
| 任务归档经验草稿、生成和确认 | `ArchiveExperienceDialog.tsx`；任务列表只负责打开和归档后移除卡片 | `archiveExperienceDialog.test.tsx`、`archiveExperienceControls.test.mjs` |
| 看板任务卡片的状态、时长、定时标签与操作按钮 | `TaskBoardCard.tsx`；`TaskList.tsx` 负责项目筛选、分组、拖放及请求编排；固定卡片和看板样式在 `src/index.css` 的 `task-board-*` 类 | `taskBoardCard.test.tsx`、`taskListCardStepLabel.test.mjs` |
| 分享页实时消息事件合并、状态更新与事件数量上限 | `src/pages/sharedTaskMessages.ts`；`src/hooks/useSharedTaskSession.ts` 将事件写入消息状态 | `sharedTaskMessages.test.ts`、`useSharedTaskSession.test.tsx` |
| 分享链接的密码解锁、会话过期恢复、首屏快照、实时连接及消息事件详情 | `src/hooks/useSharedTaskSession.ts`；`SharedTaskView.tsx` 只装配任务展示和交互，固定样式在 `src/index.css` 的 `shared-task-*` 类 | `useSharedTaskSession.test.tsx`、`interactiveShareComposer.test.tsx` |
| 新建任务、起始步骤与启动方式、审核覆盖、AI 草稿和关闭保护 | `TaskCreatePanel.tsx`；`TaskList.tsx` 只负责入口和当前项目/流程选择；样式在 `src/index.css` 的 `task-create-*` 类 | `taskCreatePanel.test.tsx`、`assistantPanelToggle.test.mjs` |
| 项目记忆 `.workstep/MEMORY.md` 读取、编辑、保存与放弃确认 | `ProjectMemoryPanel.tsx`；任务列表只负责打开入口；样式在 `src/index.css` 的 `project-memory-*` 类 | `projectMemoryPanel.test.tsx` |

## 修改路径

1. 用上表找到职责所有者，搜索其调用者和对应测试；跨层改动同时核对 API、schema、状态和界面。
2. 行为变更先写能复现问题的测试；移动样式核对 `mobile.css` 的共享尺寸变量和移动端检查；异步 I/O 用慢 I/O 加健康检查或轻量协程验证事件循环响应。
3. 只在职责独立、调用边界清楚时拆模块。行数与状态数量是发现问题的信号，不是拆文件目标；避免透传整组状态或让维护入口散落。
4. 更新本表和相应专题文档，运行相关测试、完整测试及构建。具体命令见 [开发指南](development.md)。
