# AGENTS.md

本文件为 AI 开发 在本项目中工作时提供指引。

## 文档导航与权威来源

- `README.md` / `README.zh-CN.md`：面向使用者的项目首页与快速开始。
- `docs/README.md`：架构、开发和 GitHub 维护文档入口。
- `PRODUCT.md` / `DESIGN.md`：产品定位与视觉系统。
- 本文件：Agent 执行约束和当前实现不变量；与代码冲突时以已验证的代码行为为准，并同步修正文档。

不要把完整架构或开发规范重新堆回首页 README；应更新对应 `docs/` 文档，并保持中英文首页链接可达。

## 项目概述

本仓库包含 **WorkStep** 的设计原型与技术文档——一个本地优先的工作流编排工具，将多个 LLM 引擎（Codex、Codex CLI、Hermes ACP 等）串联为可定制的研发管道。

当前项目包含可运行的前后端应用、早期静态原型与设计文档：
- `apps/daemon` — Python + FastAPI 本地后台服务
- `apps/web` — React + TypeScript + Vite Web 前端
- 静态 HTML 原型（无需构建）
- 产品需求与技术架构文档
- 示例数据结构

## 目录结构

```
apps/            # 可运行应用（daemon 后端 + web 前端）
ui/              # 前端原型（浏览器直接打开）
docs/            # 产品文档（PRD、引擎协议设计）
plans/           # 技术架构文档（按功能拆分）
steps.json       # 示例工作流定义
cards.json       # 示例任务数据
AGENTS.md        # 本文件
```

## 应用目录

### `apps/daemon`

WorkStep 本地后台服务，使用 Python 3.11+、FastAPI、Peewee 构建，负责 REST API、WebSocket 实时事件、项目管理、工作流编排、LLM 引擎调用与 SQLite 持久化。

主要目录：
- `api/` — API 路由与接口
- `services/` — 业务逻辑、DAG 调度与任务执行
- `engines/` — LLM 引擎及 ACP、CLI、API 适配
- `agent_assistants/` — 助手模块（每个助手一个文件，通用层在 `base.py`）
- `models/` — Peewee 数据模型与迁移
- `schemas/` — Pydantic 请求、响应模型
- `streaming/` — 实时事件总线
- `tests/` — 后端测试

开发命令：

```bash
cd apps/daemon
uv sync --dev
uv run uvicorn main:app --reload --port 8765
uv run pytest
```

### Peewee 异步开发规范

- **Peewee 一律异步隔离**：Peewee 是同步 ORM；任何 `async def`、FastAPI 异步路由、WebSocket 处理器和后台协程都不得直接执行查询、迭代惰性查询、写入、删除、事务或数据库连接操作。
- **项目数据库统一入口**：每个项目的完整同步数据库工作单元必须封装为普通函数，并通过 `await project_manager.run_db(project_id, operation)`（或已注入的 `ProjectDatabaseExecutor.run`）执行。查询物化、事务、模型序列化都必须在该工作单元内完成。
- **跨项目与初始化**：跨项目读取应按项目分别提交到各自数据库执行器，可用 `asyncio.gather` 并发等待；项目注册、初始化等尚无项目执行器的操作才可使用 `asyncio.to_thread`，禁止退回事件循环线程执行。
- **禁止跨线程异步混用**：不得在数据库工作线程中调用 `asyncio.create_task`，不得让数据库激活上下文跨越 `await`。需要启动后台任务时，必须拆成“数据库线程持久化 → 返回纯数据 → 事件循环创建任务”。
- **回归要求**：新增或修改 Peewee 调用路径必须增加真实 API/WebSocket/后台调度测试，并用慢 SQL 或 SQLite 锁竞争配合健康检查 canary，证明数据库繁忙时事件循环仍可响应。

### `apps/web`

WorkStep Web 前端，使用 React、TypeScript、Vite、React Flow 和 Zustand 构建，包含任务列表、任务详情、工作流画布与设置页面。

开发命令：

```bash
cd apps/web
npm install
npm run dev
npm run build
```

## 查看原型

浏览器直接打开 `ui/` 下的 HTML 文件：
- `ui/index.html` — 主面板（任务列表 + 看板视图）
- `ui/canvas-editor.html` — Dify 风格节点画布编辑器
- `ui/card-detail.html` — 任务详情（阶段时间线 + LLM 对话）
- `ui/ai-research-harness.html` — 备选界面

## 前端开发规范（`apps/web`）

