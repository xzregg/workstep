# Daemon 开发指导

适用于 `apps/daemon/`，同时遵守[根规则](../../AGENTS.md)。先读 [Code Map](../../docs/code-map.md) 定位 API、服务与测试。

## 运行与开发

WorkStep 本地后台服务，最低支持 Python 3.11.5（安全修复后的 SoupSieve 要求），使用 FastAPI、Peewee 构建，负责 REST API、WebSocket 实时事件、项目管理、工作流编排、LLM 引擎调用与 SQLite 持久化。默认开发环境、CI 与桌面打包使用 Python 3.12，Docker 运行时使用 Python 3.14；调整版本时须同时核对 `pyproject.toml`、`.python-version`、CI、Dockerfile 与桌面打包脚本。

主要目录：
- `api/` — API 路由与接口
- `services/` — 业务逻辑、DAG 调度与任务执行
- `engines/` — LLM 引擎及 ACP、CLI、API 适配
- `agent_assistants/` — 助手模块（每个助手一个文件，通用层在 `base.py`）
- `models/` — Peewee 数据模型与迁移
- `schemas/` — Pydantic 请求、响应模型
- `streaming/` — 实时事件总线
- `tests/` — 后端测试

开发命令：

```bash
cd apps/daemon
uv sync --dev
uv run --no-sync uvicorn main:app --reload --port 8765
uv run --no-sync pytest
```

## 后端异步 I/O 开发规范

- **所有可能阻塞的 I/O 均不得运行在事件循环线程**：文件、网络、数据库、子进程管道及同步 SDK 等 I/O，禁止在 `async def`、FastAPI 异步路由、WebSocket 处理器或后台协程中直接同步执行；优先使用原生异步接口，无异步接口时必须通过 `asyncio.to_thread`、项目数据库执行器或专用执行器隔离。同步辅助函数可以执行 I/O，但其所有异步调用路径必须保证已进入执行器；仅声明为 `async def` 或放入后台协程不构成隔离。
- **阻塞回归必须有 canary**：新增或修改可能阻塞的 I/O 路径时，使用慢盘、网络延迟、慢 SDK 或锁竞争模拟，并配合健康检查或轻量协程证明事件循环仍可及时响应。

## Peewee 异步开发规范

- **Peewee 一律异步隔离**：Peewee 是同步 ORM；任何 `async def`、FastAPI 异步路由、WebSocket 处理器和后台协程都不得直接执行查询、迭代惰性查询、写入、删除、事务或数据库连接操作。
- **项目数据库统一入口**：每个项目的完整同步数据库工作单元必须封装为普通函数，并通过 `await project_manager.run_db(project_id, operation)`（或已注入的 `ProjectDatabaseExecutor.run`）执行。查询物化、事务、模型序列化都必须在该工作单元内完成。
- **跨项目与初始化**：跨项目读取应按项目分别提交到各自数据库执行器，可用 `asyncio.gather` 并发等待；项目注册、初始化等尚无项目执行器的操作才可使用 `asyncio.to_thread`，禁止退回事件循环线程执行。
- **禁止跨线程异步混用**：不得在数据库工作线程中调用 `asyncio.create_task`，不得让数据库激活上下文跨越 `await`。需要启动后台任务时，必须拆成“数据库线程持久化 → 返回纯数据 → 事件循环创建任务”。
- **回归要求**：新增或修改 Peewee 调用路径必须增加真实 API/WebSocket/后台调度测试，并用慢 SQL 或 SQLite 锁竞争配合健康检查 canary，证明数据库繁忙时事件循环仍可响应。

## 领域约束与必读入口

