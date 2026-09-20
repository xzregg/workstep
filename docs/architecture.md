# WorkStep 架构

本文描述当前可运行实现。具体接口和字段发生冲突时，以代码、测试和根目录 `AGENTS.md` 为准；功能设计与历史实施记录位于 [`plans/`](../plans/README.md)。

## 运行形态

WorkStep 由五个可独立维护的应用组成：

| 应用 | 技术 | 职责 |
|---|---|---|
| `apps/daemon` | Python、FastAPI、Peewee | REST、WebSocket、项目数据库、工作流编排、引擎和助手运行时 |
| `apps/web` | React、TypeScript、Vite、Zustand | 任务、流程画布、聊天、设置和实时状态 UI |
| `apps/desktop` | Electron | 启动内置 Python 后端、加载 Web UI、桌面协议和更新 |
| `apps/landing` | React、Vite | 产品官网 |
| `apps/wechat-bridge` | Node.js | 微信渠道桥接 |

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
- `artifacts/` 保存阶段产物、轮次目录和 manifest。
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

前端画布保存节点和连线；后端 `WorkflowDefinition` 负责加载、校验并编译为执行用 DAG。每次运行把流程 schema 版本和完整快照写入 `workflow_runs`，因此运行中的任务不受后续画布编辑影响。

```text
Task
└── WorkflowRun（一次流程运行，持有不可变流程快照）
    ├── StepRun（阶段执行 attempt）
    └── ReviewRun（阶段审核 attempt）
```

`TaskStep` 是每个阶段的当前状态投影；`WorkflowRun`、`StepRun` 和 `ReviewRun` 保存执行历史。`TaskRunner` 根据依赖关系并行启动 ready 阶段，汇合节点只有在所有依赖通过后才会执行。

任务并发和助手对话并发由 `ConcurrencyGate` 分通道管理，可配置全局值和项目覆盖值。定时任务可选择豁免任务并发限制。

## 阶段执行

一次阶段执行的主链路是：

```text
WorkflowRuntime
  → TaskRunner 选择 ready 阶段
  → PromptAssembler 组装系统指令、任务说明、阶段要求和上游产物
  → AcpEngineBase 适配器运行 CLI / SDK / ACP / 进程内引擎
  → InternalEvent（ACP 对齐词汇）
  → JSONL 事件日志 + 消息摘要 + EventBus
  → AG-UI 翻译
  → WebSocket / 历史回放
  → ReviewGate
  → 通过、重试、等待人工审核或失败收尾
```

阶段支持独立执行会话和审核会话。能够恢复的引擎复用自己的会话标识；没有原生会话入口的引擎必须如实声明能力，由上层使用消息历史或引擎自己的持久化机制降级。

运行中的阶段可以接收普通用户消息。阶段消息使用 `channel=execution`，协调助手消息使用 `channel=coordinator`，两条流不会混入彼此的上下文。

阶段审核支持关闭、自动和人工模式。自动审核失败可以按配置重试；人工审核会停在 `awaiting_review`，通过、驳回和强制通过均作用于明确的 `StepRun` / `ReviewRun`。

## 产物轮次

阶段产物使用稳定的工作流、任务、阶段和轮次目录：

```text
.workstep/artifacts/<workflow>/<task>/<step>/<round>/
├── manifest.json
└── ...产物文件
```

`StepRun.artifact_round` 记录该阶段成功产物的轮次，`input_rounds_json` 记录本次执行显式选择的上游轮次。失败、取消或中断的 attempt 不保留轮次目录；审核驳回但已经生成的产物轮次会保留，但不会成为下游默认输入。

下游默认选择每个依赖阶段最新的可继承轮次。用户也可以通过协调助手明确要求沿用某个历史轮次。legacy 阶段根目录按第 1 轮兼容读取，不自动搬迁。

产物当前是文件与 manifest，不存在独立的 `artifacts` 数据表。列表、预览、审核、分享、协调助手和任务派发共用 `services/artifact_rounds.py` 的路径与选择规则。

## 引擎边界

引擎分成两层：

- `BaseLLMEngine`：WorkStep 特有的安装、版本、二进制解析、配置表单、模型枚举和能力声明。
- `AcpEngineBase`：统一的执行、会话、交互、审批、取消和协调器协议 seam。

所有引擎继承 `AcpEngineBase`。ACP 原生引擎复用基类客户端；CLI、SDK 和进程内引擎覆盖自己的传输实现，但仍产出 ACP 对齐事件。引擎由 `engines/core/registry.py` 自动发现，新增实现需要声明唯一 `ENGINE_ID`。

当前实现包括 Claude Code、Codex CLI、Hermes ACP、OpenClaw、Claude Agent SDK、Codex SDK、Qoder SDK、DeepSeek Harness 和内置 Pydantic AI。各引擎只声明真实具备的 capability 和 `acp_events`；没有原生来源的事件不能伪造。

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

会话聊天数据保存在 `chat_sessions` 和 `chat_messages`，支持停止、引擎配置、分叉和跨引擎交接。完整事件同样使用 JSONL 日志，`events_json` 仅兼容旧记录。

协调助手不能直接执行副作用。它生成持久化动作提案，只有用户确认、版本校验和幂等检查通过后，后端才会执行阶段补充、审核决定或从指定阶段重跑。`rerun_from_stage` 可由协调助手按需携带 `payload.content`；确认后该内容会保存为目标阶段补充并注入本轮执行，目标阶段及其 DAG 下游阶段一起重跑。未携带 `content` 时仅重跑，不额外注入提示词。

## 核心数据表

每个项目数据库的主要表包括：

- `tasks`、`task_steps`
- `workflows`、`workflow_runs`、`step_runs`、`review_runs`
- `messages`
- `chat_sessions`、`chat_messages`
- `coordinator_sessions`、`coordinator_turns`、`action_proposals`、`stage_supplements`
- `schedules`、`schedule_runs`
- `task_shares`、`channels`
- `project_settings`

完整集合以 `apps/daemon/models/__init__.py::ALL_MODELS` 为准。迁移器通过当前模型建表并使用 additive columns 收敛旧数据库；`LATEST_SCHEMA_VERSION = 0` 是 bootstrap 基线，不是累计迁移次数。

## 远程项目与公开分享

远程项目邀请使用 `workstep://remote-project/v1/...` 深链。邀请是一次性兑换凭据，设备授权可以撤销或设置期限；远端只获得指定项目范围内的任务、流程、会话、文件和实时状态访问，不获得主机全局设置权限。

公开任务分享与远程项目是两套边界：任务分享面向一个任务的受控查看和交互，远程项目面向另一台 WorkStep 设备的项目级访问。

未来的平台登录、多用户权限和平台数据库方案仍处于提案阶段，见 [`plans/platform-mode.md`](../plans/platform-mode.md)，不属于当前产品能力。