- **优先复用**：同一 UI 出现两次即抽公共组件并统一默认值，禁止复制实现。现有入口：消息用 `ChatMessageBubble` + `MessageMetaBar` + `MessageResponseFooter`；输入用 `ChatInput`（配置菜单用 `CoordinatorConfigBar`）；Markdown 编辑/展示用 `MarkdownEditor` / `MarkdownMessage`；确认用 `ConfirmDialog`。
- **交互与校验**：禁用原生 `alert/confirm`。必填项为空时提交类按钮禁用；触发类按钮（如「AI 创建」）可点击，但须在弹框固定高度区域提示、聚焦缺失字段。侧边面板有改动时，关闭前用 `ConfirmDialog` 确认；无改动时遮罩点击直接关闭。
- **命名**：新建/重命名项目与工作流时禁止空白字符，前端即时校验，后端 schema 同步强制。
- **流程与模板**：新流程默认空画布，模板由用户主动选择。模板以 `~/.workstep/data/templates/*.json` 为准；启动时从 `apps/daemon/data/templates/` 复制缺失文件但不覆盖。模板含 `id/name/description/steps`；内置模板标记 `default: true` 且不可删除。
- **助手架构**：所有新助手和后续助手能力扩展必须建立在同一套基础设施上，禁止复制会话、流式事件、停止、引擎配置或聊天 UI 实现。后端通过 `agent_assistants/base.py` 的 `AssistantConfig` 注册并复用 `AssistantRuntime`，仅提供助手自己的 system prompt、上下文构建、结构化结果解析/校验和发布逻辑；创建态会话默认仅内存，需要跨重启恢复时才增加持久化适配器。前端通过 `createAssistantStore(config)` 创建配置实例，统一使用 `AssistantChatPanel`、`ChatMessageBubble`、`MessageMetaBar`、`MessageResponseFooter` 和 `ChatInput`；助手特有 UI 只通过组合插槽或薄包装组件扩展。每个助手必须使用独立 WebSocket `channel` 并按 channel 分流，结构化结果通过通用 store 的 `resultEvent` / `proposalEvent` 配置接入，不得让其它助手 store 接收。AI 流程助手统一用 `AiFlowChat`；方案选择必须呈现可点击的提案卡片（标题、步数、摘要、应用态）。新增助手必须覆盖会话隔离、结构化结果、停止、错误、无意外落库及既有助手回归测试。
- **聊天与 Markdown**：任务对话和 AI 流程助手共用上述聊天组件，不得覆盖 `ChatInput` 的统一高度或重复实现上传/粘贴。Markdown 图片上传至项目 `.workstep/uploads/`，正文保存项目相对路径，并由 `MarkdownMessage` 映射预览地址。
- **布局与样式**：复杂弹框顶部放表单，主区域占满余高、支持分隔拖动和弹框缩放；避免写死过矮高度。公共组件放入 modal 后须检查全局表单样式污染，必要时提高选择器特异性并人工核对。
- **状态与视觉**：异步处理中状态必须配持续旋转图标，结束、暂停或等待用户时停止。`ChatInput` 的发送/停止、附件选中态和配置菜单样式以组件现有实现为准，不在调用处另行定制。
- **图标按钮**：按钮直接内联 `svg`/`Icon` 时必须显式 `padding: 0`（或按设计给最小内边距），禁止依赖全局 `button` 默认 padding（`4px 8px`），否则固定尺寸按钮的内容区被压缩、图标被裁剪。
- **i18n**：新增文案先写 `zh-CN.ts`；其他词典可暂用中文占位，但键集合必须一致且非空（由 `apps/web/tests/i18n.test.ts` 校验）。
- **禁止重复 API 请求**：同一组件内多个 `useEffect` 不得对同一 API 发起可重叠的请求。具体规则：
  - 新增 `useEffect` 触发 API 调用前，检查同一组件（及父级 Layout 等）是否已有 effect 在相同或更大依赖集上调用同一接口。若有重叠，合并为单一 effect 或移除冗余。
  - effect 依赖数组中只放**真正影响该请求结果**的变量。例如：加载助手配置的请求结果不随 `sessionParam` 变化，则不应把 `sessionParam` 放入该 effect 的 deps。
  - 若同一数据需要被多个触发条件刷新（如事件信号 A、B、C 都需刷新列表），合并为一个 effect 以联合信号为 dep，或在 store 层做 in-flight 去重（如 `listLoading` guard），避免同 tick 内多次 fetch。
  - 新增功能时若需新增数据加载逻辑，优先复用已有 store action（其内部通常已含去重），而非在组件内新写裸 API 调用。

## 技术架构（已确定）

