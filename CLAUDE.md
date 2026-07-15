# CLAUDE.md

本文件为 Claude Code 在本项目中工作时提供指引。

## 项目概述

本仓库包含 **WorkStep** 的设计原型与技术文档——一个本地优先的工作流编排工具，将多个 LLM 引擎（Claude Code、Codex CLI、Hermes ACP 等）串联为可定制的研发管道。

当前项目不是可运行的应用，包含：
- 静态 HTML 原型（无需构建）
- 产品需求与技术架构文档
- 示例数据结构

## 目录结构

```
ui/              # 前端原型（浏览器直接打开）
docs/            # 产品文档（PRD、引擎协议设计）
plans/           # 技术架构文档（按功能拆分）
steps.json       # 示例工作流定义
cards.json       # 示例任务数据
CLAUDE.md        # 本文件
```

## 查看原型

浏览器直接打开 `ui/` 下的 HTML 文件：
- `ui/index.html` — 主面板（任务列表 + 看板视图）
- `ui/canvas-editor.html` — Dify 风格节点画布编辑器
- `ui/card-detail.html` — 任务详情（阶段时间线 + LLM 对话）
- `ui/ai-research-harness.html` — 备选界面

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
| Claude Code | JSONL 流（保持打开） | JSONL | `--resume` | P1 实现 |
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
- `agent_sessions` — 引擎会话（Claude --resume 用）
- `artifacts` — 产物记录

详见 `plans/03-data-model.md`。

## 构建阶段

| 阶段 | 范围 |
|------|------|
| P1 | 单引擎（Claude）+ 线性管道 + 极简前端 |
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
