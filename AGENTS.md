# AGENTS.md

本文件为 Codex 在本项目中工作时提供指引。

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
- **助手架构**：所有新助手和后续助手能力扩展必须建立在同一套基础设施上，禁止复制会话、流式事件、停止、引擎配置或聊天 UI 实现。后端通过 `assistant_base.py` 的 `AssistantConfig` 注册并复用 `AssistantRuntime`，仅提供助手自己的 system prompt、上下文构建、结构化结果解析/校验和发布逻辑；创建态会话默认仅内存，需要跨重启恢复时才增加持久化适配器。前端通过 `createAssistantStore(config)` 创建配置实例，统一使用 `AssistantChatPanel`、`ChatMessageBubble`、`MessageMetaBar`、`MessageResponseFooter` 和 `ChatInput`；助手特有 UI 只通过组合插槽或薄包装组件扩展。每个助手必须使用独立 WebSocket `channel` 并按 channel 分流，结构化结果通过通用 store 的 `resultEvent` / `proposalEvent` 配置接入，不得让其它助手 store 接收。AI 流程助手统一用 `AiFlowChat`；方案选择必须呈现可点击的提案卡片（标题、步数、摘要、应用态）。新增助手必须覆盖会话隔离、结构化结果、停止、错误、无意外落库及既有助手回归测试。
- **聊天与 Markdown**：任务对话和 AI 流程助手共用上述聊天组件，不得覆盖 `ChatInput` 的统一高度或重复实现上传/粘贴。Markdown 图片上传至项目 `.workstep/uploads/`，正文保存项目相对路径，并由 `MarkdownMessage` 映射预览地址。
- **布局与样式**：复杂弹框顶部放表单，主区域占满余高、支持分隔拖动和弹框缩放；避免写死过矮高度。公共组件放入 modal 后须检查全局表单样式污染，必要时提高选择器特异性并人工核对。
- **状态与视觉**：异步处理中状态必须配持续旋转图标，结束、暂停或等待用户时停止。`ChatInput` 的发送/停止、附件选中态和配置菜单样式以组件现有实现为准，不在调用处另行定制。
- **图标按钮**：按钮直接内联 `svg`/`Icon` 时必须显式 `padding: 0`（或按设计给最小内边距），禁止依赖全局 `button` 默认 padding（`4px 8px`），否则固定尺寸按钮的内容区被压缩、图标被裁剪。
- **i18n**：新增文案先写 `zh-CN.ts`；其他词典可暂用中文占位，但键集合必须一致且非空（由 `apps/web/tests/i18n.test.ts` 校验）。

## 技术架构（已确定）

| 层 | 技术 | 说明 |
|---|---|---|
| Daemon | **Python + FastAPI** | 异步 API，SSE 推送，子进程管理 |
| ORM | **Peewee** | SQLite 友好，轻量 |
| 子进程 | **asyncio.subprocess** | 流式读取 LLM CLI stdout |
| SSE | **sse-starlette** | 全局单流推送 |
| 前端 | **待定** | 画布编辑器是核心约束 |
| 数据 | **per-project SQLite** | 每个项目独立 `.workstep/workstep.db` |

## 多引擎支持

所有引擎实现 `BaseLLMEngine` 接口，新增引擎 = 新增一个文件：

| 引擎 | stdin | stdout | 会话恢复 | 状态 |
|------|-------|--------|---------|------|
| Codex | JSONL 流（保持打开） | JSONL | `--resume` | P1 实现 |
| Codex CLI | 纯文本（写完关闭） | JSONL | 无 | P2 实现 |
| Hermes | JSON-RPC 双向 | JSON-RPC | 无 | P2 实现 |
| Claude / Codex / Qoder Agent SDK | 官方 SDK 进程内驱动 | 消息流 | 视 SDK | 已实现 |
| OpenClaw | 待调研 | 待调研 | 待定 | P5 实现 |
| Pydantic AI（内置 Agent） | 官方 SDK 进程内驱动，绑定供应商 base_url/key | 消息流 | 无 | 已实现 |

统一内部事件（`apps/daemon/engines/core/events.py`）：
- 执行流：`status`、`text_delta`、`thinking_delta`、`tool_use`、`tool_input_delta`（实时专用，不持久化）、`tool_result`、`usage`、`compacted`（上下文已自动压缩）、`error`
- 会话与交互：`session_started`（可复用引擎会话标识）、`live_message`（阶段中途插入消息）、`interaction_request`（权限申请 / 提问弹窗，ACP 语义）、`interaction_response`（弹窗用户回复）、`plan`（ACP 执行计划快照）、`subagent`（子代理 / 后台任务生命周期事件）、`engine_state`（进程内引擎状态快照）

## 数据模型

每个项目一个 `.workstep/workstep.db`，核心表：
- `tasks` — 任务（对应前端"卡片"）
- `task_steps` — 每阶段进度（支持并行分支）
- `messages` — LLM 消息 + events_json 事件流
- `agent_sessions` — 引擎会话（Codex --resume 用）
- `artifacts` — 产物记录
