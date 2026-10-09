# WorkStep LLM 引擎开发指南

本文说明如何为 WorkStep 新增或维护 LLM 执行引擎。适用于本地 CLI、ACP Agent、OpenAI-compatible API、Anthropic API、Agent SDK 或其他可流式输出的 Agent Runtime。

相关代码：

- 自定义函数基类：`apps/daemon/engines/core/base.py`（`BaseLLMEngine`）
- ACP 协议基类：`apps/daemon/engines/core/acp_base.py`（`AcpEngineBase`）
- 统一事件：`apps/daemon/engines/core/events.py`
- 交互与计划：`apps/daemon/engines/core/interactions.py`、`apps/daemon/engines/core/plans.py`
- 配置模板：`apps/daemon/engines/core/schema.py`
- 引擎注册：`apps/daemon/engines/core/registry.py`
- 对外事件翻译：`apps/daemon/engines/core/agui.py`（AG-UI）
- 参考实现：`apps/daemon/engines/hermes.py`（ACP 原生）、`apps/daemon/engines/codex.py`（CLI）、`apps/daemon/engines/claude_agent_sdk.py`（SDK）、`apps/daemon/engines/pydantic_ai/engine.py`（进程内 Agent）
- 工作流消费端：`apps/daemon/services/task_runner.py`
- 引擎管理 API：`apps/daemon/api/engine.py`
- 前端引擎元数据：`apps/web/src/engineMeta.ts`

安装包元数据、真实下载进度和回退约束见 [引擎版本管理](engine-runtime-management.md)。新增可管理引擎时声明 `RUNTIME_PACKAGE`，复用统一服务及前端组件。

## 0. 基类层次（先读）

### 会话系统指令追加

`AcpEngineBase.spawn_with_retry` 和 `spawn_coordinator_with_retry` 接受独立的可选 `system_prompt`。这是 WorkStep 的基类扩展，不是 ACP `session/prompt` 的协议字段；语义是补充会话角色和来源背景，保留引擎内置指令。每轮调用可提供同一份配置，由适配器管理创建、恢复和重新创建会话时的传输，不能把配置重复追加成历史消息。`/compact` 不接收该指令。

原生适配器声明 `SYSTEM_PROMPT_MODE`：Codex SDK 使用 `developer`，映射为线程的 `developer_instructions`，保留 `base_instructions`；Claude/Qoder SDK 使用 `system`，分别通过 `claude_code` / `qodercli` 预设的 `append` 追加；Pydantic AI 使用 `system`，通过持久化的 `SystemPromptPart` 与现有 harness 能力指令共同生效，固定规则随会话历史恢复；相同规则不重新注入，变更／清空只替换 WorkStep 自己的系统消息，历史缺失时重新初始化。未声明的引擎默认为 `body`，基类只在新会话或无恢复能力时前置正文，恢复与恢复重试不重复前置。

任务协调助手的固定规则由 `coordinator_context.py` 构建，当前任务、用户消息和来源背景属于每轮正文上下文；不得因来源背景变化而把固定规则整体设为 `system_prompt_each_turn=True`。Codex SDK 检查原生已保存规则，不能只凭会话 ID 省略注入：兼容 `turn_context.developer_instructions`，并识别原生 `response_item` 中带 `<workstep_system_rules>` 标记的开发者消息；实际运行时可能不保存前一个字段。只比较最新规则，用户消息不能作为恢复凭据；压缩后未确认规则保留则重新初始化。旧记录没有标记且缺少设置字段时首次补注入一次。原生恢复用的空指令标记不表示新指令，提示词查看页不显示空的独立指令区块。渠道普通助手仍按自身传输约定提供每轮来源背景。

`agent_assistants/chat_session.py` 将项目设置中的「全局提示词」（`project_settings.chat_system_prompt`，不是跨项目的系统设置）作为独立 `system_prompt` 提供；正文仅保留用户输入及必要交接/重建背景，空配置不补默认角色。普通对话使用默认首次正文降级策略，固定规则不在恢复轮次重复插入；原生适配器按自身 system/developer 配置追加。

`agent_assistants/channel_chat.py` 也选择该入口，独立提供角色、项目配置、渠道会话背景和当前发送者。它通过 `system_prompt_each_turn=True` 要求正文降级引擎在恢复会话时也传递最新背景。

`capture_prompt_input=True` 在统一入口的降级与重试选择后捕获本轮实际适配器输入，不改变首次／每轮降级策略；参数由统一入口消费，不传给 SDK。`agent_assistants/prompt_input.py` 只展示实传独立指令、正文及明确传入的历史／图片；没有独立指令时不显示该区块。持久化助手复用原字段保存格式化输入：普通／渠道对话为 `chat_messages.prompt`，流程为 `gen_sessions.messages_json` 内消息的 `prompt`，协调与经验归档为 `messages.prompt_json` 的 `prompt`。用户正文仍独立保存在 `content`；内部 `prompt_input` 不进入过程日志。历史读取优先使用对应当轮记录，不使用当前配置重新组合；重启或缓存清除后已存输入仍可查看，未捕获的历史不补造。固定角色／输出规则通过独立指令提供，变化画布／草稿／任务状态作为本轮正文背景；协调恢复轮次刷新任务快照，权限和角色规则由协调助手上下文层统一提供，捕获路径不再由 ACP 追加第二套 guard。任务创建／定时生成等创建态会话仍默认仅内存；步骤／审核的固定角色与结果格式也通过此入口传入，任务要求留在正文；`messages.prompt_json` 和 `review_runs.prompt_json` 中 `prompt` 保存实际查看记录、`input_prompt` 保存恢复用原始输入，恢复读取兼容仅有 `prompt` 的旧记录。回归见 `tests/test_prompt_input.py`、`tests/test_engine_system_prompt.py`、`tests/test_chat_session.py`（真实 API、恢复后的实际输入、配置修改不改变历史、慢读取健康检查）、`tests/test_channel_bots.py`、`tests/test_workflow_gen.py`、`tests/test_coordinator.py`、`tests/test_review_gate.py`（执行与审核的原生／正文降级、同会话重跑、检查点恢复、慢输入保存健康检查）和 `tests/test_pydantic_ai_harness.py`。

