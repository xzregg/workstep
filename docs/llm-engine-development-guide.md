# WorkStep LLM 引擎开发指南

本文说明如何为 WorkStep 新增或维护 LLM 执行引擎。适用于本地 CLI、ACP Agent、OpenAI-compatible API、Anthropic API 或其他可流式输出的 Agent Runtime。

相关代码：

- 引擎抽象：`apps/daemon/engines/base.py`
- 统一事件：`apps/daemon/engines/events.py`
- 引擎注册：`apps/daemon/engines/registry.py`
- ACP 基类：`apps/daemon/engines/acp_base.py`
- 工作流消费端：`apps/daemon/services/task_runner.py`
- 引擎管理 API：`apps/daemon/api/engine.py`
- 前端引擎元数据：`apps/web/src/engineMeta.ts`

## 1. 引擎在系统中的位置

```text
WorkflowRuntime / CoordinatorModule
                │
                ▼
          BaseLLMEngine
                │
                ▼
 CLI / ACP / HTTP API / Agent SDK
                │
                ▼
          InternalEvent 流
                │
       ┌────────┴────────┐
       ▼                 ▼
  SQLite 消息记录     WebSocket 实时消息
```

引擎适配器只负责四件事：

1. 检测和描述引擎是否可用。
2. 接收标准执行参数并启动一次 LLM 回合。
3. 将下游协议转换成 `InternalEvent`。
4. 在取消、错误或退出时正确释放资源。

引擎不应自行修改任务、阶段、消息或审核状态，这些由 `TaskRunner`、`ReviewGate` 和协调模块统一处理。

## 2. 选择实现方式

### 2.1 直接 CLI

继承 `BaseLLMEngine`。适用于 `claude -p`、`codex exec` 等命令行程序。

必须自行实现：

- 二进制定位和版本检测。
- `asyncio.create_subprocess_exec` 生命周期。
- stdin 输入协议。
- stdout/stderr 流解析。
- 取消和进程回收。
- 会话 ID 提取与恢复参数。

参考：`apps/daemon/engines/claude_code.py`、`apps/daemon/engines/codex.py`。

### 2.2 ACP Agent

优先继承 `AcpEngineBase`，子类主要提供命令、引擎 ID 和权限模式。

ACP 基类已经处理：

- Agent 初始化。
- 新建/恢复 Session。
- 模型配置。
- 文本、思考、工具调用和 Token 事件映射。
- 进程退出与异常转换。

参考：`apps/daemon/engines/claude_code_acp.py`、`apps/daemon/engines/codex_acp.py`。

### 2.3 HTTP API 或 SDK

继承 `BaseLLMEngine`，`is_installed()` 通常返回 `True`，并通过 `is_configured()` 判断 URL、模型和密钥是否齐全。

参考：`apps/daemon/engines/api.py`、`apps/daemon/engines/pydantic_ai.py`。

## 3. 必须实现的接口

所有引擎必须继承 `BaseLLMEngine`。

| 接口 | 必须 | 说明 |
|---|---:|---|
| `is_installed()` | 是 | 本机是否具备运行条件。CLI 检查二进制，内置 API Adapter 通常返回 `True`。 |
| `get_version()` | 是 | 返回版本字符串；无法获取时返回 `None`。不得无限等待。 |
| `resolve_binary()` | 是 | 返回实际命令路径或 Adapter 标识；不可用时返回 `None`。 |
| `spawn(...)` | 是 | 启动一次执行并异步产出 `InternalEvent`。 |
| `stop()` | 是 | 停止当前执行。必须可重复调用，并在无运行任务时安全返回。 |
| `inject_response(...)` | 是 | 中途注入用户响应；不支持时记录日志并安全返回。 |
| `supports_resume` | 是 | 是否支持恢复原生会话。 |
| `supports_interactive` | 是 | 是否支持执行中交互或权限响应。 |
| `build_resume_params(...)` | 是 | 将 Session ID 转换为恢复参数；不支持时返回空字典。 |

