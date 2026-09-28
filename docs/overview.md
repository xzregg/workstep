# WorkStep 项目概览

面向新接触本仓库的开发者，帮助在 10 分钟内建立整体认知。

## 项目简介

WorkStep 是一个本地优先（local-first）的工作流编排工具，将多种 CLI、SDK 与 ACP 形态的 LLM 引擎串联为可视化、可复用的研发管道。所有项目与执行数据保存在本机。

核心能力：

- 每项目独立 SQLite 存储，数据、产物与事件日志不出本机
- 可视化工作流画布：并行步骤、动态路由、可复用模板
- 多引擎统一执行与事件模型（CLI / SDK / ACP / 进程内）
- 任务实时输出、工具审批、暂停/恢复与会话恢复
- 定时任务，以及按需启用的远程项目与任务分享

## 技术架构

| 子应用 | 职责 | 技术栈 |
| --- | --- | --- |
| `apps/daemon` | 核心后端：REST API（8765 端口）、WebSocket 事件、引擎适配、任务调度 | Python 3.11+、FastAPI、Peewee/SQLite、uvicorn、pydantic-ai |
| `apps/web` | 主界面：项目、工作流画布、任务、设置 | React 19、TypeScript、Vite、Zustand、Antd、@xyflow/react |
| `apps/desktop` | 桌面壳：窗口、安装包、自动更新；内嵌独立 Python runtime 运行 daemon sidecar | Electron、electron-builder |
| `apps/landing` | 产品介绍页，构建后由 daemon 托管在 `/landing` | Vite、React |
| `apps/android` | Android 壳，经 HTTPS 加载 web 移动版页面 | Android (JDK 17 / SDK 35) |

相互关系：`web` 是 `daemon` 的主界面；`desktop` 将 web 构建产物与 daemon 一起打包进 Electron；`android` 复用 web 移动端页面。

每个项目在自己的目录下保存运行数据（`<project>/.workstep/`）：`project.json` 项目标识、`workstep.db` 项目数据库、`artifacts/` 步骤产物、`event_logs/` 消息 JSONL 事件日志、`skills/` 技能镜像、`MEMORY.md` 项目记忆。

## 核心概念

| 术语 | 说明 |
| --- | --- |
| 项目（Project） | 顶层组织单位，对应一个目录与一个 SQLite 数据库 |
| 工作流（Workflow） | 流程定义，画布上的节点与连线；后端校验并编译为执行 DAG，可按模板创建 |
| 任务（Task） | 绑定工作流的一次具体工作项，持有输入与总体状态 |
| 引擎（Engine） | LLM 执行后端适配器，覆盖 CLI（Claude Code、Codex、OpenClaw）、SDK（Cursor、Qoder 等）、ACP（Hermes、OpenCode）与进程内（Pydantic AI）四类传输；可选 SDK 在设置页按需安装 |
| 步骤（Step） | 工作流中的节点，定义单次引擎执行的提示词、输入与输出路由 |
| 运行记录 | `WorkflowRun` / `StepRun` / `ReviewRun` 为追加式执行历史；`TaskStep` 是每步当前状态投影 |

## 快速开始

要求：Python 3.11+、[uv](https://docs.astral.sh/uv/)、Node.js 20 或 22（含 Corepack）。

方式一，仓库根目录一键启动（daemon + 前端 dev server）：

```bash
git clone https://github.com/xzregg/workstep.git && cd workstep
./start.sh
```

打开 `http://127.0.0.1:5173` 即可使用；daemon API 在 8765 端口（`/docs` 可查 API 文档）。停止服务运行 `./stop.sh`。

方式二，分步启动：

```bash
cd apps/daemon && uv sync --dev
uv run --no-sync uvicorn main:app --reload --port 8765
cd apps/web && corepack yarn install --frozen-lockfile && corepack yarn dev
```

注意：在设置页安装可选引擎 SDK 后，重启 daemon 请继续使用 `uv run --no-sync`，避免 `uv sync` 卸载已安装的引擎包。

## 文档导航

- [架构](architecture.md) — 运行形态、数据所有权、事件流与核心数据表
- [多引擎架构](multi-engine-architecture.md) — 引擎基类、自动发现、能力声明与引擎清单
- [工作流引擎执行](workflow-engine-execution.md) — 任务创建、DAG 调度、审核、重跑与恢复
- [引擎运行时管理](engine-runtime-management.md) — 引擎 SDK 版本选择、下载与回滚
- [LLM 引擎开发指南](llm-engine-development-guide.md) — 接入新引擎的步骤
- [开发指南](development.md) — 环境搭建、测试命令与代码约定
- [项目技能中心](skill-center.md) — 技能发现、选择与引擎隔离
- [发布清单](releasing.md) — 桌面打包、SBOM 与校验流程
