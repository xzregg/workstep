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
- 新建 / 重命名项目与工作流的名称禁止包含空白字符（空格、Tab 等），前端输入即时校验，后端 schema 同样强制。
- 新建流程默认为空白画布（`{ nodes: [], connections: [] }`），不自动加载默认模板；需要模板时由用户从「流程模板」下拉选择（内置模板 + `apps/daemon/data/templates/` 下的自定义模板，均带 `id` / `name` / `description` / `steps` 元数据）。
- 任务说明等任何 markdown 富文本**编辑**一律使用通用组件 `apps/web/src/components/MarkdownEditor.tsx`（编辑/预览切换 + 图片粘贴/插入）；纯展示用 `apps/web/src/components/MarkdownMessage.tsx`。禁止自建 textarea + 图片上传的重复实现。图片经 `/api/fs/upload/image` 上传到项目 `.workstep/uploads/`，markdown 中以项目相对路径 `项目名/.workstep/uploads/<uuid>.<ext>` 存储（对 LLM prompt 有意义），预览时由 `MarkdownMessage` 自动映射回 `/api/fs/serve/...`。
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
| QCode / OpenClaw | 待调研 | 待调研 | 待定 | P5 实现 |
| API 直调 | HTTP POST | SSE 流式 | 无 | P5 实现 |

统一内部事件：`text_delta`、`thinking_delta`、`tool_use`、`tool_result`、`usage`、`error`、`status`。

## 数据模型

每个项目一个 `.workstep/workstep.db`，核心表：
- `tasks` — 任务（对应前端"卡片"）
- `task_steps` — 每阶段进度（支持并行分支）
- `messages` — LLM 消息 + events_json 事件流
- `agent_sessions` — 引擎会话（Codex --resume 用）
- `artifacts` — 产物记录

详见 `plans/03-data-model.md`。

## 构建阶段

| 阶段 | 范围 |
|------|------|
| P1 | 单引擎（Codex）+ 线性管道 + 极简前端 |
| P2 | 多引擎（+Codex +Hermes） |
| P3 | DAG 编排 + 画布编辑器 + 并行分支 |
| P4 | 中途干预 + 历史回放 + 产物版本 |
| P5 | 更多引擎 + API 直调 |

详见 `plans/06-build-order.md`。

## 文档索引

| 文档 | 内容 |
|------|------|
| `docs/prd.md` | 产品需求文档 |
| `docs/run_llm.md` | LLM 引擎调用协议设计 |
| `docs/drawio.xml` | 架构图源文件 |
| `plans/00-architecture-overview.md` | 技术架构总览 |
| `plans/01-daemon.md` | Daemon 架构与 API |
| `plans/02-engine-abstraction.md` | 引擎抽象层 |
| `plans/03-data-model.md` | 数据模型与 Schema |
| `plans/04-pipeline.md` | 工作流编排 |
| `plans/05-frontend.md` | 前端设计（待定） |
| `plans/06-build-order.md` | 构建计划 |