### 3.1 `spawn` 签名

```python
async def spawn(
    self,
    prompt: str,
    cwd: str,
    model: str | None = None,
    add_dirs: list[str] | None = None,
    session_id: str | None = None,
) -> AsyncIterator[InternalEvent]:
    ...
```

参数语义：

- `prompt`：本阶段组装后的完整提示词，不是只有用户最后一句话。
- `cwd`：任务工作目录。所有本地工具操作必须以此为主目录。
- `model`：阶段显式模型；为空时使用引擎自身默认模型。
- `add_dirs`：允许访问的附加目录。协议不支持时可以忽略，但不能扩大权限范围。
- `session_id`：需要恢复的原生引擎会话 ID。

实现要求：

- 必须尽早产出 `status: initializing` 或 `status: running`。
- 下游有增量输出时立即 `yield`，禁止等进程结束后一次性返回。
- 保持事件顺序，文本增量不得重复。
- 预期内错误优先转换成 `error` 事件，而不是让整个 Daemon 崩溃。
- `finally` 中必须清理 `_running`、进程、连接和临时资源。

## 4. 可选接口与能力声明

### 4.1 `is_configured()`

用于区分“Adapter 已安装”和“已经具备执行配置”。API、权限模式或外部 Provider 未配置时应返回 `False`。

### 4.2 `list_models(cwd)`

返回 `list[EngineModel]`：

```python
EngineModel(
    id="model-id",
    label="Model Name",
    description="可选说明",
)
```

无法动态读取模型时返回空列表，表示只使用引擎默认模型。读取模型列表应有明确超时。

### 4.3 `test_connection(cwd, timeout_seconds)`

基类会发送无工具、无文件修改的最小测试提示词。通常无需覆盖。

以下场景可覆盖：

- Provider 提供更便宜的健康检查接口。
- 引擎必须使用特殊输入格式。
- 需要在测试前验证认证或权限模式。

连接测试必须验证真实对话链路，不能只检查二进制存在。

### 4.4 `capabilities`

返回 `EngineCapabilities`：

| 字段 | 含义 |
|---|---|
| `supports_coordinator` | 可用于用户对话和协调 Agent。 |
| `supports_resume` | 可恢复原生 Session。 |
| `supports_tool_disable` | 协调模式能否可靠禁止工具。 |
| `supports_native_schema` | 是否支持原生结构化输出 Schema。 |
| `supports_live_stage_message` | 是否支持执行中向同一阶段持续追加消息。 |

默认能力定义在 `BaseLLMEngine.capabilities`。只有确认真实支持时才能声明为 `True`。

### 4.5 `spawn_coordinator(...)`

协调模式用于理解任务上下文、回答用户并提出动作，不应修改文件。

基类实现会追加只读约束并复用 `spawn()`。如果引擎支持原生禁用工具或结构化 Schema，应覆盖此方法，使用协议级限制，而不是只依赖提示词。

## 5. `InternalEvent` 协议

所有下游协议必须转换成以下统一事件：

| 事件 | 必要字段 | 用途 |
|---|---|---|
| `status` | `status` | `initializing`、`running`、`done` 等生命周期状态。 |
| `text_delta` | `delta` | 助手正文增量，会拼接到最终消息。 |
| `thinking_delta` | `delta` | 思考或推理过程，显示在可折叠执行记录中。 |
| `tool_use` | `id`、`name`、`input` | 完整工具调用。 |
| `tool_input_delta` | `id`、`name`、`delta` | 工具参数增量，仅用于实时状态。 |
| `tool_result` | `tool_use_id`、`content`、`is_error` | 工具执行结果。 |
| `usage` | Token 字段 | 消息完成后的 Token 统计。 |
| `session_started` | `session_id` | 保存可复用的引擎 Session。 |
| `error` | `message` | 可展示的错误；可附加 `detail`、`stderr`。 |

这是所有 LLM 引擎适配器的强制协议，不是可选增强：

