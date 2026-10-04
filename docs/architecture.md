# WorkStep 架构

本文描述当前可运行实现。具体接口和字段发生冲突时，以代码、测试和根目录 `AGENTS.md` 为准；尚未完成的方案与验收记录位于 [`plans/`](../plans/README.md)。

## 运行形态

WorkStep 的主要应用及职责如下：

| 应用 | 技术 | 职责 |
|---|---|---|
| `apps/daemon` | Python、FastAPI、Peewee | REST、WebSocket、项目数据库、工作流编排、引擎和助手运行时 |
| `apps/web` | React、TypeScript、Vite、Zustand | 任务、流程画布、聊天、设置和实时状态 UI |
| `apps/desktop` | Electron | 启动内置 Python 后端、加载 Web UI、桌面协议和更新 |
| `apps/landing` | React、Vite | 产品官网 |
| `apps/gateway` | Python、FastAPI、异步 SQLAlchemy | 平台账号、设备授权、远程通道、分享与审计 |
| `apps/gateway-web` | React、TypeScript、Vite | 平台门户及管理界面 |

开发模式下，Web 前端通过 Vite 连接本地 daemon。生产 Web 资源由 daemon 提供。桌面端打包一套 uv-managed Python 运行时和 daemon 源码，不使用 Nuitka 冻结；sidecar 只监听 `127.0.0.1`，默认请求端口 `0`，通过 stdout 的 `PORT:<port>` 报告实际端口。

桌面端每次启动生成随机令牌，由 Electron 主进程为目标 loopback origin 的 HTTP 和 WebSocket 请求注入。渲染进程不能读取令牌，外部导航、新窗口、WebView 和浏览器权限请求由桌面壳限制。

## 数据所有权

WorkStep 默认不需要云端账户。每个项目在自己的目录内保存运行数据：

```text
<project>/
└── .workstep/
    ├── project.json
    ├── workstep.db
    ├── artifacts/
    ├── event_logs/
    ├── uploads/
    ├── skills/
    ├── MEMORY.md
    └── harness_runs.db
```

- `project.json` 保存稳定项目标识。
- `workstep.db` 是该项目的 Peewee/SQLite 数据库。
- `artifacts/` 保存步骤产物、轮次目录和 manifest。
- `event_logs/` 保存消息的完整 JSONL 事件日志。
- `uploads/` 保存项目内聊天附件。
- `skills/` 是 Skill Center 为该项目生成的白名单镜像。
- `MEMORY.md` 是项目记忆的唯一用户可编辑来源。
- `harness_runs.db` 保存内置 Pydantic AI 引擎的会话快照和检索数据。

从项目列表移除项目不会删除这些文件。重新注册原目录时，daemon 复用项目标识、流程、任务和会话历史。

同步 Peewee 操作不会直接运行在 FastAPI 事件循环线程。项目数据库工作统一提交给该项目的 `ProjectDatabaseExecutor`；跨项目读取分别提交后再异步汇总。

## 工作流模型

流程定义持久化在项目数据库的 `workflows` 表中。新项目默认没有流程，新流程默认是空画布；模板只在用户主动选择时应用。

模板源位于 `apps/daemon/data/templates/`，启动时复制缺失模板到 `~/.workstep/data/templates/`，不覆盖用户已有文件。内置模板标记为 `default: true`，不可删除。

前端画布保存节点和连线；后端 `WorkflowDefinition` 负责加载、校验并编译为执行用 DAG。启动、阶段重跑、人工审核续跑和进程恢复统一读取最新流程；`workflow_runs` 只保存运行关系与状态，阶段真实输入输出由 `StepRun` 和产物 manifest 记录。

```text
Task
└── WorkflowRun（一次流程运行，保存父子轮次、状态、路由与租约）
    ├── StepRun（步骤执行 attempt）
    └── ReviewRun（步骤审核 attempt）
```

`TaskStep` 是每个步骤的当前状态投影；`WorkflowRun`、`StepRun` 和 `ReviewRun` 保存执行历史。`TaskRunner` 根据依赖关系并行启动 ready 步骤，汇合节点只有在所有依赖通过且每条实线输入连接已经被对应的非空产物激活后才会执行。

任务并发和助手对话并发由 `ConcurrencyGate` 分通道管理。各项目拥有独立的槽位池与 FIFO 等待队列；全局配置是各项目的默认值，不是所有项目共享的总量上限。任务排队不占对话槽位，同一会话内的 turn 由助手运行时串行处理。

