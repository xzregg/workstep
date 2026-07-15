# WorkStep 技术架构总览

> 本地优先的多引擎 LLM 工作流编排工具

---

## 产品定位

面向独立开发者 / 小团队的本地工作流编排工具。把多步骤流程（需求 → 设计 → 前端 → 后端 → 测试 → 上线）抽象为可编排管道，每个阶段调用本地 LLM 引擎执行。

## 整体架构

```
┌─────────────────────────────────────────────────────┐
│  前端 (浏览器 / .app 壳 / CLI)                         │
│  - 画布编辑器 / 任务列表 / 详情页                        │
│  - 消费 WebSocket，按 projectId + taskId 路由             │
└──────────────────────┬──────────────────────────────┘
                       │ WebSocket (双向) + REST /api/*
┌──────────────────────▼──────────────────────────────┐
│  Daemon (FastAPI + Peewee)                            │
│  - 多项目管理（扫描 .workstep/ 注册）                    │
│  - 全局事件总线 → WebSocket 双向推送                       │
│  - 引擎抽象层 (BaseLLMEngine)                          │
│  - asyncio.subprocess spawn 子进程                     │
│  - 每项目独立 SQLite 连接                                │
└──────────────────────┬──────────────────────────────┘
                       │ spawn + stdin/stdout 管道
        ┌──────┬───────┼───────┬──────────┐
        ▼      ▼       ▼       ▼          ▼
    claude   codex   hermes  qcode    api直调
    -p       exec    acp     ...      (后期)
```

## 技术栈

| 层 | 技术 | 理由 |
|---|---|---|
| Daemon | **Python + FastAPI** | 异步 API，WebSocket 支持成熟 |
| ORM | **Peewee** | 轻量，SQLite 友好 |
| 子进程 | **asyncio.subprocess** | 异步流式读取 stdout |
| 实时通信 | **WebSocket** (fastapi) | 双向，中途干预无需额外 HTTP |
| 前端 | **React + React Flow + Volta** | 画布编辑器核心约束 |
| 数据 | **per-project SQLite** | 项目隔离，可移动/复制/删除 |

## 项目结构

```
workstep/
├── apps/
│   ├── daemon/                    # Python + FastAPI
│   │   ├── pyproject.toml         # uv 管理
│   │   ├── main.py                # FastAPI 入口
│   │   ├── settings.py            # pydantic-settings 配置
│   │   ├── api/                   # 路由层
│   │   │   ├── project.py         # /api/project/*
│   │   │   ├── task.py            # /api/task/*
│   │   │   ├── engine.py          # /api/engine/*
│   │   │   ├── pipeline.py        # /api/pipeline/*
│   │   │   ├── run.py             # /api/run/*
│   │   │   └── ws.py              # /ws (WebSocket)
│   │   ├── schemas/               # Pydantic 请求/响应模型
│   │   ├── models/                # Peewee ORM
│   │   ├── services/              # 业务逻辑
│   │   │   ├── project.py         # 项目管理
│   │   │   ├── task.py            # 任务 CRUD + 状态机
│   │   │   ├── pipeline.py        # DAG 调度 + TaskRunner
│   │   │   └── prompt.py          # Prompt 拼接
│   │   ├── engines/               # LLM 引擎层
│   │   │   ├── base.py            # BaseLLMEngine 抽象（不变）
│   │   │   ├── events.py          # InternalEvent 统一事件
│   │   │   ├── registry.py        # 引擎注册表 + 解析策略
│   │   │   ├── claude_code.py     # Claude 直接 CLI
│   │   │   ├── claude_code_acp.py # Claude ACP 模式
│   │   │   ├── codex.py           # Codex 直接 CLI
│   │   │   ├── codex_acp.py       # Codex ACP 模式
│   │   │   ├── qoder_acp.py       # Qoder ACP 模式
│   │   │   └── hermes.py          # Hermes JSON-RPC
│   │   ├── streaming/
│   │   │   ├── bus.py             # EventBus 全局事件总线
│   │   │   └── parsers/           # 非 ACP 引擎的 stdout 解析
│   │   ├── db/migrations/         # Schema 迁移
│   │   └── tests/
│   │
│   └── web/                       # React + Vite + React Flow
│       ├── package.json           # Volta: node@20, yarn@1
│       ├── vite.config.ts         # dev proxy → daemon:8765
│       └── src/
│           ├── hooks/
│           │   └── useWebSocket.ts # WS 连接 + 断线重连
│           ├── stores/            # Zustand 状态管理
│           └── pages/
│               ├── dashboard.tsx
│               ├── canvas.tsx
│               └── detail.tsx
│
├── docs/                          # 产品文档
├── plans/                         # 技术架构文档
└── ui/                            # 静态 HTML 原型（参考用）
```

## 多项目模型

每个项目 = 一个本地目录，含 `.workstep/`：

```
project-a/
  .workstep/
    steps.json          # 工作流定义（DAG）
    workstep.db         # 该项目的 SQLite（tasks, messages, ...）
    artifacts/          # 产物文件
      req/<taskId>/prd.md
      ui/<taskId>/design-spec.md
      ...

project-b/
  .workstep/
    steps.json
    workstep.db         # 完全独立
    artifacts/
      ...
```

Daemon 维护一个全局项目注册表（内存），启动时扫描已注册路径，打开各项目的 `.db`。

## 消息分发

**WebSocket 双向通信**：所有项目、所有任务的事件走一条 WebSocket 连接。

```
// 前端连接
const ws = new WebSocket('ws://localhost:8765/ws');

// Server → Client 事件
{ "type": "task_event", "project": "/path/project-a", "taskId": "abc",
  "step": "frontend", "event": "text_delta", "delta": "..." }

{ "type": "task_status", "project": "/path/project-a", "taskId": "abc",
  "step": "frontend", "status": "running" }

// Client → Server 指令（中途干预、权限响应等）
{ "type": "respond", "run_id": "...", "data": { "answer": "yes" } }
{ "type": "cancel", "run_id": "..." }
```

前端收到后按 `project + taskId` 路由到对应 UI 组件。断线自动重连（指数退避）。

## 构建顺序

| 阶段 | 范围 | 目标 |
|------|------|------|
| **P1 单引擎线性管道** | Daemon + ClaudeCodeEngine + 线性步骤 + 极简 Web | 一个任务从头跑到尾 |
| **P2 多引擎** | CodexEngine + HermesEngine + 引擎选择 | 三种引擎可切换 |
| **P3 管道编排** | 画布编辑器 + DAG 调度 + 并行分支 + 产物衔接 | 阶段间自动流转 |
| **P4 干预与回溯** | 中途回答 + 会话恢复 + 历史回放 | 完整交互 |
| **P5 扩展** | QCode / OpenClaw / API 直调 + 团队 | 生态扩展 |

## 子文档索引

| 文档 | 内容 |
|------|------|
| [01-daemon.md](01-daemon.md) | Daemon 架构、API 路由、SSE、项目管理 |
| [02-engine-abstraction.md](02-engine-abstraction.md) | BaseLLMEngine 接口、各引擎实现 |
| [03-data-model.md](03-data-model.md) | SQLite schema、Peewee 模型、持久化 |
| [04-pipeline.md](04-pipeline.md) | 工作流编排、DAG 调度、产物衔接 |
| [05-frontend.md](05-frontend.md) | 前端技术选型、页面结构（待定） |
| [06-build-order.md](06-build-order.md) | 分阶段构建计划、每阶段验收标准 |