- 下游提供正文增量时，必须映射为 `text_delta`。
- 下游提供 reasoning、thinking、analysis 或 thought 内容时，必须映射为 `thinking_delta`，禁止混入正文或静默丢弃。
- 下游发起工具调用时，必须在工具开始执行前映射为 `tool_use`；参数分片可额外映射为 `tool_input_delta`。
- 适配器或 Agent 实际执行工具时，必须在执行结束后映射为 `tool_result`，并保持相同的调用 ID。
- Provider 没有返回思考内容，或当前模式没有工具能力时，可以不产生对应事件，但不得伪造思考、工具调用或工具结果。
- 只提供最终完整消息的协议也必须完成相同映射，只是无法承诺增量实时性；引擎说明和测试中必须明确该降级。

示例：

```python
yield InternalEvent("status", {"status": "running"})
yield InternalEvent("thinking_delta", {"delta": "正在分析任务"})
yield InternalEvent("tool_use", {
    "id": "tool-1",
    "name": "Read",
    "input": {"file_path": "README.md"},
})
yield InternalEvent("tool_result", {
    "tool_use_id": "tool-1",
    "content": "...",
    "is_error": False,
})
yield InternalEvent("text_delta", {"delta": "任务已完成"})
yield InternalEvent("usage", {
    "input_tokens": 100,
    "output_tokens": 20,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 30,
    "total_tokens": 120,
})
yield InternalEvent("status", {"status": "done"})
```

### 5.1 Token 规范化

优先使用 `normalize_token_usage()`，统一 Provider 的不同字段名称。至少提供：

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `total_tokens`

没有真实数据时填 `0`，禁止伪造估算值。`usage` 应在消息完成前产出，前端只在完成后展示统计。

### 5.2 实时流要求

- CLI 支持 partial/delta 协议时必须开启。
- 如果同时收到增量事件和完整消息事件，只能选择一种作为正文来源，避免重复文本。
- 工具参数可能分片到达，应累计到 `content_block_stop` 后再产出完整 `tool_use`。
- 长时间只有思考或工具调用时，仍应持续产出对应事件，保证界面不是空白。
- 事件 `data` 应保持 JSON 可编码，不要放进程对象、异常实例或文件句柄。

### 5.3 Agent 事件流要求

使用 Agent SDK 时，禁止为了方便只消费最终正文流。如果 SDK 同时提供正文、思考、工具调用和工具结果事件，适配器必须使用完整事件流接口。

例如 Pydantic AI 必须使用 `Agent.run_stream_events()`，并至少映射：

| Pydantic AI 事件 | WorkStep 事件 |
|---|---|
| `PartStartEvent(TextPart)` / `PartDeltaEvent(TextPartDelta)` | `text_delta` |
| `PartStartEvent(ThinkingPart)` / `PartDeltaEvent(ThinkingPartDelta)` | `thinking_delta` |
| `FunctionToolCallEvent` | `tool_use` |
| `FunctionToolResultEvent` | `tool_result` |
| `AgentRunResultEvent.result.usage()` | `usage` |

`PartEndEvent` 中的完整内容不得在已经发送增量后再次发送，否则会造成正文或思考内容重复。工具参数和工具结果必须经过 JSON 安全转换后再写入事件总线。

## 6. 生命周期和异常处理

推荐生命周期：

```text
配置验证
  → initializing
  → 创建进程/连接
  → session_started（可选）
  → running
  → text/thinking/tool events
  → usage（可选）
  → done
  → 清理资源
```

异常规则：

| 场景 | 引擎行为 |
|---|---|
| 二进制不存在 | `is_installed()` 返回 `False`；若运行时发现则产出 `error`。 |
| 配置或权限未确认 | `is_configured()` 返回 `False`，或在 `spawn()` 开始时产出明确错误。 |
| 子进程非零退出 | 产出 `error`，包含退出码和经过限制的 stderr。 |
| HTTP 4xx/5xx | 产出可读 `error`，不要泄露 API Key。 |
| 输出不是合法协议 | 记录受限日志；若无法继续，应产出 `error`。 |
| 运行超时 | 停止进程/请求并产出超时错误。 |
| 用户取消 | `stop()` 终止执行，释放资源，不得遗留子进程。 |
| Adapter 内部异常 | 捕获、记录堆栈，并向上游产出简洁错误。 |