缓存取决于实际发送的稳定前缀、模型及服务商策略，独立 system/developer 指令不会自动关闭缓存。固定规则保持内容和顺序稳定；规则修改或每轮变化的背景若位于历史前，会缩短可复用前缀。WorkStep 不在这次迁移中配置缓存断点，也不承诺缓存命中率。参考 [OpenAI 提示词缓存](https://developers.openai.com/api/docs/guides/prompt-caching)、[Claude 提示词缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。

**所有引擎都必须继承 `AcpEngineBase`**；`AcpEngineBase` 继承 `BaseLLMEngine`。上层调用（`task_runner` / `coordinator` / `assistant_base` / API）只依赖 `AcpEngineBase`，不感知引擎类型。

接入任何 CLI、HTTP Agent 或 Agent SDK，本质上只做两件事：

1. **实现我方系统的 ACP 适配**：把下游的执行、会话、恢复、停止、审批、交互和事件流适配为 `AcpEngineBase` 定义的统一语义。
2. **实现 Base 引擎方法**：补齐 WorkStep 管理引擎所需的安装、发现、版本、配置、模型列表和能力声明。

Agent SDK 只是下游实现来源，不是第三套上层接口，也不得绕过 `AcpEngineBase` 新建一套 SDK 专用调用链。

```text
BaseLLMEngine(ABC)                        # 我方系统扩展：WorkStep 特有自定义函数（与协议无关）
├── 发现：is_installed / get_version / resolve_binary（抽象，必须实现）
├── 安装：install_command / install / inspect_capabilities
├── 配置：config_schema / stage_config_schema / merge_config_overrides /
│         get_config_values / get_config_secrets / save_config_values / reveal_config_value
├── 能力声明：capabilities / supports_message_history / supports_thinking_effort /
│         supports_workstep_tools / supports_vision
└── list_models

AcpEngineBase(BaseLLMEngine)              # 通用 ACP 协议调用（所有引擎继承）
├── 执行：spawn / stop / test_connection / spawn_coordinator / inject_response
├── 会话：supports_sessions / create_session / load_session / list_sessions /
│         resume_session / close_session / cancel_session / set_config_option / reset_options
├── 审批：supports_tool_approval / approve_tool / approve_tool_option
├── 交互：request_interaction / respond_interaction / handle_tool_permission /
│         normalize_event / normalize_interaction_event / send_live_stage_message
├── 恢复：supports_resume / supports_interactive / supports_live_stage_message /
│         build_resume_params
└── 能力元数据：acp_events（声明本引擎实际产出的 ACP 词汇事件集合）
```

- **ACP 原生引擎**（如 Hermes）：声明 `COMMAND` / `ENGINE_ID`，`get_command()` 非空（`_is_acp_native = True`），基类直接提供全部协议实现（ACP 客户端、会话、审批、elicitation）。
- **非 ACP 原生传输适配器**（Codex / CodexSDK / Claude Code / ClaudeAgentSDK / QoderSDK / DeepSeek Harness / PydanticAI / OpenClaw）：继承 `AcpEngineBase`，用下游传输覆盖 `spawn`，并**实现我方 ACP 接口的等价会话 / 审批语义**（无原生入口的如实声明能力并安全降级），事件统一产出 ACP 词汇。
- 新引擎 = 新增一个文件：继承 `AcpEngineBase`，实现 `BaseLLMEngine` 的抽象自定义函数，声明 `acp_events`，按第 2、3 节覆盖协议方法。

> **禁动 base 规则：为接入单个 LLM 引擎，不得修改 `engines/core/` 下的基类
> （`base.py` / `acp_base.py` 等共享协议实现）。引擎侧的服务端 quirk、恢复
> 失败形态、历史重播、事件形状差异，一律在引擎自己的适配器文件内部兼容
> （覆写 `spawn` / 事件映射 / 能力声明，或在引擎内加兜底与重试），并附
> 引擎级回归测试。基类只承载全引擎通用的协议语义。

> **统一接口不等于底层必须使用 ACP 传输。** `AcpEngineBase` 是 WorkStep
> 面向上层的通用协议接口和事件语义；CLI、HTTP、厂商 SDK、JSONL、JSON-RPC
> 都可以作为底层传输。非 ACP 原生传输适配器必须把真实能力映射到这套接口，
> 上层与前端不得根据底层传输类型分叉。`_is_acp_native` 只说明是否直接连接
> ACP 服务端，不决定该引擎能否用于执行步骤、Agent 助手或聊天协调器。

## 1. 引擎在系统中的位置

```text
WorkflowRuntime / CoordinatorModule / AssistantRuntime
                │
                ▼
          AcpEngineBase（统一协议接口）
                │
                ▼
 CLI / ACP / HTTP API / Agent SDK
                │
                ▼
      InternalEvent 流（ACP 词汇）
                │
       ┌────────┴────────┐
       ▼                 ▼
  SQLite 消息记录     AG-UI 翻译（engines/core/agui.py）→ WebSocket 实时消息
```

引擎适配器的职责归入两组：

1. `BaseLLMEngine`：检测和描述引擎是否可用，提供安装、配置、模型与能力元数据。
2. `AcpEngineBase`：接收标准参数执行 LLM 回合，把下游协议转换成 ACP 词汇 `InternalEvent`，并实现会话、恢复、审批、交互、取消与资源释放语义。

引擎不应自行修改任务、步骤、消息或审核状态，这些由 `TaskRunner`、`ReviewGate` 和协调模块统一处理。

## 2. 选择实现方式

### 2.1 ACP 原生 Agent（JSON-RPC）

继承 `AcpEngineBase`，提供命令、引擎 ID 和权限模式即可——事件、会话、审批、elicitation 全部由基类提供：

```python
class MyAcpEngine(AcpEngineBase):
    ENGINE_ID = "my_acp"
    COMMAND = ["my-agent", "--stdio"]          # ACP 网关启动命令
    REQUIRES_PERMISSION_MODE = False
```

基类已经处理：

- Agent 初始化（`initialize` / `new_session` / `load_session`）。
- 会话生命周期（`session/new`、`session/load`、`session/resume`、`session/list`、`session/close`、`session/cancel`、协商后的 `session/fork`）。
- 初始化后必须按 Agent capabilities 调用可选方法；图片、附加目录及 HTTP/SSE/ACP MCP transport 未声明时应显式拒绝，不能静默丢弃。
- 客户端只声明实际支持的能力：当前支持表单/URL elicitation、Plan 更新和 boolean config options；客户端文件系统/终端不声明。
- ACP 工具更新完整保留 `content`、`locations`、`status` 与 `_meta`，并继续透传到 AG-UI；未知通知仍进入 `acp_raw`。
- 兼容认证、旧 Session Mode 入口及通过扩展 transport 调用的 NES 草案方法。
- 模型配置（`set_config_option`）。
- 文本、思考、工具调用、计划、用量、MCP、elicitation 等全部 session update 的事件映射。
- 权限审批（`request_permission` → `interaction_request`）与表单询问（`create_elicitation` → `elicitation_request`）。
- 进程退出与异常转换。

参考：`apps/daemon/engines/hermes.py`。仓库内 `claude_acp` / `codex_acp` / `qoder_acp` 三个 ACP 引擎已移除，不再注册。

### 2.2 直接 CLI

继承 `AcpEngineBase`，用自己的传输实现 `spawn`。适用于 `claude -p`、`codex exec` 等命令行程序。

必须自行实现：

- 二进制定位和版本检测（`resolve_binary` / `get_version`）。
- `asyncio.create_subprocess_exec` 生命周期与 `stop`。
- stdin 输入协议与 stdout/stderr 流解析 → ACP 词汇事件。
- 取消和进程回收。
- 会话 ID 提取（`session_started`）与恢复（`spawn(session_id=...)`）。
- 审批语义（如 Codex 沙箱拒绝 → 弹窗 → 批准后提权重试）。
- 声明 `acp_events` 实际子集。

参考：`apps/daemon/engines/claude_code.py`、`apps/daemon/engines/codex.py`。

### 2.3 HTTP API 或进程内 Agent

继承 `AcpEngineBase`，`is_installed()` 通常返回 `True`，并通过 `is_configured()` 判断 URL、模型和密钥是否齐全；`spawn` 在进程内驱动 Agent 并映射事件。

参考：`apps/daemon/engines/pydantic_ai/engine.py`（内置 Pydantic AI 引擎，绑定供应商 base_url/key，配置由后端模板驱动）。

### 2.4 Agent SDK（Claude / Qoder / Codex / DeepSeek Harness）

图片输入由各引擎适配器决定，ACP 基类与助手调用层保持正文和附件分离。Codex CLI 用 `--image <本地路径>`，恢复和重试同样支持，远程 URL 明确拒绝；Codex SDK 用官方 `TextInput`、`LocalImageInput`、`ImageInput`，计划/目标模式通过原生 turn-start 输入图片块。两者声明 `supports_vision=True`，不把附图提示或 base64 拼入正文；WorkStep 提示词快照只保存图片引用，Codex 自己的会话历史仍由 Codex 管理。

Agent SDK 的接入仍然是“我方 ACP 适配 + Base 引擎方法”，没有 SDK 专用的上层接口。适配器继承 `AcpEngineBase`，在进程内调用官方 SDK 驱动 Agent（例如 Claude Code 的 `claude-agent-sdk`、Qoder 的 `qoder-agent-sdk`、Codex 的 `openai-codex`、DeepSeek 的 `deepseek-harness-sdk`）。

SDK 可以封装子进程、JSONL、JSON-RPC 或进程内消息流；这些都是适配器内部细节。适配器消费 SDK 的完整事件流，映射为 ACP 词汇 `InternalEvent`，并通过 `AcpEngineBase` 的统一会话和交互方法向上提供能力。上层不得直接依赖厂商 SDK 类型或消息对象。

- `is_installed()` 需要 SDK 可导入且二进制存在；`resolve_binary()` 按各 SDK 的查找顺序实现（配置覆盖 → 环境变量 → SDK 捆绑二进制 → PATH）。
- 会话恢复：Claude SDK `resume` 选项、Qoder SDK `options.resume`、Codex SDK `thread_resume`。
- DeepSeek Harness 在首次 `spawn` 生成并发布 `session_started`，上层保存 ID 并在后续轮次传回。适配器按项目和配置指纹分别池化 SDK 运行时，复用同一进程和 `session_id` 延续上下文；首次初始化在线程中加锁，防止并发握手。不同模型／供应商的会话互不替换运行时，不按空闲时间回收，实例保留到停止或 daemon 退出；日志保存在项目 `.workstep/deepseek-harness/sessions/`。**持久化日志不等于可跨进程恢复**：截至 2026-10-07，PyPI 最新 `0.1.5rc1`，官方 master 的 SDK server 在内存未命中时仍调用 `agents.create`，没有调用 `agents.resume`（[官方源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/sdk/server/src/server.ts)，[上游讨论 #712](https://github.com/deepseek-ai/deepseek-harness/discussions/712)）。daemon 重启、停止关闭运行时，或同一会话改用不同运行时配置后，原会话不能保证恢复；结构化会话冲突明确报错，保留原 ID 与日志，禁止自动改 ID 开空会话。完整修复需要 SDK server 打开原生日志并通过 `agents.resume` 恢复，不能仅保存 ID 或升级当前 SDK。同步 JSON-RPC 通知必须桥接为异步事件流。它通过统一 `spawn_coordinator` 入口支持 Agent 助手和聊天协调器，按配置状态声明 `supports_coordinator`；当前 SDK 不提供审批回调，独立声明 `supports_tool_approval=False`。WorkStep 固定选择 `standard` preset：旧 SDK 显式传入 `standard.cordis.yml` 和 `session_root`；新版传入 `standard.workstep.patch.yml` 和项目 `dsh_home`。Python SDK 通过 stdio JSON-RPC 启动官方捆绑的 Node 单文件运行时，默认不依赖系统 Node。回归入口为 `tests/test_deepseek_harness_engine.py` 和 `tests/test_deepseek_harness_chat.py`（真实 API、数据库 ID 保存/恢复、慢初始化健康检查）。按需运行真实供应商验证：`uv run --no-sync --directory apps/daemon python ../../scripts/verify_deepseek_session.py`，临时项目/配置中验证三轮上下文、独立会话隔离及同 ID／PID，不改现有项目或运行中的 daemon。
- 审批：Claude/Qoder 的 `can_use_tool` 回调、Codex SDK 的 `approval_handler` 都桥接到 `handle_tool_permission` / `request_interaction`（ACP `session/request_permission` 语义）。
- 表单询问：Qoder `on_elicitation` 桥接到 ACP `elicitation/create`。
- 参考：`apps/daemon/engines/claude_agent_sdk.py`、`apps/daemon/engines/qoder_sdk.py`、`apps/daemon/engines/codex_sdk.py`、`apps/daemon/engines/deepseek_harness.py`。

## 3. 必须实现的接口

### 3.1 `BaseLLMEngine` 自定义函数（抽象，必须实现）

| 接口 | 必须 | 说明 |
|---|---:|---|
| `is_installed()` | 是 | 本机是否具备运行条件。CLI 检查二进制，内置 API Adapter 通常返回 `True`。 |
| `get_version()` | 是 | 返回版本字符串；无法获取时返回 `None`。不得无限等待。 |
| `resolve_binary()` | 是 | 返回实际命令路径或 Adapter 标识；不可用时返回 `None`。 |
| `install_command()` | 否 | 返回该引擎可执行的安装命令字符串；不支持自动安装时返回 `None`。 |
| `install()` | 否 | 安装该引擎所需运行时（CLI 二进制或 Python SDK）。基类默认返回「无需安装」。 |
| `config_schema()` / `get_config_values()` / `save_config_values()` 等 | 否 | 有专属配置时声明（见 4.6）。 |
| `supports_vision` / `supports_workstep_tools` / `supports_thinking_effort` 等 | 否 | 如实声明能力，不夸大。`supports_workstep_tools` 只表示引擎能承载原生 `workstep_call` 工具（机制）；哪个助手加载它由助手配置决定。 |

### 3.2 `AcpEngineBase` 协议方法（按传输类型适配）

| 接口 | ACP 原生传输 | 其他传输适配器 | 说明 |
|---|---|---|---|
| `spawn(...)` | 基类实现 | **必须覆盖** | 启动一次执行并异步产出 ACP 词汇 `InternalEvent`。 |
| `stop()` | 基类实现 | 必须覆盖 | 停止当前执行。必须可重复调用，并在无运行任务时安全返回。 |
| `inject_response(...)` | 基类实现 | 按需覆盖 | 中途注入用户响应；不支持时记录日志并安全返回。 |
| `send_live_stage_message(content)` | 基类实现 | 按需覆盖 | 执行中注入普通用户消息；返回是否被接受，并同步 `supports_live_stage_message`。 |
| `supports_sessions` / `create_session` / `resume_session` / `close_session` / `cancel_session` / `set_config_option` / `reset_options` | 基类实现（ACP 客户端） | **按能力覆盖** | 见 3.3。 |
| `supports_tool_approval` / `approve_tool` / `approve_tool_option` | 基类实现 | 基类统一解析 + 按能力声明 | 见 3.4。 |
| `respond_interaction(...)` | 基类实现 | 基类实现 | 将统一的 ACP 响应送回引擎；只有原生协议需要覆盖。 |
| `supports_resume` / `supports_interactive` / `supports_live_stage_message` / `build_resume_params(...)` | 基类实现 | 按能力覆盖 | 如实声明。 |
| `acp_events` | 继承全集 | **必须声明实际子集** | 见 3.5。 |

### 3.3 会话方法（非 ACP 原生传输适配器）

非 ACP 原生传输适配器用自己的传输实现我方 ACP `session/*` 的等价语义，**无原生入口的如实声明能力并安全降级**：

- `supports_sessions`：是否按会话 ID 恢复（Codex `exec resume`、Codex SDK `thread_resume`、Claude `--resume`、Claude/Qoder SDK `resume` 为 `True`；Pydantic AI、OpenClaw 为 `False`）。
- `create_session(cwd)`：有原生空会话创建则返回真实 ID；无法脱离提示词创建空会话时返回 `None` 并记录日志（会话在首次 `spawn` 的 `session_started` 时建立）。
- `resume_session(session_id, cwd)`：支持恢复的引擎返回 `bool(session_id)`（`spawn(session_id=...)` 时实际恢复）；无会话能力的引擎返回 `False`。
- `close_session` / `cancel_session`：等价结束当前运行中的进程 / client；无运行任务时安全返回。
- `set_config_option` / `reset_options`：配置在 `spawn` 时从 `config_store` 读取，运行中修改无原生入口时安全 no-op。
- `load_session` / `list_sessions`：无原生实现时保持基类默认（`False` / `[]`）。

手动 `/compact` 只作用于已有引擎会话。ACP 原生 Agent 必须先通过 `available_commands_update` 声明 `compact`，WorkStep 才把它作为单个文本块送入 `session/prompt`；这不是独立的 ACP 方法。Codex CLI 与 Codex SDK 通过官方 SDK 的 `thread.compact()` 执行，并等待 `thread/compacted`。Claude Code、Claude Agent SDK 和 Qoder SDK 沿各自的斜杠命令传输发送，并以 `compacted` 事件确认。OpenClaw 的当前一次性 `agent exec`、Pydantic AI 及 WorkStep 当前的 DeepSeek Harness 组合没有同会话手动压缩入口，不展示该命令，也不得将其当普通提示词发送给模型。手动压缩不得使用执行失败自动重试，以免重复压缩。

### 3.4 审批方法（非 ACP 原生传输适配器）

非 ACP 原生传输适配器的 `request_permission` 在 `request_interaction` 中自动登记到基类 pending 审批注册表（`tool_call_id → interaction_request`）；上层调用 `approve_tool(tool_use_id, approved)` 或 `approve_tool_option(tool_use_id, option_id)` 时，基类把决定（`allow_once` / `reject_once` / 指定 `option_id`）写回挂起的交互。

- `supports_tool_approval`：有审批弹窗能力的引擎（Codex / CodexSDK / Claude / ClaudeAgentSDK / QoderSDK / PydanticAI）为 `True`，并确保 `interaction_request` 在 `acp_events` 中；无审批能力的引擎（OpenClaw）保持 `False`。
- 引擎的权限回调（`can_use_tool` / `approval_handler` / 沙箱拒绝路径）只需调用 `request_interaction` / `handle_tool_permission`，不要自己实现第二套审批通道。

### 3.5 `acp_events` 能力声明

**声明 = 实际**：每个引擎声明自己实际产出的 ACP 词汇事件集合（`frozenset[str]`），有原生等价就映射，无来源不发、不合成默认值。**能力覆盖原则**：引擎原生支持某类语义（子代理/后台任务、计划、思考、审批等），就必须映射为对应的 ACP/编排事件，不得降级为普通 `tool_call` 或丢弃；`acp_events` 缺席某类型即承诺“本引擎无此来源”。新引擎接入时先列出下游原生能力清单，对照 `ACP_EVENTS` 逐项打勾。契约测试（`tests/test_engine_base_hierarchy.py`）保证：

- `acp_events ⊆ ACP_EVENTS`（`engines/core/acp_base.py` 定义完整词汇，25 种）。
- ACP 原生引擎继承即声明全集。
- 非 ACP 原生传输适配器声明**实际子集**（如 Claude/Qoder SDK 无 plan 事件源，不声明 `plan`），且映射路径实际产出的事件类型都被声明。

```python
acp_events: frozenset[str] = frozenset({
    "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update",
    "usage_update", "status", "session_started", "error",
})
```

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

模型列表只在用户展开选择时按需请求（`GET /api/engine/{id}/models`）；引擎列表接口 `/api/engine/list` 不会批量拉取每个引擎的模型，避免设置页打开时逐个请求拖慢响应。前端按引擎对结果做内存缓存，同一会话内切页、切引擎不再重复调用远程接口；只有用户点击「刷新」等手动操作（或引擎配置、可执行路径变更后）才会重新请求。

### 4.3 `test_connection(cwd, timeout_seconds)`

基类会发送无工具、无文件修改的最小测试提示词。通常无需覆盖。

以下场景可覆盖：

- Provider 提供更便宜的健康检查接口。
- 引擎必须使用特殊输入格式。
- 需要在测试前验证认证或权限模式。

连接测试必须验证真实对话链路，不能只检查二进制存在。

### 4.4 `install_command()` / `install()`

SDK 与 CLI 引擎不在项目内预装依赖，而是在设置页检测到未安装时，由用户点击「安装」按钮按需下载：

- `install_command()` 返回给人看的命令（如 `npm install -g @openai/codex`、`pip install claude-agent-sdk`），返回 `None` 表示不支持自动安装（内置引擎、占位后端），设置页不展示安装按钮。
- `install()` 执行实际安装，返回 `EngineInstallResult(success, message, already_installed)`。基类提供两个辅助函数：
  - `install_with_command(cmd, display=...)`：运行任意安装命令（npm 等）并归纳结果。
  - `install_python_package(package)`：安装 Python SDK 包；优先 `uv pip install --python <当前解释器>`（uv 虚拟环境通常没有 pip），回退 `python -m pip install`，保证装进 Daemon 运行环境、无需重启即可被 `is_installed()` 识别。
- 已实现：Claude Code CLI / Codex CLI 走 `npm install -g`；Claude Agent SDK / Codex Agent SDK / Qoder Agent SDK 走 Python 包安装（SDK wheel 自带捆绑 CLI，无需单独装 CLI）。
- 安装接口：`POST /api/engine/{engine_id}/install`。安装成功后自动 `refresh_registry()` 重新扫描，使该引擎立即进入列表。

### 4.5 `spawn_coordinator` / `coordinator_guard`

协调助手通过 `spawn_coordinator_with_retry` 提供自己的角色、权限与提案规则，ACP 捕获路径只做适配与传输，不追加规范。旧的未启用输入捕获的 `spawn_coordinator` 调用仍保留 guard 兼容。Pydantic AI 的历史及系统消息由 Harness store 恢复，不由宿主回传 `message_history`。

WorkStep 内部工具（`workstep_call`）不是引擎层能力：由助手在
`AssistantConfig.workstep_tools` 声明是否加载，引擎仅按 `workstep_tools`
标志决定是否注册原生工具；提示词不注入工具文档（docstring 即接口文档）。
PydanticAI 引擎在 `spawn(..., workstep_tools=True)` 时注册该工具；其他引擎
如实声明 `supports_workstep_tools=False`，不注册、提示词不变。

#### 4.5.1 `supports_coordinator` 的判定

`supports_coordinator` 表示引擎能否通过统一的 `spawn_coordinator(...)` 入口完成
Agent 助手和聊天协调器回合。它与以下能力互相独立：

- 是否为 ACP 原生引擎（`_is_acp_native`）；
- 是否支持工具审批（`supports_tool_approval`）；
- 是否支持 WorkStep 内部工具（`supports_workstep_tools`）；
- 是否支持运行中消息注入（`supports_live_stage_message`）。

只要适配器能接收协调器标准参数、通过 `spawn` 产出统一事件，并遵守
`spawn_coordinator` 加入的协调器约束，就应声明支持。通常沿用基类默认语义，
即 `supports_coordinator=self.is_configured()`。

不得因为引擎不是 ACP 原生传输，或因为它没有审批回调，就把
`supports_coordinator` 设为 `False`。例如 DeepSeek Harness 使用官方 SDK 的
JSON-RPC 通知，并且暂不支持工具审批，但它实现了统一协调器入口，因此声明
`supports_coordinator=self.is_configured()`、`supports_tool_approval=False`。

前端的「设置 → Agent 助手」和聊天框协调器选择器都要求
`supports_coordinator=True`；同时仍执行通用可用性检查：`installed`、
`configured`、`verified`。接入完成后必须覆盖这两个入口的选择器回归测试，
避免能力声明错误导致引擎被隐藏。

### 4.6 配置模板

引擎有专属配置时，在实现类上声明 `config_schema()` 并实现 `get_config_values()`、`get_config_secrets()`、`save_config_values()`、`reveal_config_value()`。设置页从 `/api/engine/list` 内嵌的模板自动渲染表单，保存走通用 `PUT /api/engine/{id}/config`，不需要为引擎编写专有配置接口。

不要复用其他引擎的 API Key、Base URL、权限模式或模型配置键；每个引擎的配置键只在自己的 schema 中声明。

供应商可以声明多个线协议，并为每个协议保存独立的 API 基础地址
（`protocol_base_urls`），API Key 仍由供应商共享。地址中的版本路径由供应商配置原样提供，
例如 `/v1`、`/v2` 或 `/v1beta/openai`；适配层不得猜测、添加或删除版本段，只能在所选协议
地址后追加 `models`、`chat/completions` 等端点。旧版单值 `protocol` / `base_url` 继续作为
首选协议和所有协议共用地址的兼容输入。引擎绑定供应商时以协议集合交集判定兼容，并把该引擎
实际选择的协议及其对应地址传入运行时。

引擎级配置与步骤级覆盖关系（`merge_config_overrides`）：

| 引擎 | 配置键 | 写入目标 |
|---|---|---|
| Claude Code（`engines/claude_code.py`） | `permission_mode`（`acceptEdits` / `bypassPermissions` 等，需确认） | CLI `--permission-mode` |
| Codex（`engines/codex.py`） | `sandbox_mode`、`model_reasoning_effort`、`approval_policy` | CLI `--sandbox` / `-c model_reasoning_effort=...` / `-c approval_policy=...` |
| Claude Agent SDK（`engines/claude_agent_sdk.py`） | `permission_mode`、`max_turns`、`fallback_model` | 写入 `ClaudeAgentOptions`（`permission_mode` / `max_turns` / `fallback_model`） |
| Codex Agent SDK（`engines/codex_sdk.py`） | `model_reasoning_effort`、`approval_mode`（`auto_review` / `deny_all`）、`sandbox`（`read-only` / `workspace-write` / `danger-full-access`→SDK `full-access`） | `thread_start` / `thread_resume` 的 `config={"model_reasoning_effort": ...}`、`approval_mode=ApprovalMode(...)`、`sandbox=Sandbox(...)`；协调模式强制 `read_only` |
| Qoder Agent SDK（`engines/qoder_sdk.py`） | `personal_access_token`（PAT，敏感字段）、`permission_mode`（`default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto`）、`model`、`allowed_tools`（工具白名单）、`max_turns`、`include_partial_messages`（流式输出） | 写入 `QoderAgentOptions`（`auth=access_token(token)`、`permission_mode`、`model`、`allowed_tools`、`max_turns`、`include_partial_messages`）；`bypassPermissions` 同时置 `allow_dangerously_skip_permissions=True` |
| DeepSeek Harness（`engines/deepseek_harness.py`） | `provider_id`、`max_tokens`、`preset`（当前为 `standard`） | 复用 DeepSeek 类型供应商的 `base_url` / `api_key`，写入官方 `DeepSeekHarness`；模型沿用通用引擎默认模型；`preset` 解析为我方随版本校验的 Cordis composition |
| Pydantic AI（`engines/pydantic_ai/engine.py`） | `provider_id` | 供应商 base_url/key 构建模型（`model` / `thinking_effort` 由助手配置经 `spawn` 参数传入）；`thinking_effort` 映射为 `Thinking` capability；Harness 核心能力固定挂载，压缩与持久化按 `auto` 处理（见 4.7） |

校验规则集中在 `services/config.py`（`set_codex_config` / `set_codex_sdk_config` / `set_claude_agent_sdk_config` / `set_qoder_sdk_config`）：`max_turns` 必须为正整数，枚举值非法时抛中文 `ValueError`。

#### DeepSeek Harness preset 与插件组合

Harness 的 Python SDK 接收的是 `cordis` composition 路径，不直接接收 CLI 的 preset 名称。CLI 随产品发布的 `standard`、`minimal`、`code`、`cordis` 是 Agent-plane preset，还依赖 CLI/Web Host composition，不能把对应的 `agent.cordis.yml` 单独传给 SDK。

WorkStep 因此定义一个 SDK 可独立启动的 `standard` preset，基于官方 `jsonrpc-agent` standalone composition 装配并固定以下能力：

| 能力 | Cordis 插件 |
|---|---|
| JSON-RPC SDK 服务 | `@deepseek-ai/dsh-sdk-jsonrpc-server` |
| DeepSeek 模型路由 | `@deepseek-ai/dsh-llm-deepseek` |
| 编码 Agent、工作区指令、Skills、Bash、后台任务 | `@deepseek-ai/dsh-agent-spine-demo` |
| 本地命令执行 | `@deepseek-ai/dsh-subprocess-local` + `@deepseek-ai/dsh-bash-local` |
| 文件读写 | `@deepseek-ai/dsh-fs-local` + `@deepseek-ai/dsh-fs-observation-policy` + `@deepseek-ai/dsh-tool-fs` |
| 子代理 | `@deepseek-ai/dsh-subagent` + `@deepseek-ai/dsh-subagent-spawn-in-process` + `@deepseek-ai/dsh-tool-subagent` |
| Todo / 计划投影 | `@deepseek-ai/dsh-tool-todo` |
| 会话恢复 | `@deepseek-ai/dsh-session-persistence-jsonl` + `@deepseek-ai/dsh-session-checkpoint-policy` |
| Token 计量与压缩 | `@deepseek-ai/dsh-token-meter` + `@deepseek-ai/dsh-compaction-basic` |

新增 preset 时必须提供一份能由 SDK runtime 独立启动的完整 composition，加入 `PRESET_COMPOSITIONS` 白名单并覆盖启动测试；不能仅把 CLI preset 名称透传给 SDK。插件产生的事件仍需按“声明 = 实际”映射为我方 ACP 事件，未知事件走 `acp_raw`，不得让前端直接消费 Cordis/SDK 通知。

### 4.7 Pydantic AI harness 能力

`pydantic-ai-harness` 是 PydanticAI 引擎的固定依赖（不是独立引擎、也不替代
`AcpEngineBase` 的会话/审批缝）。引擎在 `Agent(..., capabilities=[...])` 挂载：

- `Coder(project_root)`；项目记忆只使用流程层注入的 `.workstep/MEMORY.md`，不挂载 Harness 私有 Memory；
- `Skills(project_root / ".workstep" / "skills")`，目录内容只来自 SkillCenter 白名单镜像；
- 有效的 `thinking_effort` 通过 Pydantic AI `Thinking(effort=...)` 挂载，不再传入 `model_settings.thinking`。

- 压缩与持久化开关：动态配置不暴露 `harness` 字段（见 4.6），保存配置时统一写回 `harness="auto"`；旧配置显式为 `off` 时仅停用下列扩展并回退 `message_history`。
- 扩展能力（`_harness_capabilities`）：
  - `TieredCompaction(target_fraction=0.9, tiers=[ClearToolResults(max_messages=200, keep_pairs=10), SummarizingCompaction(max_messages=120, keep_messages=30, receipts=True)])`：上下文超限时自动压缩；
  - `WarnNearLimits(max_context_fraction=0.85)`：接近上限时告警；
  - `StepPersistence(store, agent_name="workstep")`：会话持久化，store 为
    `SqliteStepStore(database=<项目根>/.workstep/harness_runs.db, max_snapshots_per_run=30)`。
- 会话恢复：`spawn(..., session_id=...)` 开启时以 `conversation_id=session_id` 调用
  `continue_run` 恢复最近一个有快照的 run（跳过重试时刚注册但尚无快照的新 run）；无可恢复
  快照时回退 `message_history`。持久化后不再依赖
  `engine_state` 往返携带消息历史（`engine_state` 事件仍保留用于协调只读 turn）。
- 请求次数保护：每次 `Agent.run_stream_events()` 显式传入
  `UsageLimits(request_limit=100)`，避免长编码任务撞上 SDK 默认 50 次上限，同时保留循环失控保护。
- 工具纠错：`Agent` 使用 `retries={"tools": 3, "output": 1}`，允许模型修正 Harness 工具的
  参数类型错误，同时保持最终输出校验的默认重试强度。
- Coder shell：在 Harness 默认命令基础上补充 `yarn/npm/npx/node`，满足前端检查和构建；命令
  固定从项目根执行，提示词明确禁止 `cd/bash/sh`，子目录任务使用 `yarn --cwd apps/web ...` 或
  `uv --project apps/daemon ...`，不通过 shell 包装器绕过白名单。`WorkStepCoder` 将 Shell 的
  命令策略拒绝转换为普通模型可见工具结果，不消耗 `run_command` 的工具重试预算；参数 schema
  错误等真正需要模型修正的调用仍使用上述 3 次重试限制。
- `compacted` 事件：本轮压缩接收（receipt）在 run 结束后经 `open_receipt_scope` /
  `drain_receipts` 排空，映射为 `InternalEvent("compacted", {"summary": ...})`
  （`acp_events` 已声明 `compacted`，见 5.2）。

关键参考：https://pydantic.dev/docs/ai/harness/compaction/ ；能力类位于
`pydantic_ai_harness.compaction` / `pydantic_ai_harness.step_persistence`。

## 5. `InternalEvent` 协议（ACP 词汇）

所有下游协议必须转换成以下统一事件。**引擎内容事件直接采用 ACP session update 词汇**（见 `engines/core/events.py` 的 `ACP_CONTENT_EVENT_TYPES`），编排事件（`status` / `session_started` / `live_message` / `error` 等）与非 ACP 词汇共存于 `InternalEvent`；对外由 `agui.py` 统一翻译为 AG-UI。

### 5.1 引擎内容事件（ACP 词汇）

| 事件 | 必要字段 | 用途 |
|---|---|---|
| `agent_message_chunk` | `content.text` | 助手正文增量，会拼接到最终消息。 |
| `agent_thought_chunk` | `content.text` | 思考或推理过程，显示在可折叠执行记录中。 |
| `user_message_chunk` | `content.text` | 用户消息分片（ACP 原生回显；其他传输无来源可不产出）。 |
| `tool_call` | `tool_call_id`、`title`、`raw_input` | 工具调用开始（完整快照）；`kind`（`read`/`edit`/`execute`/`other`）可选。 |
| `tool_call_update` | `tool_call_id`、`status` | 工具进度 / 结果：`status` ∈ `pending` / `in_progress` / `completed` / `failed`；`raw_input` 为参数增量（实时专用，不持久化），`raw_output` 为结果。 |
| `plan` | `entries` | ACP v1 stable 执行计划完整快照；每项为 `content`、`priority`、`status`。 |
| `plan_update` / `plan_removed` | `id` 等 | 计划增量 / 删除（ACP 原生）；其他传输无来源可不产出。 |
| `usage_update` | token 字段 | 上下文用量 + Token 统计 + 可选 `cost`（见 5.2）。 |
| `session_info_update` / `available_commands_update` / `config_option_update` / `current_mode_update` / `mcp_message` / `elicitation_completed` | 视字段 | ACP 原生会话 / 命令 / 配置 / 模式 / MCP / elicitation 完成通知；其他传输无来源不产出。 |
| `acp_raw` | 原样 | 未知 ACP update 透传，禁止静默丢弃（`_map_notification` 兜底）。 |

### 5.2 编排事件（所有引擎）

| 事件 | 必要字段 | 用途 |
|---|---|---|
| `status` | `status` | `initializing`、`running`、`done`、`cancelled` 等生命周期状态。 |
| `session_started` | `session_id` | 本次运行的会话标识。**所有引擎必须产出**（真实会话 ID，或本次运行生成的 UUID）；支持恢复的引擎用它做 Session 复用。 |
| `live_message` | `message_id`、`status` | 执行中补充消息的送达状态（`delivered` / `error`）。 |
| `interaction_request` | `interaction_id`、`method` | 暂停执行并请求用户确认或输入；载荷采用 ACP `session/request_permission` 或 `elicitation/create` 形状。 |
| `interaction_response` | `interaction_id`、`method`、`response` | 用户响应已送回引擎；与请求一起持久化，供消息历史恢复交互状态。 |
| `subagent` | `task_id`、`status`、`stage` | 所有引擎共用的子代理生命周期。可选 `agent_name`（短名称）、`agent_path`（层级标识，非磁盘路径）、`prompt`（真实委派输入）、`started_at/ended_at`（Unix 毫秒）、`result`（最终输出）；兼容 `description/summary/usage/tool_use_id` 和嵌套 `event`。`status` 为 `pending/running/paused/completed/failed/stopped/killed`，`stage` 保留原生阶段。适配器自行使用原生事件、工具输入、回调或异步子线程查询提取字段；未知字段缺省，不拼造提示词或完成结果。`AcpEngineBase.normalize_event` 的共享 tracker 记录已观察到的生命周期时间并冻结终态，晚到结果不延长耗时。独立于 `plan` 展示，对外统一转换为 `CUSTOM workstep.subagent`。 |
| `compacted` | `summary`（可选） | 引擎上下文已自动压缩（Claude `compacted`/`compact_boundary`、Codex `thread/compacted`、Qoder `compact_boundary`、Pydantic AI harness `TieredCompaction` 接收）；`summary` 为压缩摘要。 |
| `engine_state` | `state` | 进程内引擎可序列化的恢复状态；仅支持该能力的引擎产出（Pydantic AI `report_engine_state`）。 |
| `error` | `message` | 可展示的错误；可附加 `detail`、`stderr`。 |
| `a2ui` | `payload` | A2UI 结构化载荷（前端按 messageId 追加）。 |

这是所有 LLM 引擎适配器的强制协议，不是可选增强：

- 下游提供正文增量时，必须映射为 `agent_message_chunk`。
- 下游提供 reasoning、thinking、analysis 或 thought 内容时，必须映射为 `agent_thought_chunk`，禁止混入正文或静默丢弃。
- 下游发起工具调用时，必须在工具开始执行前映射为 `tool_call`；参数分片可额外映射为 `tool_call_update(status=in_progress, raw_input=...)`。
- 适配器或 Agent 实际执行工具时，必须在执行结束后映射为 `tool_call_update`（`completed` / `failed`），并保持相同的 `tool_call_id`。
- 引擎发布执行计划时必须映射为 `plan`；这是当前 LLM run 的展示状态，不得修改 WorkStep 工作流 DAG。
- 引擎产生子代理 / 后台任务生命周期事件（如 Claude/Qoder 的 `task_started` / `task_progress` / `task_updated` / `task_notification`）时必须映射为 `subagent`，不得因子代理状态生成 `plan`。
- 协议没有独立子代理事件、且无任何子代理语义来源时，委托类工具调用（`Task` / `spawnAgent` 等）保持为 `tool_call` / `tool_call_update`；不要将委托提示词当作计划条目，也不要伪造 `subagent` 事件。Codex 的原生协作快照可以映射为 `subagent`。
- 有委托语义来源（`Task` / `task` / `spawnAgent` / `background` 工具、child session、可恢复 `task_id` 句柄）时必须提升为 `subagent`（原工具事件嵌 `data.event`，`stage` 保留原始帧，`status` 用语义状态）；如 OpenCode 的 `task` 工具创建 child session 即属此类，不得降级为普通 `tool_call`。
- Provider 没有返回思考内容，或当前模式没有工具能力时，可以不产生对应事件，但不得伪造思考、工具调用或工具结果。
- 只提供最终完整消息的协议也必须完成相同映射，只是无法承诺增量实时性；引擎说明和测试中必须明确该降级（如 OpenClaw 一次性信封只产出单个 `agent_message_chunk`）。

推荐使用 `engines/core/events.py` 的构建辅助函数，保证字段形状统一：

```python
yield InternalEvent("status", {"status": "running"})
yield agent_thought_chunk("正在分析任务")            # → {"type":"agent_thought_chunk","data":{"content":{"text":"..."}}}
yield tool_call_event("tool-1", "Read", kind="read", raw_input={"file_path": "README.md"})
yield tool_call_update_event("tool-1", "completed", raw_output="...")
yield agent_message_chunk("任务已完成")
yield usage_update_event({
    "input_tokens": 100,
    "output_tokens": 20,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 30,
    "total_tokens": 120,
})
yield InternalEvent("status", {"status": "done"})
```

### 5.3 Token 规范化

优先使用 `normalize_token_usage()`，统一 Provider 的不同字段名称。至少提供：

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `total_tokens`

没有真实数据时填 `0`，禁止伪造估算值。`usage_update` 应在消息完成前产出，前端只在完成后展示统计。

#### 累计用量与当前上下文快照

`usage_update` 同时承载 Token/费用统计和上下文快照，适配器必须先区分两者的时间语义：

| 类型 | 典型来源 | 是否可携带 `size` | 压缩后表现 |
|---|---|---|---|
| 当前上下文快照 | ACP `usage_update.used/size`、Codex SDK `token_usage.last`、Claude SDK `get_context_usage()` | 可以 | `used` 可以下降 |
| 单次模型请求 usage | Claude assistant message usage 等 | 仅在已知该请求的窗口时可以 | 压缩后下一次请求会变小 |
| 会话/运行累计 usage | Claude `ResultMessage.usage`、Codex SDK `token_usage.total`、账单合计 | **禁止** | 单调增长，压缩不会清零 |

强制不变量：

- `size` 是“这条事件可用于计算上下文百分比”的语义标记，不是普通的模型元数据。
- 不得给累计 usage 补默认窗口；否则多轮合计会被误报为 `100%`，并在压缩后仍不下降。
- 缓存创建/读取 Token 只能在**单次请求快照**中加入当前上下文；禁止对会话累计缓存 Token 求和后当作当前上下文。
- Provider 只给累计用量时，仍应上报 Token/费用，但省略 `size`；前端将不显示不可信的百分比。
- 前端必须忽略快照自身 `used > size` 的不可能历史数据，但仍可在合法快照之后叠加未被快照覆盖的流式事件估算。
- `compacted` 只表示引擎确实发生压缩，不得人工清零累计 usage 或伪造新快照。

当前引擎口径：

- Claude Agent SDK：优先使用 `get_context_usage()` 的 `totalTokens/rawMaxTokens`；旧版本或控制请求不可用时，回退到 assistant message 的单次 usage。
- Claude Code CLI：使用 assistant message 的单次 usage，未上报窗口时按 WorkStep 的 Claude 默认 `256000`；`result.usage` 仅用于累计 Token/费用。
- Codex SDK：仅 `token_usage.last` 可与 `model_context_window` 组成快照；降级到 `token_usage.total` 时必须省略 `size`。
- ACP/Hermes：直接使用协议原生 `used/size`。
- Pydantic AI：从压缩后的当前消息历史估算 `used`，窗口由实际模型解析；这与 run 累计 usage 分开。
- Codex CLI、Qoder SDK、DeepSeek Harness、OpenClaw：当前只有 Token 统计时不补 `size`，直到接入可验证的当前快照来源。

新引擎的契约测试必须同时覆盖：当前快照能输出 `used/size`；累计 usage 即使超过窗口也不含 `size`；压缩后保留 Token/费用累计，但百分比跟随新的当前快照。

金额（`usage_update.data.cost`，`{amount, currency}`）来自各引擎提供方的账单字段：Claude Agent SDK / Claude Code CLI 的 `total_cost_usd`、Pydantic AI 的 `RunUsage.cost`（内置模型定价）、ACP/Hermes 的 cost 字段；Codex CLI / Codex SDK / OpenAI 风格 API 的 usage 不含金额，需要按模型定价表自行计算。`used` / `size`（上下文窗口用量）只能来自已确认的当前快照；只有适配器明确记录的窗口默认值可作降级，且绝不得与累计 usage 组合。

### 5.4 实时流要求

- CLI 支持 partial/delta 协议时必须开启。
- 如果同时收到增量事件和完整消息事件，只能选择一种作为正文来源，避免重复文本。
- 工具参数可能分片到达，应累计到完整后再产出 `tool_call`，或经 `tool_call_update(status=in_progress, raw_input=...)` 增量上报。
- 长时间只有思考或工具调用时，仍应持续产出对应事件，保证界面不是空白。
- 事件 `data` 应保持 JSON 可编码，不要放进程对象、异常实例或文件句柄。

### 5.5 Agent 事件流要求

使用 Agent SDK 时，禁止为了方便只消费最终正文流。如果 SDK 同时提供正文、思考、工具调用和工具结果事件，适配器必须使用完整事件流接口。

例如 Pydantic AI 必须使用 `Agent.run_stream_events()`，并至少映射：

| Pydantic AI 事件 | WorkStep 事件 |
|---|---|
| `PartStartEvent(TextPart)` / `PartDeltaEvent(TextPartDelta)` | `agent_message_chunk` |
| `PartStartEvent(ThinkingPart)` / `PartDeltaEvent(ThinkingPartDelta)` | `agent_thought_chunk` |
| `FunctionToolCallEvent` | `tool_call` |
| `FunctionToolResultEvent` | `tool_call_update` |
| `AgentRunResultEvent.result.usage()` | `usage_update` |

启用 harness 时（见 4.7），`run_stream_events` 传 `conversation_id=session_id`，种子历史优先经
`continue_run` 从 `.workstep/harness_runs.db` 最近一个有快照的 run 恢复（无快照回退
`message_history`），并传 `UsageLimits(request_limit=100)`；
压缩接收经 `drain_receipts` 排空后映射为 `compacted` 事件。

Claude Agent SDK 通过顶层 `query(prompt=..., options=ClaudeAgentOptions(...))` 驱动，`options.cli_path` 指定 `claude` 二进制，逐条产出消息，映射关系：

| Claude Agent SDK 消息 | WorkStep 事件 |
|---|---|
| `system`（`subtype=init`） | `status: initializing` + `session_started` |
| `system`（`subtype=error`） | `error` |
| `system`（`compact*`） | `compacted` |
| `StreamEvent.content_block_delta.text_delta` | `agent_message_chunk` |
| `StreamEvent.content_block_delta.thinking_delta` | `agent_thought_chunk` |
| `StreamEvent.content_block_delta.input_json_delta` | `tool_call_update(status=in_progress, raw_input=...)` |
| `assistant` 的 `text` block | `agent_message_chunk` |
| `assistant` 的 `thinking` block | `agent_thought_chunk` |
| `assistant` 的 `tool_use` block | `tool_call` |
| `user` 的 `tool_result` block | `tool_call_update` |
| `result` | `usage_update`，随后 `status: done` 或 `error` |

适配器必须设置 `include_partial_messages=True`。`result` 消息只在流式消息未产出正文时回退到 `result.output`，最终 `AssistantMessage` 也不得重复已经由 `StreamEvent` 发送的正文或思考；`result.usage` 经 `normalize_token_usage()` 规范化，`total_cost_usd` 附加为 `usage_update.data.cost`，`session_id` 附加为 `usage_update.data.session_id`。

`PartEndEvent` 中的完整内容不得在已经发送增量后再次发送，否则会造成正文或思考内容重复。工具参数和工具结果必须经过 JSON 安全转换后再写入事件总线。

### 5.6 执行计划快照

所有 Adapter 通过 Base 的 `normalize_event()` seam 暴露 ACP stable Plan：

```json
{
  "type": "plan",
  "data": {
    "entries": [
      {"content": "实现功能", "priority": "high", "status": "in_progress"},
      {"content": "运行测试", "priority": "medium", "status": "pending"}
    ],
    "explanation": "可选说明"
  }
}
```

- `priority` 只允许 `high` / `medium` / `low`，缺失时归一为 `medium`。
- `status` 只允许 `pending` / `in_progress` / `completed`。
- 每个事件都是完整快照；消息组件使用最新快照整体替换，不能按数组位置自行 patch。
- ACP/Hermes 的 `schema.Plan` 直接映射；Codex 的 `turn/plan/updated` 转换状态大小写；Claude/Qoder 的 `TodoWrite` 或 `TaskCreate` / `TaskUpdate` / `TaskList` 由 Base 聚合为快照。
- Pydantic AI 注册公共 `update_plan` 工具，多步骤任务开始或状态变化时由模型调用。
- 不具备专用 Plan 事件、但会发标准任务工具调用的 Adapter，也会自动获得相同能力。

## 6. 生命周期和异常处理

推荐生命周期：

```text
配置验证
  → initializing
  → 创建进程/连接
  → session_started（所有引擎必须产出）
  → running
  → agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update
  → usage_update（可选）
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

所有引擎（含无状态引擎）首次产出 `session_started`，携带本次运行的会话标识：

- 有原生会话的引擎上报真实会话 ID（如 Codex `thread.started.thread_id`、ACP `session_id`、Claude JSONL `session_id`）。
- 无状态引擎（Pydantic AI）生成本次运行 UUID；OpenClaw 优先采用 `agent exec --json` 信封的 `sessionId`，缺失时生成 UUID。
- OpenClaw 使用官方稳定的 `agent exec --json` 一次性信封，不提供 Token delta，也不声明恢复能力；适配器在信封完成后产出单个 `agent_message_chunk`，这是明确的协议降级。
- Codex CLI 上报 `thread.started.thread_id`（真实会话 ID），支持经 `codex exec resume <id> <prompt>` 恢复，因此 `supports_resume = True`、`supports_sessions = True`。

Codex CLI 的执行中插入消息（`live_message_queue`）不写入进程，而是由引擎在 `spawn` 内终止当前 `codex exec` 进程，再用插入消息作为提示词 `codex exec resume <thread_id> <消息>` 重启同一会话：`thread.started` 之后插入的每条消息都会开启新的响应段，并沿用原会话上下文，因此 `supports_live_stage_message = True`（`send_live_stage_message` 仍返回 `False`，直接注入不可用）。

支持恢复时：

1. 首次建立会话后产出 `session_started`。
2. `supports_resume` 返回 `True`；有原生会话存储的引擎同时 `supports_sessions = True` 并实现 3.3 的会话方法。
3. `build_resume_params(session_id)` 返回调用 `spawn()` 所需参数。
4. 收到 `session_id` 时使用原生恢复协议，不能悄悄新建无上下文会话。
5. 恢复失败时产出明确错误，不应无提示降级为新会话。
6. `usage_update` 事件可携带 `session_id` 复述会话标识（Claude Agent SDK、Qoder SDK），供错过 `session_started` 的场景兜底。

助手只在引擎 ID 发生变化时清除引擎 Session；同一引擎切换模型、快速模型或视觉模型时保留 Session ID，并从下一轮开始使用新模型。

### 7.2 执行中交互

所有引擎统一通过 `interaction_request` / `interaction_response` 暴露执行中交互，不把 Claude、Codex、ACP 或 SDK 的私有事件泄漏到前端：

- 权限确认使用 ACP `session/request_permission`：请求带完整 `tool_call` 和 `options`，响应必须返回用户实际选择的 `option_id`，不得默认选择第一个允许项。
- 询问用户使用 ACP `elicitation/create` form：`requested_schema` 为 JSON Schema object，支持单选、多选、文本、数字和布尔输入；响应使用 `accept` / `decline` / `cancel`。
- Claude Code / Claude Agent SDK 的 `AskUserQuestion`、Qoder 的 elicitation 及其它 `ask_user` 别名，由 Base 层转换为上述 form。
- 进程内 Agent 调用 `request_interaction(event, publish)` 后必须停在原工具协程，直到 `respond_interaction(...)` 解析同一个 `interaction_id`。Pydantic AI 的 `ask_user`、`write_file`、`edit_file` 都走该通道。
- 非 ACP 原生传输适配器的 `request_permission` 会在 `request_interaction` 中登记到基类 pending 审批注册表，上层 `approve_tool` / `approve_tool_option` 可直接写回决定；引擎只需调用 `request_interaction`，不要重复实现审批通道。
- 工作流层先注册等待项，再发布请求，并在等待期间持久化请求；响应后追加 `interaction_response`，刷新页面仍能显示同一张交互卡片。
- `AssistantRuntime` 和任务协程在等待交互时不阻塞其他步骤执行；交互响应与工具结果一样走统一事件流。

## 8. 资源与安全

- `stop()` 必须幂等且可重复调用；`spawn()` 的 `finally` 必须关闭子进程 / SDK client / 连接。
- 不得把 API Key、PAT、权限令牌等敏感内容写入日志或消息。

### 8.1 空闲超时保护

`TaskRunner` 对每个步骤执行带空闲看门狗：引擎在 `engine_idle_timeout_seconds`（配置 `~/.workstep/config.json`，默认 600s，0 表示关闭）内没有产生任何事件（如 API 链路卡死）时，runner 会调用 `engine.stop()` 终止引擎、关闭事件流，并把步骤标记为 `failed`（错误信息含「引擎空闲超时」）。**不会清除引擎 Session**：`taskstep.session_id` 保留，重新执行该步骤会以同一 session 恢复（如 Claude Agent SDK `--resume`）。

进程内 SDK 引擎（Claude Agent SDK、Qoder SDK）的 session 在回合结束后仍保持打开，需要主动结束。它们的输入采用**流式 prompt 源**：初始 prompt 与后续插入消息都经 `client.query(AsyncIterable)` 写入 stdin，输入源结束 → SDK `end_input()` 关闭 stdin → CLI 收到 EOF 处理完当前回合后优雅退出 → SDK 发出流结束帧（`end`），事件流随之结束。这就是确定性的「主动结束事件」，不依赖超时兜底。

这类引擎挂**回合看门狗** `sdk_turn_watchdog`（`engines/core/base.py`，所有 SDK 引擎共享，不依赖具体引擎）：收到本回合 `result`（回复结束）后检查插入队列——**队列为空立即调用 `on_idle()` 结束 prompt 源收尾，不论本回合是否插入过消息，都不等任何宽限期**；只有队列中仍有待注入消息时才保持 session，等该消息被消费进下一回合的 `result` 后再重新评估。`result` 之前已消费的注入（CLI 可能把它合并进当前回合）也不会触发保活，因此不存在「等永远不会出现的下一次 result」的卡死。若 CLI 在 `escalate_seconds`（默认 15s）内仍未退出（如后台任务挂起），再以 `disconnect()` 强制收尾。看门狗不再产生 `idle_timeout` 事件（无宽限期可超时）。

其余支持执行中插入的引擎遵循同一原则：**插入队列为空即收尾，不等待插入窗口**。`codex_sdk` 与 `pydantic_ai` 在每轮结束后直接检查队列，空队列立即结束（不再有轮间等待窗口）；`claude_code` 在 `result` 后立即 `close_stream`；`codex`（CLI）进程退出后检查队列，空队列直接结束。只有队列中已有待注入消息时才继续下一轮。回复完成后才发出的插入消息不再被接收（步骤已收尾），runner 会将其标记为 `failed`。

引擎侧注意：`spawn()` 的 `finally` 必须做好资源清理（关闭子进程/SDK client），因为空闲超时路径会先调 `stop()` 再 `aclose()` 事件流；不要在 `finally` 中依赖再次 `yield` 才能完成清理。

## 9. 注册新引擎

假设新增后端 ID 为 `my_engine`，实现类为 `MyEngine`。

### 9.1 后端注册

`apps/daemon/engines/` 根目录只放引擎：每个引擎一个模块（单文件或包），模块内定义 `AcpEngineBase` 子类并声明 `ENGINE_ID`。启动时由 `engines/core/registry.py` 自动发现并注册，**无需改动任何其他代码**。

1. 新建 `apps/daemon/engines/my_engine.py`。
2. 定义 `class MyEngine(AcpEngineBase)` 并声明 `ENGINE_ID = "my_engine"`（ACP 原生引擎同时声明 `COMMAND`）。
3. 实现 `is_installed()`、`get_version()`、`resolve_binary()`（进程类引擎）与 `spawn()` 等接口。
4. 声明 `acp_events` 实际子集；非 ACP 原生传输适配器按 3.3 / 3.4 实现会话与审批方法。
5. `__init__` 必须调用 `super().__init__()`（基类维护 pending 审批注册表与运行状态）。

约定：

- 工具类、基类、事件与注册逻辑统一放在 `engines/core/`，引擎文件之间需要共享代码时引用 `core` 或抽取到独立模块，不要污染引擎根目录。
- 引擎类通过 `engines` 命名空间自动导出（`from engines import MyEngine`），不需要手动编辑 `engines/__init__.py`。
- 同一 `ENGINE_ID` 重复定义时保留先发现的实现；排序按模块名，保证结果稳定。

`get_available_engines()` 的结果会在内存中缓存：只有手动「重新扫描」（`refresh_registry()`）或二进制路径、引擎配置变更时才重新扫描；版本探测（`binary --version` 子进程）并行执行并带 300s TTL，避免每次打开设置页都启动一堆子进程。

引擎列表的 `mode` 字段由 `get_available_engines()` 推断：`issubclass(..., AcpEngineBase) and instance._is_acp_native` 为 `acp`、`pydantic_ai` 为 `agent`、`claude_agent_sdk` / `codex_sdk` / `qoder_sdk` / `deepseek_harness` 为 `sdk`、其余为 `cli`。新增 SDK 类型引擎时需在 `core/registry.py` 同步扩展该推断；协调 Agent 回退顺序 `COORDINATOR_FALLBACK_ORDER` 会自动把新引擎追加到末尾。

### 9.2 配置模板

引擎有专属配置时，在实现类上声明 `config_schema()` 并实现 `get_config_values()`、`get_config_secrets()`、`save_config_values()`、`reveal_config_value()`（见 4.6）。设置页从 `/api/engine/list` 内嵌的模板自动渲染表单，保存走通用 `PUT /api/engine/{id}/config`，不需要为引擎编写专有配置接口。

不要复用其他引擎的 API Key、Base URL、权限模式或模型配置键；每个引擎的配置键只在自己的 schema 中声明。

### 9.3 前端元数据

在 `apps/web/src/engineMeta.ts` 增加：

- `ENGINE_LABELS`
- `ENGINE_DESCRIPTIONS`
- `ENGINE_COLORS`

配置表单由 `apps/web/src/components/EngineConfigForm.tsx` 按后端模板自动渲染，无需新增专用表单；仅当需要新控件类型时才需要同步扩展该组件。

## 10. 最小实现模板（CLI → 我方 ACP 适配）

```python
import asyncio
import shutil
from typing import AsyncIterator

from engines.core.acp_base import AcpEngineBase
from engines.core.events import (
    InternalEvent,
    agent_message_chunk,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)


class MyEngine(AcpEngineBase):
    ENGINE_ID = "my_engine"

    #: spawn 实际产出的 ACP 词汇事件（声明 = 实际；无原生来源不合成）。
    acp_events: frozenset[str] = frozenset({
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
        "usage_update",
        "status",
        "session_started",
        "error",
    })

    def __init__(self):
        super().__init__()
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

    @property
    def supports_sessions(self) -> bool:
        # 有原生会话恢复能力才声明 True（如 resume 子命令）。
        return False

    @property
    def supports_tool_approval(self) -> bool:
        return False

    async def create_session(self, cwd, add_dirs=None, mcp_servers=None) -> str | None:
        """无法脱离提示词创建空会话时返回 None，会话在首次 spawn 时建立。"""
        return None

    async def resume_session(self, session_id, cwd, add_dirs=None, mcp_servers=None) -> bool:
        return bool(session_id) if self.supports_sessions else False

    async def close_session(self, session_id, cwd=None) -> None:
        if self._running:
            await self.stop()

    async def cancel_session(self, session_id, cwd=None) -> None:
        if self._running:
            await self.stop()

    async def set_config_option(self, config_id, value, session_id=None) -> None:
        return None

    async def reset_options(self, session_id=None) -> None:
        return None

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list | None = None,
        live_message_queue: asyncio.Queue | None = None,
        config_overrides: dict | None = None,
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
            yield InternalEvent(
                "session_started", {"session_id": "session-1"}
            )
            # 逐行解析 stdout，把正文 / 工具 / 用量映射为 ACP 词汇事件并立即 yield。
            yield agent_message_chunk("任务已完成")
            yield usage_update_event({
                "input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
            })
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
        self._running = False

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
- 每种下游事件到 ACP 词汇 `InternalEvent` 的映射。
- 多内容块和分片事件不会丢失或重复。
- Token 字段规范化。
- 非零退出、协议错误、认证错误和超时。
- `stop()` 能终止进程且可重复调用。
- Session 新建、保存和恢复。
- 协调模式禁止工具。

### 11.2 ACP 契约测试（必测）

引擎接入后必须满足 `tests/test_engine_base_hierarchy.py` 的契约（新引擎会自动进入 `_ALL_ENGINES` 参与断言）：

- `acp_events ⊆ ACP_EVENTS` 且非空。
- 非 ACP 原生传输适配器的 `acp_events` 是全集真子集，且映射路径实际产出的事件类型都被声明。
- 无运行进程时，`create_session` / `resume_session` / `close_session` / `cancel_session` / `set_config_option` / `reset_options` / `approve_tool` / `approve_tool_option` 不抛异常并返回合理值。
- 能力声明与行为一致：声明 `supports_tool_approval` 的引擎必须产出 `interaction_request`。

### 11.3 通用连接测试

设置页的“测试引擎”会调用：

```http
POST /api/engine/test
```

只有真实对话成功并返回文本后，引擎才会被标记为已验证。执行和协调配置都会检查该验证状态。

### 11.4 工作流集成测试

至少使用 Fake Engine 跑通：

1. 创建包含三个步骤的工作流。
2. 第一个步骤接收用户任务。
3. 下游步骤读取上游产物和完整上下文。
4. 每个步骤产生实时消息、最终正文和 Token。
5. 自动审核产生 Review 消息。
6. 最终任务进入完成状态。
7. 从指定步骤重跑时，上游步骤标记为 `reused`，不会重复执行。

推荐命令：

```bash
cd apps/daemon
.venv/bin/pytest tests/test_engines.py -q
.venv/bin/pytest tests/test_pipeline.py tests/test_workflow_runtime.py -q
.venv/bin/pytest tests/test_coordinator.py tests/test_review_gate.py -q
```

### 11.5 配置模板测试

引擎声明 `config_schema()` 后至少覆盖：

- Schema 字段声明：key、类型、必填、options、confirm_values。
- 敏感字段在 `get_config_values()` 中掩码为空串，`get_config_secrets()` 正确标记。
- 保存时未提供新密钥且未标记 `clear` 时保留原值；`clear` 标记会移除已保存密钥。
- `confirm_values`（如 `bypassPermissions`）未确认时保存被拒绝。
- Base URL 校验：远程 HTTP 被拒绝，localhost/127.0.0.1 允许。
- `POST /api/engine/{id}/config/reveal` 返回真实密钥，响应带 `Cache-Control: no-store`。

前端变更后：

```bash
cd apps/web
corepack yarn build
```

## 12. 提交前验收清单

- [ ] 继承 `AcpEngineBase`（不是直接继承 `BaseLLMEngine`），`__init__` 调用 `super().__init__()`。
- [ ] 实现 `BaseLLMEngine` 抽象自定义函数（`is_installed` / `get_version` / `resolve_binary`）。
- [ ] 声明 `acp_events` 实际子集且 `acp_events ⊆ ACP_EVENTS`；映射路径产出的事件都被声明。
- [ ] 非 ACP 原生传输适配器已实现我方 ACP 等价会话 / 审批方法（无原生入口时安全降级并如实声明能力）。
- [ ] 引擎不可用时不会导致 Daemon 启动失败。
- [ ] `spawn()` 开始后立即产生状态事件，并产出 `session_started`。
- [ ] 正文 / 思考 / 工具事件实时输出，不在结束时批量补发。
- [ ] 下游提供的 thinking/reasoning 事件没有被静默丢弃（映射为 `agent_thought_chunk`）。
- [ ] 每个工具调用都有稳定 `tool_call_id`，工具结果使用相同的 ID。
- [ ] Agent SDK 使用完整事件流接口，而不是只消费最终正文流。
- [ ] Provider 不支持思考或工具时有明确降级说明，且不伪造事件。
- [ ] 增量正文不重复、不丢失。
- [ ] 错误事件包含可理解的信息且不泄露密钥。
- [ ] `stop()` 可以可靠终止进程或请求。
- [ ] Token 使用量来自真实 Provider 数据。
- [ ] 专属配置通过 `config_schema()` 声明，前端可自动渲染表单。
- [ ] 密钥在列表接口中始终掩码，只在 reveal 接口显式返回。
- [ ] 危险配置值（如 `bypassPermissions`）保存前要求显式确认。
- [ ] SDK 引擎使用完整事件流（正文、思考、工具、用量），不重复文本。
- [ ] Session 能力声明与实际行为一致。
- [ ] `supports_coordinator` 按统一协调器接口能力声明，不与 ACP 原生性或审批能力混淆。
- [ ] 支持协调器时，已验证「设置 → Agent 助手」与聊天框引擎选择器可见且可选。
- [ ] 协调模式不能修改文件。
- [ ] 已加入 Registry、配置和前端元数据。
- [ ] 设置页连接测试通过。
- [ ] 单元测试、ACP 契约测试、三步骤场景的工作流测试和前端构建通过。

Pydantic AI 的 `_prepare_prompt_input` 在输入捕获前异步检查持久化历史，只有匹配的 WorkStep 系统消息存在时才省略新注入；不只依赖 Session ID。`harness_runtime.py::_with_session_system_prompt` 用独立来源标记保存／替换规则，系统消息位于历史前部滑动窗口通过 WorkStep 包装保留该消息，摘要压缩继续保留系统消息。渠道的 `system_prompt_each_turn` 仍显式刷新来源背景，但不累积多份消息。查看记录仍显示本次传给引擎的新输入参数，不补造恢复历史；模型请求仍包含恢复的系统规则。测试见 `test_pydantic_ai_harness.py`（真实 SQLite 重启恢复、规则更新／清空、压缩、模型输入和慢读取健康检查）。


### 原生系统指令的恢复与重复设置

ACP 统一接受固定配置，是否省略本轮设置由引擎依据原生持久化状态判断，不能仅根据 `SYSTEM_PROMPT_MODE` 或 Session ID 判断。

| 引擎 | 同会话固定规则的处理 |
|---|---|
| Pydantic AI | 从 Harness 的系统消息恢复；规则相同不新增，变更／清空替换自己的消息 |
| Codex SDK | 从原生 rollout 最新 `turn_context.developer_instructions` 验证规则及自定义 developer 配置；匹配才省略线程覆盖。旧版本不保存该字段、记录不完整、工作目录不匹配或历史丢失时继续设置 |
| Claude Agent SDK | 当前适配器每轮创建新进程；保持 preset append，不凭 ID 省略。SDK 未设置 system_prompt 时可生成空 `--system-prompt`；较新 Claude 的 snapshot 是版本相关能力，尚未在本适配器接入 |
| Qoder SDK | 每轮创建新进程，当前接口未验证系统配置随 resume 恢复；继续设置 preset append，不能将聊天历史恢复视作系统配置恢复 |

Codex 的恢复检查在 `codex_sdk.py::_prepare_prompt_input` 中、输入捕获之前完成，所有配置／原生日志读取均在线程中。确认恢复时内部空字符串标记表示不重新覆盖 developer 配置，实际 SDK 的 `thread_resume` 不携带新的 `developer_instructions`，`config` 中也不携带旧自定义覆盖；原生历史继续提供规则。变更、首次和 `system_prompt_each_turn=True` 仍传递独立规则。此优化不另建数据库字段，不写入原生会话文件。

Claude/Qoder 的 append 是本次进程启动配置，不是向历史追加多条系统消息。实际设置时，「查看提示词」继续显示它；不得为了让查看变短而隐藏实际参数。渠道动态来源仍按每轮策略传递。回归见 `test_engine_system_prompt.py`，覆盖实际 SDK 参数、首次／恢复／重建、自定义规则合并、原生记录缺失／不完整、规则变更、每轮策略和慢读取健康检查。

依据：[Claude 系统提示词及 snapshot 版本语义](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#change-the-prompt-of-an-existing-session)、[Qoder 会话恢复](https://docs.qoder.com/cli/sdk/session-control)、[Codex 原生会话与配置](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn_context.rs)。


任务 Git 工作区的自动背景在独立系统注入模式下，固定规则与任务路径由 `assemble_step_system_prompt` 提供；正文的 `Task Git workspace` 只列已挂载仓库，避免同轮重复路径。`assemble_retry_prompt(..., separate_instructions=True)` 只比较仓库变动，兼容旧 `input_prompt` 仍带路径的快照，不把格式迁移误判为工作区变化。旧无独立系统入口的调用保持完整正文路径。查看仍记录实际输入，已有 DB 提示词不改写。

## 引擎在选择列表中的显示

设置 → 执行引擎的「在选择列表中显示」开关仅影响选择列表。Codex CLI 与 Claude Code CLI 默认关闭，其他引擎默认开启；显式设置保存在 `engine_visibility`。关闭不会删除适配器、清除配置或禁止已有任务步骤和会话继续执行。引擎目录返回 `enabled`，所有选择入口应过滤 `enabled: false`，同时保留既有选择值及其配置元数据。

## 用户自定义引擎（接口 v1）

设置 → 执行引擎 → 自定义接入会创建一个普通项目对话，预填接入提示词，由 `workstep-cli` 引导按需阅读规范，不加载独立技能。草稿默认在 `$WORKSTEP_CONFIG_DIR/runtime/engine-workspaces/<id>`；有容器项目根目录限制时草稿在允许的项目根目录 `workstep-engine-workspaces/<id>`。正式注册目录统一是 `$WORKSTEP_CONFIG_DIR/runtime/engines/<engine-id>`，不写应用安装目录，因此桌面应用升级与只读源码打包不影响用户引擎。

可移植包由 manifest.json、一个 Python 入口及 files 白名单声明的测试/资源组成；规范与步骤见 [接入指南](../apps/daemon/data/skills/workstep-cli/references/custom-engine.md) 和 [接口契约](../apps/daemon/data/skills/workstep-cli/references/custom-engine-contract.md)。CLI 可 inspect 指定目录或 py 文件，然后 install/configure/validate/register；install/validate 可异步查询或取消。只有公开验收通过，签名及代码/依赖/配置指纹一致才允许原子注册。注册后需要重启；已加载代理发现文件变化会拒绝执行并要求重新验收。

每个引擎自行实现异步 install，按系统/架构判断下载依赖，获取 staged target_dir 而不修改后台 Python 环境；SDK import 必须延迟到依赖存在后。Python SDK、CLI、Node 桥接均可接入，Node 并非桌面包保证提供的运行时，需要引擎检测并安装或说明环境要求。导出 ZIP 仅携带源码/测试/资源及安全测试摘要，不含 dependencies/cache/凭据；接收方按其平台重新安装与验证。支持复用现有供应商及自定义供应商，按协议声明进行匹配；配置 schema 自动生成设置表单，敏感值脱敏。

主进程只扫描清单和安装元数据，不执行用户模块。用户代码在独立进程运行，管理请求有超时，取消/停止会终止进程树，畸形响应和导入异常不会终止后台。`WORKSTEP_SKIP_CUSTOM_ENGINES=1` 可跳过所有自定义引擎恢复启动。进程隔离保护后台稳定性，用户代码仍有宿主机文件和网络权限。设置的“显示在引擎选择中”只控制下拉可见性；自定义引擎“停用运行”才停止并禁止调用。

公共验收包含实际文本回复与事件转译、专属 unittest、生命周期与停止、协调禁用工具、执行→下游→审核调用链，以及声明的会话/分叉与可选能力真实场景。调用链探测验证引擎公共接口，不在用户项目写入真实任务或工作流。第三方联网验收由用户接入时执行；仓库测试通过本地适配器与真实子进程覆盖隔离和 API，不依赖网络或供应商密钥。
