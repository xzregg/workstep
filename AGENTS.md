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

- 禁止使用原生 `window.alert()` / `window.confirm()` 弹窗；确认类交互一律使用通用组件 `apps/web/src/components/ConfirmDialog.tsx`（删除、离开/切换前有未保存更改等场景）。
- 表单必填校验：必填项为空时「提交/创建」按钮不置灰；点击后在弹框内提示具体缺失字段（如「流程名称为必填项，请输入流程名称」）并聚焦对应输入框，不使用原生 alert/confirm。校验提示放在**固定高度区域**（如 `minHeight` 占位）里，避免提示出现/消失导致布局上下跳动；不要把提示塞进输入框 `title` 或插入 DOM 挤压布局。
- 侧边滑出面板（新建任务、编辑记忆等）：内容未变更时，点击面板外部（遮罩）直接关闭；内容有未保存变更时，必须先经 `ConfirmDialog` 确认（放弃更改）才可关闭。
- 新建 / 重命名项目与工作流的名称禁止包含空白字符（空格、Tab 等），前端输入即时校验，后端 schema 同样强制。
- 新建流程默认为空白画布（`{ nodes: [], connections: [] }`），不自动加载默认模板；需要模板时由用户从「流程模板」下拉选择。流程模板统一存放在 `~/.workstep/data/templates/*.json`：daemon 启动时把随产品发布的 `apps/daemon/data/templates/*.json` 复制过去（同名不覆盖，保留用户改动），全局模板的读取与编辑保存均以 `~/.workstep/data/templates/` 为准。每个模板文件带 `id` / `name` / `description` / `steps` 元数据；随产品发布的默认模板额外带 `default: true`（不可删除），用户自建模板无该标记。
- AI 流程生成：`apps/web/src/components/AiFlowChat.tsx` 是复用的 AI 流程助手聊天组件（「添加流程」弹框左侧与流程编辑器工具栏「AI 编辑」浮层共用），通过 `POST /api/workflow/generate/chat`（后端 `apps/daemon/services/workflow_gen.py`，内存会话、不写任务库）与协调引擎多轮对话生成画布 JSON；`flow_proposal` 事件经全局 WebSocket 以 `session_id`（无 `task_id`）推送到 `apps/web/src/stores/workflowGenStore.ts`，前端渲染进可编辑画布预览（`FlowCanvas` 通过 ref 暴露 `getSteps()` / `validate()` / `loadSteps()`）。AI 助手消息/气泡/元信息/底部统计一律复用任务对话的公共组件（见下方 LLM 消息组件统一条目）；让用户选择方案时必须返回**可点选的提案卡片列表**（标题 + 步数 + 摘要 + 应用态），不要用纯文本段落替代。
- 任务说明等任何 markdown 富文本**编辑**一律使用通用组件 `apps/web/src/components/MarkdownEditor.tsx`（编辑/预览切换 + 图片粘贴/插入）；纯展示用 `apps/web/src/components/MarkdownMessage.tsx`。禁止自建 textarea + 图片上传的重复实现。图片经 `/api/fs/upload/image` 上传到项目 `.workstep/uploads/`，markdown 中以项目相对路径 `项目名/.workstep/uploads/<uuid>.<ext>` 存储（对 LLM prompt 有意义），预览时由 `MarkdownMessage` 自动映射回 `/api/fs/serve/...`。
- LLM 消息组件统一：所有对话/消息渲染（任务对话 `apps/web/src/pages/TaskDetail.tsx` 的历史消息、实时协调消息、实时阶段执行消息、旧执行消息，以及 AI 流程助手 `apps/web/src/components/AiFlowChat.tsx`）一律由三个共享组件组合渲染，禁止在页面里另写气泡、状态栏或底部统计：
  - 气泡：`apps/web/src/components/ChatMessageBubble.tsx`（头像 + 气泡 + 元信息栏/提案卡片插槽 + 加载/错误态；用户消息右侧、助手/系统/审核消息左侧）；
  - 元信息栏：`apps/web/src/components/MessageMetaBar.tsx`（时间 + 过程轨迹 + 会话 ID 复制 + 查看提示词）；
  - 底部统计：`apps/web/src/components/MessageResponseFooter.tsx`（Token/引擎/模型 + 复制按钮）。
  后续样式调整只改上述组件一处即可全局生效；新增消息类型（如审核、提案）也应复用这三个组件。