- 引擎必须继承 `AcpEngineBase`；能力声明必须与实际一致，不能用 resume 模拟 fork。子进程 stdout 必须使用 `engines/core/stream_lines.py` 分块读取。修改引擎、会话、审批、流式协议或 Harness 前，必须阅读[引擎开发指南](../../docs/llm-engine-development-guide.md)，尤其[多引擎支持](../../docs/llm-engine-development-guide.md#多引擎支持)。
- 内部事件用 ACP，对外实时与历史回放共用 AG-UI 翻译层。修改 WebSocket、订阅或事件日志前必须阅读[技术架构与订阅](../../docs/architecture.md#技术架构已确定)及[数据模型](../../docs/architecture.md#数据模型)。
- 项目数据路径必须通过 `Project.workstep_dir` 或线程内 `data_directory` 解析，不得写死根目录 `.workstep`。修改存储前必须阅读[数据模型](../../docs/architecture.md#数据模型)与[存储迁移](../../docs/project-storage.md)。
- 新增或扩展助手必须复用 `AssistantConfig` / `AssistantRuntime`，不得复制会话、流式、停止及审批基础设施；修改前必须阅读[助手开发约束](../../docs/architecture.md#助手开发约束)，覆盖会话隔离和既有助手回归。
- **渠道来源的注入边界**：所有渠道的项目聊天与任务协调助手，都必须通过统一的 `system_prompt` 参数传递渠道背景（平台、会话、发送者等）。助手、渠道适配器和消息持久化层不得把来源拼进用户正文，也不得按平台或引擎在业务层另设正文路径。原生指令传输与仅支持正文的兼容降级由引擎层负责。修改相关链路时，运行 `test_channel_prompt.py` 和 `test_channel_coordinator_source.py`。

- **提示词标签**：程序注入分段统一调用 `services.prompt_sections.prompt_section`，使用固定的英文小写下划线 XML 风格成对标签，标签独立成行且结束后换行；只统一外层边界：原有 JSON 通过 `prompt_context` 整体包裹并说明用途，不逐字段转 XML；纯文本保留原始正文，不通过修改用户标题避免冲突。同步修改标签引用及依赖旧标题／前缀的程序判断，读取旧历史时保留兼容；不得改变 system/developer/user 传输边界、增量注入策略或输出解析协议。详细规则见[提示词分段规范](../../docs/llm-engine-development-guide.md#提示词分段规范)。

## 项目与流程

- **命名**：新建/重命名项目与工作流时禁止空白字符，前端即时校验，后端 schema 同步强制。
- **流程与模板**：新项目默认没有流程，初始化和重新打开时均不自动创建默认流程；已有流程原样恢复。新流程默认空画布，模板由用户主动选择。模板以 `~/.workstep/data/templates/*.json` 为准；启动时从 `apps/daemon/data/templates/` 复制缺失文件但不覆盖。模板含 `id/name/description/steps`；内置模板标记 `default: true` 且不可删除。

## 统一访问权限

- HTTP／WebSocket 身份验证由 `api/desktop_security.py` 与 `api/remote_access_guard.py` 拥有；宿主访问策略唯一入口为 `api/workspace_access.py`。新增宿主专属接口使用 `Depends(require_host_workspace)`，仅本机操作使用 `require_local_device`／`local_credentials`；已有项目及记录读写权限继续复用 `services/project_scope.py` 和领域服务。
- 功能 API 禁止自行根据 `actor.source`、直连／网关 scope 标记、客户端 IP 或设备所有者标记放行／拒绝；不得逐接口增加 WebRTC 特例。传输身份只由上述边界模块识别，功能只声明公共策略；浏览器同源校验复用 `require_same_origin`。业务署名、记录归属和项目读写范围仍属领域数据语义，不能因统一入口而删除。
- 修改公共策略须运行 `tests/test_workspace_access.py` 的权限矩阵与边界归属检查，覆盖本机、验证后的直连、网关宿主、项目身份、分享身份、伪造通道及仅本机凭据操作；涉及传输时补 HTTP／WebSocket 及真实直连回归。策略与契约见 [网关开发文档](../../docs/gateway-development.md#统一宿主访问策略)。