注意：当前工作流层尚未提供统一的长时间无响应 watchdog。新引擎应在自身网络请求、握手和退出等待上配置超时。

## 7. 会话恢复与交互

### 7.1 会话恢复

支持恢复时：

1. 首次建立会话后产出 `session_started`。
2. `supports_resume` 返回 `True`。
3. `build_resume_params(session_id)` 返回调用 `spawn()` 所需参数。
4. 收到 `session_id` 时使用原生恢复协议，不能悄悄新建无上下文会话。
5. 恢复失败时产出明确错误，不应无提示降级为新会话。

### 7.2 执行中交互

只有真正支持双向协议时，`supports_interactive` 才能返回 `True`。

`inject_response(tool_use_id, content)` 必须把响应发送给对应工具请求，不能发送到错误的 Session 或阶段。直接 CLI stdin 已关闭时通常不支持交互。

## 8. 权限与安全要求

- 使用参数数组调用子进程，禁止拼接后通过 shell 执行。
- 日志可以打印命令，但必须隐藏 API Key、Token 和敏感 Header。
- 必须使用传入的 `cwd`，不得默认在 WorkStep 仓库根目录执行用户任务。
- `add_dirs` 只能扩大到显式传入目录。
- 引擎具备危险权限模式时，必须要求用户先确认并持久化选择。
- 协调模式默认只读，不能因为执行引擎支持工具就自动开放写权限。
- stderr、HTTP Body 和模型错误应限制长度，避免把大量敏感内容写入日志或消息。

## 9. 注册新引擎

假设新增后端 ID 为 `my_engine`，实现类为 `MyEngine`。

### 9.1 后端注册

1. 新建 `apps/daemon/engines/my_engine.py`。
2. 在 `apps/daemon/engines/registry.py` 导入实现类。
3. 加入 `_ALL_ENGINES`：

   ```python
   "my_engine": MyEngine,
   ```

4. 加入 `_BACKEND_PREFERENCE`：

   ```python
   "my_engine": ["my_engine"],
   ```

5. CLI 引擎如需支持自定义路径，加入 `_PATH_TARGETS`。
6. 在 `apps/daemon/engines/__init__.py` 导出实现类。

如果同一后端同时有 ACP 和 CLI：

```python
_ALL_ENGINES.update({
    "my_engine": MyCliEngine,
    "my_engine_acp": MyAcpEngine,
})

_BACKEND_PREFERENCE["my_engine"] = [
    "my_engine_acp",
    "my_engine",
]
```

注册顺序表示优先级；只有候选实现 `is_installed()` 为 `True` 才会被选中。

### 9.2 配置和 API

引擎有独立配置时，在 `services/config.py` 增加专用读取和保存方法，并在 `api/engine.py` 增加受校验的配置接口。

不要复用其他引擎的 API Key、Base URL、权限模式或模型配置键。

### 9.3 前端元数据

在 `apps/web/src/engineMeta.ts` 增加：

- `ENGINE_LABELS`
- `ENGINE_DESCRIPTIONS`
- `ENGINE_COLORS`

如果引擎有专用配置表单，还需更新设置页和 API Client 类型。

## 10. 最小实现模板

