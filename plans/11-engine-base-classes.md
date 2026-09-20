# 引擎基类拆分：BaseLLMEngine（自定义函数）+ AcpEngineBase（ACP 协议）

> 状态：已实现。本文为重构记录；当前能力声明和方法签名以两个基类及引擎契约测试为准。

## 摘要
- 所有引擎统一继承 `AcpEngineBase`（ACP 协议基类），实现 ACP 协议事件（spawn / session / interaction / approval / coordinator seam）；不再直接继承 `BaseLLMEngine`。
- `BaseLLMEngine` 只承载与协议无关的**自定义函数**：安装、版本、二进制解析、配置表单、模型枚举、能力声明。
- 对接新 LLM 引擎 = 新增一个文件：继承 `AcpEngineBase`，实现 `BaseLLMEngine` 的抽象自定义函数（`is_installed` / `get_version` / `resolve_binary`），按需覆盖协议方法（非 ACP 引擎用自己的传输实现 `spawn`，仍产出 ACP 词汇内部事件）。
- 上层调用（`task_runner` / `agent_assistants/coordinator` / `agent_assistants/base` / API）只按 ACP 风格接口使用引擎，接口签名不变。

## 类层次

```
BaseLLMEngine(ABC)                          # 自定义函数基类
├── 发现：set/get_binary_override, is_installed*, get_version*, resolve_binary*
├── 安装：install_command, install, inspect_capabilities
├── 配置：config_schema, stage_config_schema, merge_config_overrides,
│         get/save_config_values, get_config_secrets, reveal_config_value
├── 能力声明：capabilities, supports_message_history, supports_thinking_effort,
│         supports_workstep_tools, supports_vision
└── list_models

AcpEngineBase(BaseLLMEngine)                # ACP 协议基类（所有引擎继承）
├── 执行：spawn（ACP 客户端默认实现，非 ACP 引擎覆盖）, stop, test_connection
├── 会话：supports_sessions, create/load/list/resume/close/cancel_session,
│         set_config_option, reset_options
├── 审批：supports_tool_approval, approve_tool, approve_tool_option
├── 交互：normalize_event, normalize_interaction_event, request_interaction,
│         handle_tool_permission, respond_interaction, inject_response,
│         send_live_stage_message
├── 恢复：supports_resume, supports_interactive, build_resume_params
└── 协调器：spawn_coordinator, _coordinator_prompt, coordinator_guard, render_image_prompt
```

## 关键改动（`apps/daemon`）

**`engines/core/base.py`**
- 移除全部协议方法（spawn / stop / 会话 / 审批 / 交互 / 协调器 / test_connection / 直播消息），只保留自定义函数与能力声明。
- 抽象方法仅剩 `is_installed` / `get_version` / `resolve_binary`；协议方法由 `AcpEngineBase` 提供具体默认实现。

**`engines/core/acp_base.py`**
- 接收从 `BaseLLMEngine` 移入的协议方法（`test_connection` / `spawn_coordinator` / `coordinator_guard` / `render_image_prompt` / `normalize_event` / `normalize_interaction_event` / `request_interaction` / `handle_tool_permission` / `send_live_stage_message`），并把 `respond_interaction` 合并为完整实现（保留 `_StreamingClient.resolve_elicitation` 分支）。
- 新增 `_is_acp_native`（`bool(get_command())`）门控：`supports_sessions` / `supports_tool_approval` / `supports_live_stage_message` 只对 ACP 原生引擎（提供命令，如 Hermes）为 True；会话方法对非原生引擎保持安全默认（`None` / `False` / `[]`），避免误起 ACP 子进程。
- 新增 `ACP_EVENTS`（完整 ACP 词汇，25 种）与 `AcpEngineBase.acp_events` 能力声明；ACP 原生引擎继承即声明全集。
- 新增 pending 审批注册表（`_pending_approvals`：tool_call_id → interaction_request 事件）：非 ACP 引擎的 `request_permission` 在 `request_interaction` 中登记，`approve_tool` / `approve_tool_option` 据此把决定写回挂起的 Future（`allow_once` / `reject_once` / 指定 option_id）；ACP 原生引擎仍走 `_StreamingClient` 的审批解析。

