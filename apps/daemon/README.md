# WorkStep Daemon

WorkStep 的本地后台服务，负责项目管理、工作流编排、LLM 引擎调用、运行状态持久化和实时事件推送。

## 架构

- **API 层**：FastAPI 提供 REST API 和 WebSocket。
- **服务层**：加载并执行工作流，处理任务、中途干预和项目生命周期。
- **引擎层**：通过统一接口接入 Claude Code、Codex、Hermes、Claude / Codex / Qoder Agent SDK、OpenClaw 和 API。
- **数据层**：Peewee 管理每个项目 `.workstep/workstep.db` 中的 SQLite 数据。
- **事件层**：EventBus 将任务状态、模型输出和工具调用实时推送给前端。

```text
Web / Client
  └─ FastAPI（REST + WebSocket）
       ├─ services/        业务逻辑与工作流运行时
       ├─ engines/         LLM 引擎适配
       ├─ models/          Peewee 数据模型
       ├─ schemas/         Pydantic API Schema
       └─ streaming/       实时事件总线
```

## 目录

```text
api/          路由与接口
services/     业务逻辑、DAG 调度与任务执行
engines/      LLM 引擎及 ACP/CLI/API 适配
models/       Peewee 模型和数据库迁移
schemas/      API 请求、响应 Schema
streaming/    实时事件
tests/        后端测试
scripts/      引擎和工作流冒烟脚本
```

## 开发

要求 Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)。

```bash
cd apps/daemon
uv sync --dev
uv run uvicorn main:app --reload --port 8765

# 可选：指定 config.json 及全局数据所在目录（默认 ~/.workstep/）
WORKSTEP_CONFIG_DIR=/path/to/workstep-device-b uv run uvicorn main:app --reload --port 8766
```

运行测试：

```bash
uv run pytest
```

## 开发规范

- API 请求、响应等 Pydantic 类型统一继承 `from schemas.base import BaseSchema`，业务代码不要直接使用 `pydantic.BaseModel`。
- 数据库模型继承 `from models.base import BaseModel`，避免与 Pydantic 的同名类型混淆。
- 路由只处理接口逻辑，业务逻辑放在 `services/`；可复用的 API Schema 放在 `schemas/`。
