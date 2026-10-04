# WorkStep 多引擎架构简介

WorkStep 是本地优先的工作流编排工具。不同工作流步骤可能希望用不同的模型、不同的交互方式（CLI、SDK、进程内 Agent）来执行，因此引擎层的目标是：**让任意 LLM 引擎以统一接口接入编排层，同时如实暴露自身能力边界**。引擎代码位于 `apps/daemon/engines/`，核心是两层基类 + 自动注册表。

## 1. 两层引擎基类

引擎继承链是 `BaseLLMEngine` ← `AcpEngineBase`，职责按「协议无关」与「协议执行」切分：

- **`BaseLLMEngine`**（`engines/core/base.py`）：与协议无关的自定义函数。声明了三个抽象方法 `is_installed()` / `get_version()` / `resolve_binary()`（新引擎必须实现），并承载配置表单（`config_schema`）、模型枚举（`list_models`）、供应商协议兼容（`supported_provider_protocols`）、安装/更新（`install_command` / `update`）、能力声明（`EngineCapabilities`）等。
- **`AcpEngineBase`**（`engines/core/acp_base.py`）：ACP 协议执行层。实现了统一入口 `spawn` / `spawn_coordinator`（含一次失败重试）、会话生命周期（create / load / resume / fork / close / cancel）、工具审批（`approve_tool`）、交互回传（`request_interaction` / `respond_interaction`），以及把 ACP 会话更新映射为内部事件的 `_map_notification`。

两类引擎按传输方式分流：提供 `get_command()` 的引擎（如 Hermes）是 **ACP 原生引擎**，直接复用基类的 ACP 客户端实现（`acp.spawn_agent_process`）；其余引擎用自己的传输（CLI 流式输出、Python SDK）**覆盖 `spawn`**，但产出的仍是 ACP 词汇事件。上层调用方只依赖 `AcpEngineBase` 接口，经 `create_engine(backend)` 取用具体引擎。

## 2. 自动发现与注册

`engines/core/registry.py` 在模块导入时扫描 `engines/` 一级模块，收集声明了 `ENGINE_ID` 的引擎类——**新增引擎只需在 `engines/` 下放一个新模块并声明 `ENGINE_ID`，无需改动注册表**：

```python
# engines/core/registry.py（节选）
for name in module_names:
    module = importlib.import_module(f"engines.{name}")
    for obj in vars(module).values():
        if (
            isinstance(obj, type)
            and issubclass(obj, BaseLLMEngine)
            and obj not in (BaseLLMEngine, AcpEngineBase)
            and getattr(obj, "ENGINE_ID", None)
        ):
            found.setdefault(obj.ENGINE_ID, obj)
```

发现结果存入 `_ALL_ENGINES`；随后按 `is_installed()` 过滤，已安装引擎进入公开注册表 `ENGINE_REGISTRY`，未安装的仍保留在列表中供设置页展示安装入口。`refresh_registry()` 可重新扫描（修改二进制路径、安装后触发）；`get_available_engines()` 返回含版本、运行模式（`cli` / `sdk` / `agent` / `acp`）与能力位的引擎清单，版本探测并发执行并带 300 秒缓存。协调 Agent 的默认引擎不可用时，按 `COORDINATOR_FALLBACK_ORDER` 优先级回退，新引擎自动追加到末尾。

## 3. ACP 内部事件与 AG-UI 对外暴露

引擎与编排层之间使用 `InternalEvent`（`engines/core/events.py`），词汇与 ACP 会话更新对齐，全量定义在 `ACP_EVENTS`（`agent_message_chunk`、`tool_call`、`plan`、`usage_update`、`session_started`、`interaction_request` 等 25 种）。基类的 `_map_notification` 对 13 种 ACP 会话更新做全量映射，未知更新透传为 `acp_raw`，不静默丢弃。

对外则由 `engines/core/agui.py` 的 AG-UI 翻译层统一处理：`to_agui_events()` 把内部事件翻译为 AG-UI 标准事件（`RUN_STARTED` / `TEXT_MESSAGE_*` / `TOOL_CALL_*` / `CUSTOM` 等），WebSocket 实时推送与历史回放共用同一条翻译路径；WorkStep 特有事件走 `CUSTOM` 通道（`workstep.*` 前缀），并携带 `task_id` / `step_key` / `message_id` / `channel` 等 passthrough 扩展字段供前端分流。边界清晰：**引擎 → 编排层是 ACP 词汇，编排层 → 前端是 AG-UI**。

## 4. 能力声明：声明即实际

每个引擎通过两类元数据描述自身能力：

- **`acp_events`**：类属性，声明该引擎实际产出的内部事件子集。ACP 原生引擎继承即声明全集；非 ACP 引擎按原生来源裁剪——例如 OpenClaw 的 JSON 封装只产出 5 种事件（`agent_message_chunk`、`usage_update`、`session_started`、`status`、`error`），就不声明 `plan` 或 `interaction_request`，未知来源的事件不会被合成。
- **`EngineCapabilities` / `supports_*` 属性**：`supports_resume`、`supports_sessions`、`supports_session_fork`、`supports_tool_approval`、`supports_live_step_message`、`supports_vision`、`supports_thinking_effort` 等。不支持的能力保持 `False` 安全默认——例如 `supports_session_fork` 仅对 ACP 原生引擎为真，实际 fork 时再按 Agent 初始化时协商的能力校验，未声明则返回 `None`。

声明由注册表并入引擎清单，设置页与协调器据此渲染控件、做能力门控。原则只有一条：**声明 = 实际**，宁缺勿滥。

## 5. 当前支持的引擎

| ENGINE_ID | 引擎 | 传输方式 | 模式 |
| --- | --- | --- | --- |
| `claude` | Claude Code | CLI（`claude -p` 流式输出） | cli |
| `codex` | Codex CLI | CLI（`codex exec`） | cli |
| `claude_agent_sdk` | Claude Agent SDK | 官方 Python SDK | sdk |
| `codex_sdk` | Codex SDK | 官方 `openai-codex` Python SDK | sdk |
| `qoder_sdk` | Qoder SDK | `qoder-agent-sdk` Python SDK | sdk |
| `deepseek_harness` | DeepSeek Harness | 官方 Harness Python SDK | sdk |
| `pydantic_ai` | Pydantic AI | 内置进程内 Agent（无需外部运行时） | agent |
| `hermes` | Hermes | ACP 原生（stdio JSON-RPC） | acp |
| `opencode` | OpenCode | ACP 原生（`opencode acp`，stdio JSON-RPC） | acp |
| `cursor` | Cursor | Python SDK（`cursor-sdk` + 内置 bridge） | sdk |
| `openclaw` | OpenClaw | CLI（JSON 封装，非 ACP） | cli |

更深入的引擎接入步骤见 [llm-engine-development-guide.md](llm-engine-development-guide.md)，运行时安装与版本管理见 [engine-runtime-management.md](engine-runtime-management.md)。