**各引擎**
- `Codex / CodexSDK / ClaudeCode / ClaudeAgentSDK / QoderSDK / PydanticAI / OpenClaw` 由 `BaseLLMEngine` 改继承 `AcpEngineBase`；`Hermes` 保持 `AcpEngineBase` 不变。
- 各引擎原有 `spawn / stop / inject_response / supports_resume / supports_interactive / build_resume_params` 覆盖保持不变（传输层各自实现，事件仍为 ACP 词汇）。
- 非 ACP 引擎声明自己的 `acp_events` 实际子集（声明 = 实际，无原生来源不合成），并实现等价会话 / 审批语义：
  - `codex`：`supports_sessions` / `supports_tool_approval` 为 True；会话经 `codex exec resume <thread_id>` 恢复，审批经沙箱拒绝 → 弹窗 → 提权重试。
  - `codex_sdk`：`thread_resume` 恢复会话；`approval_handler` 桥接 SDK 审批回调到 `interaction_request`。
  - `claude`：`--resume <session_id>` 恢复会话；权限决定作为 `tool_result` 注入 CLI。
  - `claude_agent_sdk` / `qoder_sdk`：`resume` 选项恢复会话；`can_use_tool` / `on_elicitation` 桥接审批与表单交互。
  - `pydantic_ai`：进程内 Agent 无 CLI 会话（`supports_sessions` 继承默认 False），写文件等工具经 `_request_permission` 弹窗审批。
  - `openclaw`：一次性 `agent exec --json`，无会话 / 审批 / 直播消息能力，仅声明信封实际产出的事件。
- 各引擎 `__init__` 调用 `super().__init__()`，共享基类的 pending 审批注册表与运行状态。

**上层与注册**
- `services/task_runner.py` 类型标注改为 `AcpEngineBase`（上层只按 ACP 接口使用）；`api/engine.py` 配置响应仍标注 `BaseLLMEngine`（读取自定义函数）。
- `engines/core/registry.py` 模式识别改为 `issubclass(..., AcpEngineBase) and instance._is_acp_native`：只有 ACP 原生引擎标记 `acp`，SDK / CLI / agent 模式不变。

## 测试
- 新增 `tests/test_engine_base_hierarchy.py`：所有注册引擎均为 `AcpEngineBase` 子类；`BaseLLMEngine` 无协议方法；协议接口在 `AcpEngineBase`；非 ACP 引擎保持安全默认（会话 / 审批 / 直播消息）。
- ACP 事件契约测试：所有引擎 `acp_events ⊆ ACP_EVENTS`；ACP 原生引擎声明全集；非 ACP 引擎声明实际子集（含核心文本 / 状态事件，有审批必有 `interaction_request`）；各引擎映射路径实际产出的事件类型 ⊆ 声明集合；无运行进程时全部会话 / 审批方法不抛异常并返回合理值；`approve_tool` 能把决定写回挂起的非 ACP 审批。
- 测试桩类（`test_pipeline` / `test_coordinator` / `test_e2e` 等）由 `BaseLLMEngine` 改为 `AcpEngineBase`，断言与行为不变。
- `uv run pytest` 全量回归通过。

## 假设
- 「所有引擎继承 AcpEngineBase」指协议接口统一；非 ACP 引擎仍用各自传输，仅统一产出 ACP 词汇事件。
- `_is_acp_native` 以「提供 ACP 命令（`get_command()` 非空）」为判据；后续接入新 ACP 引擎只需声明 `COMMAND` / `ENGINE_ID`。
- 非 ACP 引擎的 `create_session` 无法脱离提示词创建空会话（无原生入口），返回 `None` 并记录日志；会话在首次 `spawn`（`session_started`）时建立，`resume_session` 返回 `bool(session_id)`（spawn 实际恢复），`close_session` / `cancel_session` 等价于结束当前运行中的进程。
