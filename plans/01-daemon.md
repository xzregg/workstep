# Daemon 架构

## 目录结构

按层拆分，URL 路径直接映射到文件 + 函数：

```
daemon/
├── main.py                # FastAPI 入口，注册所有 router
├── settings.py            # pydantic-settings 全局配置
│
├── api/                   # 路由层（URL path → 文件 → 函数）
│   ├── project.py         #   /api/project/*
│   ├── task.py            #   /api/task/*
│   ├── engine.py          #   /api/engine/*
│   ├── pipeline.py        #   /api/pipeline/*
│   ├── message.py         #   /api/message/*
│   ├── run.py             #   /api/run/*
│   └── streaming.py       #   /api/events (SSE)
│
├── schemas/               # Pydantic 请求/响应模型
│   ├── base.py            #   BaseSchema
│   ├── project.py
│   ├── task.py
│   ├── engine.py
│   ├── pipeline.py
│   └── message.py
│
├── models/                # Peewee 数据库模型
│   ├── base.py            #   BaseModel + db_proxy
│   ├── task.py            #   Task, TaskStep
│   ├── message.py         #   Message
│   ├── artifact.py        #   Artifact
│   └── session.py         #   AgentSession
│
├── services/              # 业务逻辑层
│   ├── project.py         #   项目注册/发现/DB 连接池
│   ├── task.py            #   任务 CRUD + 状态机
│   ├── pipeline.py        #   DAG 调度 + TaskRunner
│   ├── prompt.py          #   Prompt 拼接
│   └── message.py         #   消息写入/查询/回放
│
├── engines/               # LLM 引擎层
│   ├── base.py            #   BaseLLMEngine 抽象
│   ├── events.py          #   InternalEvent 定义
│   ├── registry.py        #   引擎注册表 + is_installed
│   ├── claude_code.py     #   ClaudeCodeEngine
│   ├── codex.py           #   CodexEngine
│   └── hermes.py          #   HermesEngine
│
├── streaming/             # 实时流层
│   ├── bus.py             #   EventBus 全局事件总线
│   └── parsers/
│       ├── claude_stream.py
│       ├── codex_stream.py
│       └── acp_stream.py
│
├── db/
│   └── migrations/        # Schema 迁移脚本
│
└── tests/
```

## URL → 文件 → 函数映射

看 URL 就能找到代码：`/api/<module>/<action>` → `api/<module>.py` 的 `action()` 函数。

| URL Path | 文件 | 函数 |
|----------|------|------|
| `GET /api/project/list` | `api/project.py` | `list()` |
| `POST /api/project/register` | `api/project.py` | `register()` |
| `POST /api/project/unregister` | `api/project.py` | `unregister()` |
| `POST /api/task/create` | `api/task.py` | `create()` |
| `GET /api/task/list` | `api/task.py` | `list()` |
| `GET /api/task/detail` | `api/task.py` | `detail()` |
| `POST /api/task/start` | `api/task.py` | `start()` |
| `POST /api/task/stop` | `api/task.py` | `stop()` |
| `POST /api/task/retry` | `api/task.py` | `retry()` |
| `DELETE /api/task/delete` | `api/task.py` | `delete()` |
| `GET /api/engine/list` | `api/engine.py` | `list()` |
| `GET /api/pipeline/detail` | `api/pipeline.py` | `detail()` |
| `PUT /api/pipeline/update` | `api/pipeline.py` | `update()` |
| `GET /api/message/list` | `api/message.py` | `list()` |
| `POST /api/run/respond` | `api/run.py` | `respond()` |
| `GET /api/events` | `api/streaming.py` | `events()` |

```python
# api/task.py
from fastapi import APIRouter

router = APIRouter(prefix="/api/task", tags=["任务管理"])

@router.post("/create", response_model=TaskResponse)
async def create(body: TaskCreate): ...

@router.get("/list", response_model=list[TaskResponse])
async def list(project_id: str): ...

@router.post("/start")
async def start(task_id: str): ...

@router.post("/stop")
async def stop(task_id: str): ...
```

```python
# main.py
from fastapi import FastAPI
from api.project import router as project_router
from api.task import router as task_router
from api.engine import router as engine_router
from api.pipeline import router as pipeline_router
from api.message import router as message_router
from api.run import router as run_router
from api.streaming import router as streaming_router

app = FastAPI(title="WorkStep Daemon", version="0.1.0")
app.include_router(project_router)
app.include_router(task_router)
app.include_router(engine_router)
app.include_router(pipeline_router)
app.include_router(message_router)
app.include_router(run_router)
app.include_router(streaming_router)

# /docs → Swagger UI  /redoc → ReDoc
```

## 调用链

```
api/ → services/ → models/ + engines/
                        ↓
                   streaming/bus.py → SSE 推送
```

单向依赖，不循环：
- `api` 只做参数校验和调用 `services`
- `services` 处理业务逻辑，操作 `models`，调度 `engines`
- `engines` spawn 子进程，yield InternalEvent
- `streaming/bus` 接收所有事件，推 SSE + 写 DB + 写 JSONL

## 全局事件总线

```python
# streaming/bus.py
class EventBus:
    def emit(self, project: str, task_id: str, step: str, event: InternalEvent):
        """
        1. UPDATE messages（SQLite）
        2. 追加 events.jsonl（磁盘日志）
        3. 推送 SSE（所有客户端）
        """

    def subscribe(self) -> AsyncIterator[SSEMessage]:
        """SSE 端点调用，yield 所有项目所有任务的事件"""
```

## SSE 推送格式（全局单流）

```
event: task_event
data: {"project":"/path/a","taskId":"abc","step":"req","type":"text_delta","delta":"..."}

event: task_status
data: {"project":"/path/a","taskId":"abc","step":"req","status":"running"}
```

## 多项目管理

```python
# services/project.py
class ProjectManager:
    def register(self, path: str) -> Project:
        """创建 .workstep/，打开 workstep.db"""

    def get(self, path: str) -> Project:
        """获取项目实例"""

class Project:
    path: str                    # 项目根目录
    db: peewee.SqliteDatabase    # .workstep/workstep.db
    steps_path: str              # .workstep/steps.json
    artifacts_dir: str           # .workstep/artifacts/
```

全局注册信息存 `~/.workstep/config.json`，项目数据存各项目自己的 `workstep.db`。