配置逐字段按“项目显式值 → 全局默认值 → 不限制”解析：`max_tasks`、`max_chats` 的 `0` 表示不限制，项目 `null` 表示跟随全局；项目覆盖保存在 `project_settings` 的 `concurrency` 键。`schedule_exempt` 生效时，定时任务与定时启动不占任务槽位。降低限额不中断已有运行，提高限额会唤醒等待项。任务运行收尾和对话 turn 收尾释放各自槽位；取消排队任务回到 `ready`，重启后的队列恢复见[工作流执行说明](workflow-engine-execution.md#队列恢复)。

全局配置入口为 `GET/PUT /api/assistant/concurrency`，项目覆盖为 `GET/PUT /api/projects/{project_id}/settings/concurrency`。配置加载及修改后推送到内存闸门，执行热路径不直接读取数据库；行为测试见 `test_concurrency_gate.py`、`test_concurrency_api.py`。

### 执行状态机与收敛边界

工作流状态不是一个字段，而是五层状态共同组成：

| 层 | 职责 | 状态来源 |
|---|---|---|
| `Task` | 面向任务列表的总体投影 | 当前活动运行与步骤状态聚合 |
| `WorkflowRun` | 一次完整运行或局部重跑的生命周期 | `WorkflowRuntime` |
| `TaskStep` | 每个步骤当前可操作状态 | `TaskRunner`、审核和人工操作 |
| `StepRun` | 步骤一次不可变 attempt 的历史结果 | 执行引擎收尾 |
| `ReviewRun` | 一次自动或人工审核的历史结果 | `ReviewGate`、人工决定 |

正常主链路为：

```text
Task: ready → queued? → running → ready | paused | stopped
WorkflowRun: running → succeeded | paused | failed | stopped | superseded
TaskStep: pending → running → reviewing? → passed
                         ↘ awaiting_review → passed | retrying | cancelled
                         ↘ failed | cancelled
                         ↘ rework / rework_waiting → running
```

`TaskStep` 是可变投影，`StepRun` / `ReviewRun` 是追加式历史；局部重跑必须新建子 `WorkflowRun`，不能改写父运行的历史结果。动态路由中的 `skipped` 只表示范围裁剪或有其它输出端口已选中时的未选分支；若来源步骤没有任何正向非空产物，下游必需输入会以 `required_input_missing` 失败，不会被当成成功跳过。人工同意只改变审核结果；若产物仍为空，恢复调度后由下游步骤明确失败。

恢复分为两类：

- **启动恢复（已实现）**：daemon 启动时扫描仍为 `running` 的 `WorkflowRun`，按租约判断是否接管，清理中断 attempt 后从持久化检查点继续；新鲜租约会在过期窗口后重试接管。
- **在线孤儿收敛（已实现）**：心跳循环每 15 秒比对持久化的 `running` 运行和内存 runner；本实例 runner 丢失时直接恢复，其它实例的新鲜租约会留到后续巡检，租约过期后再接管。用户停止步骤/任务时若 runner 已不存在，可直接收尾持久化状态、释放租约和并发槽位。

目标收敛规则是：任何非终态都必须拥有自动恢复路径，并至少保留停止或从步骤重跑的人工出口；强制收尾不得依赖内存 runner。完整转换、恢复边界与待补机制见[工作流引擎执行全景](workflow-engine-execution.md#状态机与兜底机制)。

### 协调助手状态机

协调助手不直接改写任务执行状态，而是使用三层独立持久化状态：

| 对象 | 主链路 | 含义 |
|---|---|---|
| `CoordinatorSession` | `active ↔ reset` | 可复用的引擎会话和摘要；换引擎/供应商时重置 |
| `CoordinatorTurn` | `queued → running → succeeded \| failed \| stopped` | 一次用户消息到协调回复的生命周期 |
| `ActionProposal` | `pending → executing → succeeded \| failed`<br>`pending → cancelled \| expired` | 需用户确认的副作用，与对话 turn 分离 |

daemon 启动时和运行期每 15 秒对齐 `CoordinatorTurn` 与内存调度任务：孤儿 `queued/running` turn 重新进入队列，并从持久化上下文重新执行；停止始终优先命中真正的 `running` turn，不会被后续 `queued` 消息遮蔽。即使内存引擎已不存在，停止也会直接将 turn 和助手消息收敛为 `stopped`。孤儿 `executing` 提案不会自动重放可能已发生的副作用，而是收敛为 `failed`，由用户重新发起。停止还会取消引擎待回答交互，并对引擎 `stop()` 设置超时上限。

## 步骤执行

任务创建、并发排队、DAG 调度、提示词、审核、产物路由、返回线、步骤消息、协调助手重跑和进程恢复的完整语义见[工作流引擎执行全景](workflow-engine-execution.md)。本节只保留架构主链路。

一次步骤执行的主链路是：

```text
WorkflowRuntime
  → TaskRunner 选择 ready 步骤
  → ArtifactRouter 按连接端口解析本轮动态输入快照
  → PromptAssembler 将快照投影为执行原因、有效输入、步骤要求和输出路由契约
  → AcpEngineBase 适配器运行 CLI / SDK / ACP / 进程内引擎
  → InternalEvent（ACP 对齐词汇）
  → JSONL 事件日志 + 消息摘要 + EventBus
  → AG-UI 翻译
  → WebSocket / 历史回放
  → ReviewGate
  → 通过、重试、等待人工审核或失败收尾
```

步骤支持独立执行会话和审核会话。能够恢复的引擎复用自己的会话标识；没有原生会话入口的引擎必须如实声明能力，由上层使用消息历史或引擎自己的持久化机制降级。

运行中的步骤可以接收普通用户消息。步骤消息使用 `channel=execution`，协调助手消息使用 `channel=coordinator`，两条流不会混入彼此的上下文。

步骤审核支持关闭、自动和人工模式。自动审核明确拒绝时可按配置重试执行步骤；审核 Agent 报错或返回无效结果时转人工审核，不把错误当作返工意见。人工审核会停在 `awaiting_review`，通过、驳回和强制通过均作用于明确的 `StepRun` / `ReviewRun`。

审核与路由是两个独立门：`skip` 只跳过审核，不跳过产物路由。步骤执行成功且审核通过（或配置为 `skip`）后，运行时才读取本轮 manifest 的端口状态；只有声明产物存在且大小大于 0 的输出端口会激活相连的下游。未产出、缺失或 0 字节输出不会激活连接，依赖这些连接的分支会一次性标记为 `skipped`，不会轮询重扫。

每次 `StepRun` 会持久化 `input_snapshot_json`。快照在运行时保留端口、连接、来源步骤、来源轮次、文件路径和大小；注入 LLM 时会移除端口序号、连接 ID 和其它调度标识，只保留执行原因与有效输入。返回线触发重跑时，目标步骤仍会同时取得其它已激活输入，例如开发步骤会同时收到原 PRD 和测试步骤返回的 Bug 列表。可恢复会话只接收本轮增量契约；无状态执行才重新发送完整上下文。

虚线是产物驱动的返回连接。其源端口产出非空文件后，目标步骤及其正向下游被回退重跑；画布流程中的审核驳回只重试当前步骤，不能绕过产物门控直接触发虚线。每个步骤通过 `maxReturnRounds` 独立设置其虚线返回连接最多可触发的次数，默认 3、允许 1–20；下一次超过配置上限时暂停流程。该配置与审核的 `review.maxRetries` 完全独立。若同一轮同时产出正向结果和返回结果，运行时按路由冲突暂停，避免一边交付一边返工。返回计数和活动连接持久化在 `WorkflowRun.routing_state_json`，重启和人工审核恢复不会重置上限。旧版 `steps/reworkUpstream` 定义仍保留原有的审核驱动返工语义。

## 产物轮次

步骤产物使用稳定的工作流、任务、步骤和轮次目录：

```text
.workstep/artifacts/<workflow>/<task>/<step>/<round>/
├── manifest.json
└── ...产物文件
```

`StepRun.artifact_round` 记录该步骤成功产物的轮次，`input_rounds_json` 记录本次执行显式选择的上游轮次，`input_snapshot_json` 保存实际注入引擎的端口级输入。失败、取消或中断的 attempt 不保留轮次目录；审核驳回但已经生成的产物轮次会保留，但不会成为下游默认输入。

下游默认选择每个依赖步骤最新的可继承轮次。用户也可以通过协调助手明确要求沿用某个历史轮次。legacy 步骤根目录按第 1 轮兼容读取，不自动搬迁。

manifest 除文件清单外，还为每个声明输出记录 `port`、`exists`、`size` 和 `nonempty`，目录大小按其内部普通文件合计。产物当前是文件与 manifest，不存在独立的 `artifacts` 数据表。列表、预览、审核、分享、协调助手和任务派发共用 `services/artifact_rounds.py` 的路径与选择规则；端口激活和返回限制集中在 `services/artifact_routing.py`。

## 引擎边界

引擎分成两层：

- `BaseLLMEngine`：WorkStep 特有的安装、版本、二进制解析、配置表单、模型枚举和能力声明。
- `AcpEngineBase`：统一的执行、会话、交互、审批、取消和协调器协议 seam。

所有引擎继承 `AcpEngineBase`。ACP 原生引擎复用基类客户端；CLI、SDK 和进程内引擎覆盖自己的传输实现，但仍产出 ACP 对齐事件。引擎由 `engines/core/registry.py` 自动发现，新增实现需要声明唯一 `ENGINE_ID`。

当前实现包括 Claude Code、Codex CLI、Hermes ACP、OpenClaw、Claude Agent SDK、Codex SDK、Qoder SDK、DeepSeek Harness 和内置 Pydantic AI。各引擎只声明真实具备的 capability 和 `acp_events`；没有原生来源的事件不能伪造。

目标模式通过统一助手入口的 `goal_mode` 和 `/goal` 命令进入引擎层，由 `supports_goal_mode` 声明原生能力。当前 Codex SDK 对接原生 Goal 生命周期（开始、暂停、恢复、清除和查询）；其他引擎不展示该模式，也不把目标文本伪装成普通提示词。Goal 不是标准 ACP session update，因此引擎产生 WorkStep 扩展 `goal_update`，外层统一翻译成 AG-UI `CUSTOM{name:"workstep.goal_update"}`，实时流和历史回放使用同一映射。

会话恢复与会话分叉是不同能力。当前 Codex SDK 映射官方 `thread_fork`；不支持原生分叉的引擎通过结构化跨引擎上下文交接创建新会话，绝不把旧引擎 session ID 交给新引擎。

Pydantic AI 是进程内引擎，固定挂载项目范围的 Coder 和 Skills。它通过 `StepPersistence`、`ConversationSearch`、`TieredCompaction` 和 `WarnNearLimits` 保存、检索并压缩上下文，因此不是“每次从零开始”。

更完整的接入规范见[引擎开发指南](llm-engine-development-guide.md)。

## 事件边界

内部事件的权威定义在 `apps/daemon/engines/core/events.py`：

- ACP 对齐内容事件：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`usage_update` 等。
- WorkStep 编排事件：`status`、`session_started`、`live_message`、`interaction_request`、`interaction_response`、`subagent`、`compacted`、`engine_state`、`error`、`a2ui` 和 `acp_raw`。

`engines/core/agui.py` 是唯一对外翻译层。WebSocket 实时事件与历史回放都通过它输出 AG-UI；前端 store 只消费 AG-UI，不直接解释引擎私有事件。

完整过程事件写入：

```text
.workstep/event_logs/task-<task_id>/<session_id>/<message_id>.jsonl
```

消息表只保存可见正文、必要摘要、`event_summary_json`、事件数量、末序号和 `event_log_path`。旧数据库没有日志路径时，继续通过 `events_json` 和 `map_legacy_event` 兼容回放。

## WebSocket

主事件通道为 `/ws`。连接后可发送：

```json
{
  "type": "subscribe",
  "task_ids": [],
  "status_only_task_ids": [],
  "session_ids": [],
  "channels": []
}
```

过滤在 EventBus 入队前执行，避免慢客户端接收无关事件。没有发送订阅消息的旧客户端仍保持全量广播兼容。

分享和远程项目使用各自的 WebSocket/代理边界，不把全局系统设置接口暴露给远端项目。

## 助手与会话

所有助手复用 `AssistantRuntime`。每个助手只提供自己的 system prompt、上下文构建、结构化结果校验和发布逻辑，并使用独立 channel：

- 会话聊天：`session_chat`
- AI 流程助手：独立流程生成 channel
- 任务创建助手：`task_create`
- 任务协调助手：`coordinator`

### 普通会话

普通会话按项目、流程、会话组织，执行目录为项目根目录，不自动创建任务或修改流程。消息独立保存在 `chat_sessions` 和 `chat_messages`，支持新建、改名、删除、排序、停止、引擎及 Provider 配置、分叉和跨引擎交接。完整事件使用 JSONL 日志，`events_json` 仅兼容旧记录。

`api/chat_session.py` 提供会话 CRUD、历史、聊天与停止接口，聊天使用 `Idempotency-Key` 防止重复提交；运行中删除或分叉会被拒绝。会话标识包含项目和会话范围，`session_chat` channel 与其它助手隔离。前端复用 `createAssistantStore`、`AssistantChatPanel` 和公共聊天控件。分叉和提示词查看的边界分别见[会话分叉方案](../plans/session-forking.md)和[助手提示词传输](../plans/assistant-prompt-transport.md)；测试入口为 `test_chat_session.py` 和 `test_api_contracts.py`。

### 协调助手

协调助手不能直接执行副作用。它生成持久化动作提案，只有用户确认、版本校验和幂等检查通过后，后端才会执行步骤补充、审核决定或从指定步骤重跑。`rerun_from_step` 可由协调助手按需携带 `payload.content`；确认后该内容会保存为目标步骤补充并注入本轮执行，目标步骤及其 DAG 下游步骤一起重跑。未携带 `content` 时仅重跑，不额外注入提示词。

局部重跑使用当前流程定义创建子运行；范围外已通过步骤以 `reused` StepRun 进入子运行。输入恢复优先采用该子运行明确记录的复用轮次，再回退到最新可继承轮次，避免旧 manifest 标记漂移导致目标步骤被错误跳过。没有连接的孤立步骤只在自身被选为重跑目标时执行，协调助手负责按需读取任务全局信息并将整理后的上下文作为步骤补充注入。

### 定时任务助手

定时任务保留静态建任务模式，同时支持任务创建助手的 headless 调用，不另建一套助手。`task_template_json.mode` 缺省为 `static`；`agent` 模式提供生成指令、候选流程及重试次数。候选为空表示全部有效流程，每次尝试使用新的内存会话。

`services/schedule.py` 调用 `task_draft.run_schedule`，通过共享运行时等待结构化结果，校验标题、内容、候选流程与起始步骤，再经 `create_project_task` 创建和派发任务。该调用不直接创建任务，不等待人工问答；单次尝试默认超时十分钟。重试耗尽时仅本次运行失败，下次调度仍有效。显式候选流程全部被删除时，计划置为无效。Agent 模式不使用静态模式的审核覆盖，助手会话不跨重启恢复。

前端计划页复用任务创建聊天组件，CLI 使用 `schedule create/update --mode agent --instruction ... --candidates ... --retry-count ...`；行为入口为 `test_schedule.py`、`test_task_draft.py`。

## 快捷按钮与脚本 Action

快捷按钮的现行字段以 `services/quick_buttons.py` 为准：`kind` 为 `prompt`、`display` 或 `action`，标题保存为 `label`。旧按钮缺少 `kind` 时按提示词按钮读取，`immediate_send` 默认关闭；展示按钮的 HTML 经白名单清洗，不执行脚本。

项目按钮保存在项目设置。流程顶层 `quickButtons` 保存流程自有按钮，`projectQuickButtonIds` 明确选择继承的项目按钮；旧流程只有在 `inheritProjectQuickButtons: true` 时才继承全部项目按钮。阶段按钮保存在节点 `quickButtons`，任务显示顺序为阶段、流程、继承的项目按钮，按稳定 ID 区分。任务读取当前流程配置，重新获得焦点时刷新按钮列表。

### 脚本、目录与运行输入

项目 Action 根目录为 `.workstep/actions/<action_id>/`；流程及阶段 Action 共用 `.workstep/artifacts/<workflow_id>/actions/<action_id>/`。按钮的 `script_path` 是该 Action 根目录内的相对文件路径。脚本选择和预览复用 `ProjectDirectoryBrowser` 及其文件编辑器，根目录始终限制在 Action 目录。

`action.json` 可选，用于声明解释器、参数、超时及停止宽限期；真正的入口脚本由按钮配置指定。服务端重新查找按钮、Action 和脚本，客户端不能提交任意命令、绝对脚本路径或 PID。路径规范化及包含关系检查拒绝目录、路径穿越和越界符号链接。

任务 Action 的 `cwd_mode` 支持 `project`、`task`、`worktrees`：后两者均从任务产物根目录启动，脚本通过 `.worktrees.json` 选择仓库。项目普通会话没有任务上下文时从项目根目录执行。新任务 Worktree 位于 `.workstep/artifacts/<workflow_id>/<task_id>/.worktrees/<alias>/`，旧 `.workstep/worktrees/<task_id>/` 只兼容解析、不自动搬迁。

运行时提供 `WORKSTEP_PROJECT_ROOT`、`WORKSTEP_WORKFLOW_ROOT`、`WORKSTEP_TASK_ROOT`、`WORKSTEP_ACTION_ROOT`、`WORKSTEP_WORKTREES_FILE`、`WORKSTEP_PROJECT_ID`、`WORKSTEP_WORKFLOW_ID`、`WORKSTEP_TASK_ID`、`WORKSTEP_STEP_KEY`、`WORKSTEP_ACTION_RUN_ID` 和确认输入 `WORKSTEP_ACTION_INPUT`。任务下 `.action-runs/<run_id>/` 保存运行日志；产物扫描忽略流程的保留目录 `actions/` 与任务下点号目录。

### 确认、去重与停止

Action 直接异步执行脚本，不调用 LLM。默认要求执行前确认；取消不创建消息或运行记录。需要确认的服务端配置要求请求携带 `confirmed: true`，配置确认输入时还需校验输入内容。

数据库 `ActionRun.active_key` 唯一约束保证同一任务、同一 Action 只有一个 `preparing/running/stopping` 运行；无任务的项目会话按项目与 Action 去重。并发重复请求返回已有 `run_id` 和 `deduplicated: true`，不创建第二个进程或消息。终态清空占位后才能再次执行。

运行输出持续更新同一条 Action 回复，保留运行目录、退出码与状态。进程按参数数组启动，stdout/stderr 异步分块读取；停止根据 `run_id` 定位进程组，先发送 SIGTERM，宽限期后使用 SIGKILL。脚本子服务必须留在该进程组内，脱离进程组的后台服务不能依赖停止按钮回收。

`api/action.py` 提供任务/会话按钮列表与运行、运行详情和停止接口；服务发布 `action_run_*` 生命周期与输出事件。当前页面由 `useActionRuns` 在活跃期间每 1.2 秒轮询恢复状态，终态停止轮询；daemon 重启后没有运行所有权的遗留记录按中断处理。行为入口为 `test_action_shortcuts.py`、`test_action_runtime.py`、Web `actionPolling.test.tsx` 和 `actionConfirmationInput.test.tsx`。

## 核心数据表

每个项目数据库的主要表包括：

- `tasks`、`task_steps`
- `workflows`、`workflow_runs`、`step_runs`、`review_runs`
- `messages`
- `chat_sessions`、`chat_messages`
- `pending_message_inserts`：按正在运行的 assistant Message ID 保存待插入内容；消费前不属于正式聊天记录，目标执行结束后按顺序合并为一条用户消息
- `coordinator_sessions`、`coordinator_turns`、`action_proposals`、`stage_supplements`
- `schedules`、`schedule_runs`
- `action_runs`：快捷脚本的消息关联、运行状态及并发占位
- `task_shares`；`channels` 与 `channel_chat_mappings` 为旧个人微信渠道的历史兼容表

- `project_settings`

企业微信智能机器人和钉钉 Stream 机器人通过 daemon 主动建立平台长连接。机器人凭证、默认项目及历史默认任务目标兼容配置、 `(机器人 ID, 群 ID) → 任务` 索引存放在全局配置；平台群消息经 `services/channels/bots.py` 路由到现有任务协调助手，默认项目消息复用项目渠道聊天会话。平台连接与 WorkStep 前端 `/ws` 是两套独立通道，配置和使用方式见[渠道机器人文档](channel-bots.md)。

完整集合以 `apps/daemon/models/__init__.py::ALL_MODELS` 为准。迁移器通过当前模型建表并使用 additive columns 收敛旧数据库；`LATEST_SCHEMA_VERSION = 0` 是 bootstrap 基线，不是累计迁移次数。

## 远程项目与公开分享

远程项目邀请使用 `workstep://remote-project/v1/...` 深链。邀请是一次性兑换凭据，设备授权可以撤销或设置期限；远端只获得指定项目范围内的任务、流程、会话、文件和实时状态访问，不获得主机全局设置权限。

公开任务分享与远程项目是两套边界：任务分享面向一个任务的受控查看和交互，远程项目面向另一台 WorkStep 设备的项目级访问。

Gateway 已接入平台账号、设备授权、远程项目及任务分享，开发和部署见[Gateway 开发文档](gateway-development.md)。平台模式仍有未完成验收，当前范围与剩余事项见[总方案](../plans/platform-mode.md)、[逐阶段计划](../plans/platform-gateway-development.md)和[剩余验收计划](../plans/platform-gateway-remaining-development.md)，不能把已有代码等同于整个平台完成交付。