```python
import asyncio
import shutil
from typing import AsyncIterator

from engines.base import BaseLLMEngine
from engines.events import InternalEvent


class MyEngine(BaseLLMEngine):
    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None

    @staticmethod
    def is_installed() -> bool:
        return MyEngine.resolve_binary() is not None

    @staticmethod
    def get_version() -> str | None:
        return None

    @staticmethod
    def resolve_binary() -> str | None:
        return MyEngine.get_binary_override() or shutil.which("my-engine")

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        binary = self.resolve_binary()
        if not binary:
            yield InternalEvent("error", {"message": "my-engine binary not found"})
            return
        command = [binary, "--stream"]
        if model:
            command.extend(["--model", model])

        yield InternalEvent("status", {"status": "initializing"})
        try:
            self._process = await asyncio.create_subprocess_exec(
                *command,
                cwd=cwd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            yield InternalEvent("status", {"status": "running"})
            # 写入 prompt，逐行解析 stdout，并立即 yield InternalEvent。
            exit_code = await self._process.wait()
            if exit_code != 0:
                yield InternalEvent("error", {
                    "message": f"Process exited with code {exit_code}",
                })
                return
            yield InternalEvent("status", {"status": "done"})
        except Exception as exc:
            yield InternalEvent("error", {"message": str(exc)})
        finally:
            self._process = None

    async def stop(self) -> None:
        if self._process and self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        return None

    @property
    def supports_resume(self) -> bool:
        return False

    @property
    def supports_interactive(self) -> bool:
        return False

    def build_resume_params(self, session_id: str) -> dict:
        return {}
```

实际实现必须按真实协议完成 stdin/stdout 处理；模板中的注释不能作为最终实现。

## 11. 测试要求

每个新引擎至少覆盖以下测试：

### 11.1 单元测试

- 二进制解析优先级和自定义路径。
- 命令参数构造，包括模型、工作目录、附加目录、权限模式和 Session。
- 每种下游事件到 `InternalEvent` 的映射。
- 多内容块和分片事件不会丢失或重复。
- Token 字段规范化。
- 非零退出、协议错误、认证错误和超时。
- `stop()` 能终止进程且可重复调用。
- Session 新建、保存和恢复。
- 协调模式禁止工具。

### 11.2 通用连接测试

设置页的“测试引擎”会调用：

```http
POST /api/engine/test
```

只有真实对话成功并返回文本后，引擎才会被标记为已验证。执行和协调配置都会检查该验证状态。

### 11.3 工作流集成测试

至少使用 Fake Engine 跑通：

1. 创建三阶段工作流。
2. 第一阶段接收用户任务。
3. 下游阶段读取上游产物和完整上下文。
4. 每个阶段产生实时消息、最终正文和 Token。
5. 自动审核产生 Review 消息。
6. 最终任务进入完成状态。
7. 从指定阶段重跑时，上游阶段标记为 `reused`，不会重复执行。

推荐命令：

```bash
cd apps/daemon
.venv/bin/pytest tests/test_engines.py -q
.venv/bin/pytest tests/test_pipeline.py tests/test_workflow_runtime.py -q
.venv/bin/pytest tests/test_coordinator.py tests/test_review_gate.py -q
```

前端变更后：

```bash
cd apps/web
npm run build
```

## 12. 提交前验收清单

- [ ] 实现 `BaseLLMEngine` 所有抽象接口。
- [ ] 引擎不可用时不会导致 Daemon 启动失败。
- [ ] `spawn()` 开始后立即产生状态事件。
- [ ] 文本、思考和工具事件实时输出，不在结束时批量补发。
- [ ] 下游提供的 thinking/reasoning 事件没有被静默丢弃。
- [ ] 每个工具调用都有稳定 `id`，工具结果使用相同 `tool_use_id`。
- [ ] Agent SDK 使用完整事件流接口，而不是只消费最终正文流。
- [ ] Provider 不支持思考或工具时有明确降级说明，且不伪造事件。
- [ ] 增量正文不重复、不丢失。
- [ ] 错误事件包含可理解的信息且不泄露密钥。
- [ ] `stop()` 可以可靠终止进程或请求。
- [ ] Token 使用量来自真实 Provider 数据。
- [ ] Session 能力声明与实际行为一致。
- [ ] 协调模式不能修改文件。
- [ ] 已加入 Registry、配置和前端元数据。
- [ ] 设置页连接测试通过。
- [ ] 单元测试、三阶段工作流测试和前端构建通过。