| 层 | 技术 | 说明 |
|---|---|---|
| Daemon | **Python + FastAPI** | 异步 API，SSE 推送，子进程管理 |
| ORM | **Peewee** | SQLite 友好，轻量 |
| 子进程 | **asyncio.subprocess** | 流式读取 LLM CLI stdout |
| SSE | **sse-starlette** | 全局单流推送 |
| 内部事件 | **ACP 词汇** | 各引擎统一产出 ACP session update 对齐事件，`events.py` 定义（内部=ACP） |
| 对外事件 | **AG-UI** | WebSocket 实时推送与历史回放共用 `engines/core/agui.py` 翻译层（对外=AG-UI） |
| 前端 | React + TypeScript + Vite | 画布编辑器是核心约束；store 只消费 AG-UI 事件 |
| 数据 | **per-project SQLite** | 每个项目独立 `.workstep/workstep.db` |

WebSocket `/ws` 支持按连接订阅过滤（`{"type":"subscribe","task_ids":[...],"status_only_task_ids":[...],"session_ids":[...],"channels":[...]}`，`streaming/bus.py` 入队前按谓词过滤）；前端连接后主动订阅：打开的任务详情订阅全量流、当前项目任务订阅状态事件、活跃助手会话按 `session_id` 订阅，未订阅前保持全量广播向后兼容。

## 多引擎支持

`BaseLLMEngine` = **我方系统扩展**：安装、版本、二进制解析、配置表单、能力声明等 WorkStep 特有自定义函数。
`AcpEngineBase` = **通用 ACP 协议调用**：spawn / session / interaction / approval 等协议方法，所有引擎继承它。
新增引擎 = 新增一个文件：继承 `AcpEngineBase` 并实现 `BaseLLMEngine` 的抽象自定义函数
（`is_installed` / `get_version` / `resolve_binary`）。ACP 原生引擎（如 Hermes）声明 `COMMAND` 即可，
基类直接提供全部协议实现；非 ACP 引擎用自己的传输实现 `spawn`，并**完整实现等价会话 / 审批方法**
（`create_session` / `resume_session` / `close_session` / `cancel_session` / `approve_tool` / `approve_tool_option`
等，无原生入口的如实声明能力并安全降级），上层调用只依赖 `AcpEngineBase`：

| 引擎 | stdin | stdout | 会话恢复 | ACP 事件 | 状态 |
|------|-------|--------|---------|---------|------|
| Codex | JSONL 流（保持打开） | JSONL | `exec resume <thread_id>` | 实际子集 | P1 实现 |
| Codex SDK | 官方 SDK 进程内驱动 | 消息流 | `thread_resume` | 实际子集 | 已实现 |
| Claude Code | 纯文本（写完关闭）/ stream-json 双向 | JSONL | `--resume <session_id>` | 实际子集 | P2 实现 |
| Hermes | JSON-RPC 双向 | JSON-RPC | 原生 ACP session | 全集 | P2 实现 |
| Claude / Qoder Agent SDK | 官方 SDK 进程内驱动 | 消息流 | SDK `resume` | 实际子集 | 已实现 |
| OpenClaw | 一次性 exec | JSON 信封 | 无 | 信封实际子集 | P5 实现 |
| Pydantic AI（内置 Agent） | 官方 SDK 进程内驱动，绑定供应商 base_url/key | 消息流 | 无（message_history）；harness 自动挂载 StepPersistence | 实际子集 | 已实现 |

各引擎声明 `acp_events` capability 元数据（**声明 = 实际**：有原生等价就映射，无来源不发、不合成默认值；
`tests/test_engine_base_hierarchy.py` 保证 `acp_events ⊆ ACP_EVENTS` 且映射路径产出的事件都被声明）；
非 ACP 引擎的 `request_permission` 在 `request_interaction` 中登记到基类 pending 审批注册表，
`approve_tool` / `approve_tool_option` 统一把决定写回挂起交互；Hermes 由 `AcpEngineBase` 直接产出并补全缺失 update 类型。

会话分叉能力通过 `supports_session_fork` / `fork_session` 独立声明，不能用 resume 模拟。当前 Codex SDK 使用官方 `thread_fork`；其它没有真实原生入口的引擎声明为不支持，并由会话聊天层使用显式的跨引擎上下文交接。

