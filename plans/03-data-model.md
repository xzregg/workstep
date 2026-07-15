# 数据模型

## 存储架构

**双层存储**：

1. **全局配置**（`~/.workstep/config.json`）：Daemon 级，存已注册项目路径列表
2. **项目 DB**（`<project>/.workstep/workstep.db`）：项目级，存该项目的全部运行数据

```
~/.workstep/
  config.json          # {"projects": ["/path/project-a", "/path/project-b"]}

project-a/
  .workstep/
    steps.json         # 工作流定义
    workstep.db        # SQLite（下表结构）
    artifacts/         # 产物文件
    runs/
      <runId>/
        events.jsonl   # 单次 run 的事件日志
```

## SQLite Schema

```sql
-- 任务（对应前端的"卡片"）
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,              -- UUID
    title TEXT NOT NULL,
    description TEXT,
    cwd TEXT NOT NULL,                -- 工作目录
    status TEXT NOT NULL DEFAULT 'ready',  -- ready / running / paused / stopped
    engine TEXT,                      -- 默认引擎 ('claude' / 'codex' / 'hermes')
    model TEXT,                       -- 可选模型覆盖
    pipeline_version TEXT,            -- 创建时 steps.json 的 hash 快照
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 任务阶段进度（每个阶段独立追踪状态）
CREATE TABLE task_steps (
    task_id TEXT NOT NULL,
    step_key TEXT NOT NULL,           -- 'req' / 'ui' / 'frontend' / 'backend' / 'test' / 'deploy'
    status TEXT NOT NULL DEFAULT 'pending',  -- pending / running / passed / failed / skipped
    engine TEXT,                      -- 该阶段实际使用的引擎（可覆盖 task 默认）
    started_at INTEGER,
    ended_at INTEGER,
    error TEXT,                       -- 失败时的错误信息
    PRIMARY KEY (task_id, step_key),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 消息（每条 LLM 交互的消息记录）
CREATE TABLE messages (
    id TEXT PRIMARY KEY,              -- UUID
    task_id TEXT NOT NULL,
    step_key TEXT NOT NULL,           -- 所属阶段
    role TEXT NOT NULL,               -- 'user' / 'assistant'
    content TEXT NOT NULL DEFAULT '',  -- user: 原始输入 / assistant: text_delta 拼接
    engine TEXT,                      -- 使用的引擎
    model TEXT,                       -- 使用的模型
    run_id TEXT,                      -- 关联的 run UUID
    run_status TEXT,                  -- 'running' / 'succeeded' / 'failed'
    events_json TEXT,                 -- 所有 InternalEvent 的 JSON 数组
    prompt_json TEXT,                 -- 发送的 prompt 各部分（telemetry 用）
    usage_json TEXT,                  -- token 用量汇总
    position INTEGER NOT NULL,        -- 在 task+step 中的顺序
    started_at INTEGER,
    ended_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 引擎会话（Claude --resume 用）
CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    engine TEXT NOT NULL,
    session_id TEXT,                  -- Claude 的 session ID
    instruction_hash TEXT,            -- 稳定指令块 hash（判断是否跳过重发）
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 产物记录
CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    filename TEXT NOT NULL,           -- 文件名
    filepath TEXT NOT NULL,           -- 相对路径
    file_type TEXT,                   -- 'markdown' / 'json' / 'code' / ...
    version INTEGER NOT NULL DEFAULT 1,  -- 重跑时递增
    size_bytes INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 索引
CREATE INDEX idx_messages_task_step ON messages(task_id, step_key, position);
CREATE INDEX idx_task_steps_task ON task_steps(task_id);
CREATE INDEX idx_artifacts_task_step ON artifacts(task_id, step_key);
CREATE INDEX idx_agent_sessions_task ON agent_sessions(task_id, step_key);
```

## Peewee 模型

```python
import peewee as pw

db_proxy = pw.Proxy()  # 运行时绑定到具体项目的 .db

class BaseModel(pw.Model):
    class Meta:
        database = db_proxy

class Task(BaseModel):
    id = pw.TextField(primary_key=True)
    title = pw.TextField()
    description = pw.TextField(null=True)
    cwd = pw.TextField()
    status = pw.TextField(default='ready')
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    pipeline_version = pw.TextField(null=True)
    created_at = pw.IntegerField()
    updated_at = pw.IntegerField()

class TaskStep(BaseModel):
    task = pw.ForeignKeyField(Task, backref='steps')
    step_key = pw.TextField()
    status = pw.TextField(default='pending')
    engine = pw.TextField(null=True)
    started_at = pw.IntegerField(null=True)
    ended_at = pw.IntegerField(null=True)
    error = pw.TextField(null=True)

    class Meta:
        primary_key = pw.CompositeKey('task', 'step_key')

class Message(BaseModel):
    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref='messages')
    step_key = pw.TextField()
    role = pw.TextField()
    content = pw.TextField(default='')
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    run_id = pw.TextField(null=True)
    run_status = pw.TextField(null=True)
    events_json = pw.TextField(null=True)      # JSON array
    prompt_json = pw.TextField(null=True)       # JSON
    usage_json = pw.TextField(null=True)        # JSON
    position = pw.IntegerField()
    started_at = pw.IntegerField(null=True)
    ended_at = pw.IntegerField(null=True)
    created_at = pw.IntegerField()

class AgentSession(BaseModel):
    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref='sessions')
    step_key = pw.TextField()
    engine = pw.TextField()
    session_id = pw.TextField(null=True)
    instruction_hash = pw.TextField(null=True)
    created_at = pw.IntegerField()
    last_active_at = pw.IntegerField()

class Artifact(BaseModel):
    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref='artifacts')
    step_key = pw.TextField()
    filename = pw.TextField()
    filepath = pw.TextField()
    file_type = pw.TextField(null=True)
    version = pw.IntegerField(default=1)
    size_bytes = pw.IntegerField(null=True)
    created_at = pw.IntegerField()
```

## 打开项目时的加载流程

```
用户打开 project-a/
  → Daemon: ProjectManager.register(path) 或 .get(path)
  → 连接 project-a/.workstep/workstep.db
  → db_proxy.initialize(db)
  → 查询：
      SELECT * FROM tasks ORDER BY updated_at DESC
      → 返回任务列表（含 status）

      SELECT * FROM task_steps WHERE task_id IN (...)
      → 返回每个任务的阶段进度

      SELECT * FROM messages WHERE task_id = ? AND step_key = ? ORDER BY position
      → 返回某任务某阶段的历史消息

  → 前端渲染：
      - 左侧栏：项目列表 → 任务列表
      - 任务卡片：显示各阶段状态色（pending/running/passed/failed）
      - 详情页：消息列表 + events_json 回放
```

## 事件写入流程

```
LLM 子进程 stdout 事件
  → stream parser 转换为 InternalEvent
    → event_bus.emit(project, task_id, step_key, event)
      ├─ messages 表: UPDATE SET events_json=append, content=append(text_delta时)
      ├─ runs/<runId>/events.jsonl: 追加一行 JSON
      └─ SSE: 推送到所有连接的客户端
```

## 跨项目查询

Daemon 持有所有项目的 DB 连接池。跨项目查询（"所有正在运行的任务"）遍历连接池聚合：

```python
async def get_all_running_tasks(self) -> list[dict]:
    results = []
    for project in self.projects.values():
        tasks = Task.select().where(Task.status == 'running')
        for t in tasks:
            results.append({"project": project.path, **model_to_dict(t)})
    return results
```