- 聊天输入框统一使用 `apps/web/src/components/ChatInput.tsx`，设计参照 Codex composer：一个圆角边框容器内包含自适应 textarea + 底部工具行（左侧图片上传/粘贴按钮，右侧引擎/模型选择胶囊 + 发送/停止按钮），聚焦时容器显示 accent 边框与光环，含 Enter 发送、生成中旋转加载；任务对话与 AI 流程助手必须共用，禁止在页面里另写一套输入框样式、图片上传或粘贴逻辑。引擎/模型选择弹出菜单内容用公共组件 `apps/web/src/components/CoordinatorConfigBar.tsx`（内部负责拉取引擎模型列表），两处聊天通过 `ChatInput` 的 `config` prop 传入各自的选择状态与回调（任务详情持久化到任务协调配置，AI 流程助手仅会话级覆盖）；图片上传通过 `imageAttach` prop 传入 `projectId`/`prefix`/`onError`。两处输入框高度由 `ChatInput` 统一默认值（`rows=1, minHeight=40, maxHeight=120`），调用方不得再单独覆盖。
- 弹框布局（添加流程等）：表单/名称放顶部，主内容区（如聊天 + 画布预览）占满剩余高度且可拖动分隔条调整比例；弹框应支持右下角拖拽缩放；内容高度不足时优先保证可用高度，不要给输入区写死过矮的高度。
- 全局样式污染防护：在 `.modal` / `.modal-body` 等受全局表单样式影响的作用域内使用公共组件时，先检查全局 `label / input / select / textarea` 选择器是否会覆盖组件样式（例：`.modal-body label` 的 `display:block; margin` 会把 `ChatInput` 图片按钮挤错位）；公共组件关键样式用高特异性选择器防御（如 `.modal-body label.chat-input-attach`），并在改动后于 modal 场景内人工核对。
- 聊天输入细节（`ChatInput.tsx`）：
  - 聊天输入发送/停止图标：发送按钮为 **30px 圆形**；发送图标使用 Lucide 风格 send 图标（13px SVG，`viewBox="0 0 24 24"`，`fill="none"` + `stroke="currentColor"` `strokeWidth=1.6`，路径 `M22 2 11 13` 与 `m22 2-7 20-4-9-9-4z`）；停止时用 12px 圆角方块（CSS div + `currentColor`）；生成中显示旋转 spinner；按钮与输入框底部对齐，避免「按钮对不齐 / 图标太小」；
  - 图片上传按钮选中态：输入内容已含 `![图片](...)` 时按钮显示 accent 色 + 右下角对勾徽标，图标保持描边、不要填充成实心；
  - 引擎/模型弹层（`CoordinatorConfigBar` menu 变体）用「左标签 + 右下拉」行布局：标签（引擎/推理/快速/图片理解）常驻、下拉不占满整行宽度，用户选中后仍能看出每行含义。
- 复用一致性原则：同一 UI 出现在两处及以上（聊天输入、LLM 消息、引擎/模型配置、图片上传、提案卡片）必须抽公共组件并统一默认值；新功能先复用现有公共组件，改一处全局生效，禁止在页面里复制实现导致两处漂移（例：输入框高度曾因一处传 `rows=2`、一处用默认值而不一致）。
- 前端展示「进行中」「审核中」等异步处理中状态时，状态文字旁必须显示持续旋转的加载图标，明确反馈任务仍在执行；任务结束、暂停或等待用户操作后停止旋转。

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
| API 直调 | HTTP POST | SSE 流式 | 无 | P5 实现 |

统一内部事件：`text_delta`、`thinking_delta`、`tool_use`、`tool_result`、`usage`、`compacted`（上下文已自动压缩）、`error`、`status`。

## 数据模型

每个项目一个 `.workstep/workstep.db`，核心表：
- `tasks` — 任务（对应前端"卡片"）
- `task_steps` — 每阶段进度（支持并行分支）
- `messages` — LLM 消息 + events_json 事件流
- `agent_sessions` — 引擎会话（Codex --resume 用）
- `artifacts` — 产物记录