Pydantic AI 固定挂载 harness `Coder` 与 `Skills(<项目>/.workstep/skills)`；Skills 只消费
SkillCenter 白名单镜像，项目记忆只使用流程层注入的 `.workstep/MEMORY.md`，不挂载 Harness 私有
Memory。思考强度通过 Pydantic AI
`Thinking(effort=...)` capability 传递，不再使用 `model_settings.thinking`。动态配置仍不暴露
`harness` 字段并固定写回 `auto`；`TieredCompaction` + `WarnNearLimits` 自动上下文压缩，
`StepPersistence` 把会话历史持久化到项目 `.workstep/harness_runs.db`（每 run 最多 30 个快照），
按 `conversation_id=session_id` 从最近一个有快照的 run 恢复；单次 Agent run 的 Pydantic AI
`request_limit` 固定为 100，工具参数校验重试为 3 次，既容纳长编码任务及非严格模型的参数纠错，
又保留失控保护。Coder shell 在默认安全命令基础上允许项目构建所需的 `yarn/npm/npx/node`；
命令固定从项目根执行，不允许用 `cd/bash/sh` 绕过白名单。压缩发生时经 receipts 排空产出
`compacted` 事件（`acp_events` 已声明）。Shell 命令策略拒绝以普通工具结果返回给模型，不消耗
Pydantic AI 的工具重试预算，避免连续尝试不在白名单中的命令终止整个回合。Coder 自带
`Planning` 工具集（`write_plan` / `add_task` / `update_task_status` / `update_task_statuses` /
`remove_task` 等，Pydantic 引擎独有）直接改固定 `InMemoryPlanStore`；引擎在每次 planning 工具
调用完成后回读 store 并发布标准 ACP `plan` 快照（未变化则去重），前端按与其它引擎一致的
`plan` 事件渲染计划清单；`blocked`→`pending`、`cancelled`→`completed` 归一到 ACP 稳定三态
（`engines/core/plans.py: normalize_plan_status`）。

统一内部事件（`apps/daemon/engines/core/events.py`，内部=ACP 词汇）：
- 引擎内容事件（ACP session update 对齐）：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`（`tool_call_id/title/kind/raw_input`）、`tool_call_update`（`status: pending|in_progress|completed|failed`，增量 `raw_input`、结果 `raw_output`）、`plan`、`plan_update`、`plan_removed`、`usage_update`（`used/size/cost{amount,currency}`）、`user_message_chunk`、`session_info_update`、`available_commands_update`、`config_option_update`、`current_mode_update`、`mcp_message`、`elicitation_completed`
- 编排事件（保留非 ACP 词汇）：`status`、`session_started`（可复用引擎会话标识）、`live_message`（阶段中途插入消息）、`interaction_request`（权限申请 / 提问弹窗，ACP 语义）、`interaction_response`（弹窗用户回复）、`subagent`（子代理 / 后台任务生命周期事件）、`compacted`（上下文已自动压缩）、`engine_state`（进程内引擎状态快照）、`error`、`a2ui`（A2UI 载荷）、`acp_raw`（未知 ACP update 透传）
- 旧 `events_json` 兼容：历史回放经 `map_legacy_event` 将旧词汇映射到新词汇后再翻译

对外事件（AG-UI，`apps/daemon/engines/core/agui.py` 统一翻译，WebSocket 实时推送与历史回放共用）：
- 消息：`TEXT_MESSAGE_START / TEXT_MESSAGE_CHUNK / TEXT_MESSAGE_CONTENT / TEXT_MESSAGE_END`、`REASONING_MESSAGE_CHUNK`
- 工具：`TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_CHUNK / TOOL_CALL_RESULT`（`toolCallId/toolCallName/args/output/isError`）
- 运行：`RUN_STARTED / RUN_FINISHED / RUN_ERROR`（`threadId=task_id`、`runId=task_id::step_key`）
- 自定义：`CUSTOM{name:"workstep.*"}`（plan / usage / interaction / subagent / task_draft / flow_proposals / status 等）与 `CUSTOM{name:"a2ui.surface"}`（A2UI 载荷，按 messageId 追加；` ```a2ui ` fence 仅作旧消息回退）
- 前端 `apps/web` 所有 store（`taskStore` / `assistantStore` 及其配置实例）只消费 AG-UI，统一入口 `src/utils/agui.ts`

## 数据模型

每个项目一个 `.workstep/workstep.db`，核心表：
- `tasks` — 任务（对应前端"卡片"）
- `task_steps` — 每阶段进度（支持并行分支）
- `messages` — LLM 消息正文、事件摘要与 JSONL 日志索引
- `agent_sessions` — 引擎会话（Codex --resume 用）
- `artifacts` — 产物记录

任务阶段执行与审核的完整过程事件以项目 `.workstep/event_logs/task-<task_id>/<message_id>.jsonl`
为权威日志；`messages` 表只保留可见 `content`、必要的摘要事件、`event_summary_json`、
事件数量/末序号及 `event_log_path` 查询投影。历史接口默认返回摘要，详细时间线通过
`GET /api/task/{task_id}/messages/{message_id}/events` 分页读取；无 `event_log_path` 的旧
`events_json` 消息继续兼容回放。
