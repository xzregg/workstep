# 自定义引擎接口 v1

最小包：

```json
{"api_version":1,"id":"my_engine","name":"我的引擎","description":"官方 SDK 适配","mode":"sdk","entry":"engine.py","class_name":"MyEngine","files":["engine.py","tests/test_adapter.py"]}
```

`files` 是可移植包白名单；所有代码、测试、测试场景与资源都必须列入，路径必须相对且不能越界/符号链接。供应商认证不放入包。支持 cli/acp/sdk/agent，入口始终为 Python。

## 方法

- 安装元信息：`is_installed()`、`get_version()`、`resolve_binary()`；静态查询必须真实、快速且无需初始化网络客户端。SDK 导入延迟到执行/安装检查。
- `async install()` → `EngineInstallResult(success, message, already_installed=False)`。`self.install_context` 提供 target_dir/cache_dir/engine_dir/system/architecture/python_version/python_executable。检查系统选择下载，不支持的平台应明确失败。只写目标目录；安装在临时目录完成并复查后整体替换。
- `config_schema()` → `list[EngineConfigField]`，支持 text/password/select/textarea/json/number/checkbox/model_map；key 唯一，敏感项 sensitive=true，不设密钥默认值。CustomEngineBase 实现通用读取与脱敏，设置页动态生成表单。
- `async spawn(prompt,cwd,model=None,session_id=None,images=None,config_overrides=None,**kwargs)` → 异步 InternalEvent 流。理解 model、system_prompt、schema、thinking_effort、live_message_queue 等实际声明的能力参数；不能忽略所宣称的能力。
- `async stop()` 必须及时结束自身 SDK/子进程，空闲和重复调用安全。
- 会话：create_session/load_session/list_sessions/resume_session/close_session/cancel_session/fork_session；有原生能力才声明，不能用恢复代替分叉。继承基类可以安全不支持。
- 审批与交互：request_interaction 登记挂起交互；approve_tool/approve_tool_option/respond_interaction/inject_response 应使用基类注册表及真实原生响应接口，禁止自动批准。
- 模式与配置：set_config_option/set_session_mode/reset_options/set_permission_mode；实时消息 send_live_step_message；协调 spawn_coordinator 必须禁用工具。不支持时沿用基类降级并准确声明。
- 供应商：supported_provider_protocols/provider_required/resolve_provider_runtime；认证读取 WorkStep 已保存配置。供应商协议匹配，不硬编码内置供应商 ID，也不返回原始密钥到事件。

签名、事件和能力的权威定义在 `$WORKSTEP_DAEMON_DIR/engines/core/{acp_base,base,events,schema,agui}.py`。允许读取这些接口文件实现适配；不需要为了运行 CLI 探索传输源码。

## MCP 连接器接口（必读）

所有引擎都继承同一接口；没有真实接入能力时保持 `supports_mcp = False`，不能静默忽略用户已启用的连接器。声明支持时必须显式实现：

```python
supports_mcp = True

async def configure_mcp_servers(self, servers: list[dict], config_overrides: dict | None = None) -> dict:
    return await super().configure_mcp_servers(servers, config_overrides)
```

这段代码只展示标准合并接口，不是完整接入。SDK/CLI 适配器还必须在 `spawn` 中把返回配置交给官方原生 MCP 入口；如果 SDK 使用不同字段，可在此方法转换，`spawn` 必须读取转换结果。ACP 适配器也须显式实现上述方法，标准 `mcp_servers` 随新建／恢复会话传给原生 ACP Agent。若自行覆盖 `capabilities`，其中 `supports_mcp` 必须与属性一致。

- `servers` 是本次运行的本地 stdio 桥接描述列表，每项包含 `name/command/args/env`；HTTP/SSE 上游认证由 WorkStep 桥接层处理，自定义引擎无需读取凭据保险库。
- 返回 JSON 可序列化的配置字典，不修改入参，保留原模型、供应商、沙箱、审批和原生 MCP 配置；同名冲突要明确报错，不覆盖。
- 不把 MCP 描述或认证拼进提示词，不写用户全局原生配置文件。沿用原生工具审批；执行结束／停止时回收自身客户端和子进程。
- 无连接器的执行保持原行为；只读协调调用不自动注入。恢复会话时也要重新应用本轮配置，不能只在首次创建时生效。
- `inspect` 检查方法存在、异步签名和能力声明；自定义引擎不需要加入内置 ID 白名单。

## MCP 验收测试

引擎专属 unittest 必须覆盖：空配置不改变行为、现有原生 MCP 合并、名称冲突、官方 SDK/CLI 实际接收参数、工具调用失败、审批拒绝、停止清理，以及声明支持时的会话恢复。

`engine validate` 对 `supports_mcp=True` 自动运行 `mcp_connector_roundtrip`：在隔离临时目录启动专用 stdio MCP 服务，让引擎调用随机名称的探测工具，以服务端收到的 nonce 验证真实调用；声明 `supports_resume=True` 时恢复原会话后再验一次。只输出“支持”、伪造工具事件或不传配置都会失败。验收只允许单次批准该专用测试工具，其他审批拒绝；不会使用用户已有连接器或项目密钥。测试失败不得注册；不支持时该项标为不适用，不得伪报通过。

## 事件

内部只产出 ACP 对齐 `InternalEvent`，声明 `acp_events` 为实际来源集合。文本使用 `agent_message_chunk(text)`，思考使用对应 helper，工具保留稳定 tool_call_id 和 pending/in_progress/completed/failed 状态，审批保留 interaction_id 与 options。会话启动保留真实 session_id；用量只发布真实非负数；不能补造默认用量。目标模式的 `goal_update` 属于 WorkStep 扩展，单独声明 `workstep_events = frozenset({"goal_update"})`，不加入 acp_events；统一 AG-UI 翻译由 WorkStep 完成，适配器不直接发前端消息。

## 测试

`tests/test_*.py` 为 unittest，入口模块可导入 `workstep_user_adapter`。针对官方原始事件构造样本，验证文本、工具参数/状态/输出、错误、审批/取消/恢复和敏感信息处理；不要只测常量。包含超长 JSONL 与延迟读取样本。CLI stdout 使用 `iter_stream_lines`/`ChunkedLineReader`，禁止原生 readline。

公共 validate 会真实调用引擎，在临时目录探测真实回复、事件翻译、执行→下游→审核、停止，以及声明支持的会话/分叉。可选能力必须在 `tests/scenarios.json` 中提供：

```json
{"supports_native_schema":{"prompt":"输出包含 ok=true 的 JSON，不使用工具","kwargs":{"schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}}}}
```

场景键包括 supports_tool_approval/supports_vision/supports_live_step_message/supports_native_schema/supports_workstep_tools/supports_thinking_effort/supports_plan_mode/supports_goal_mode。prompt 是真实请求；kwargs 为 spawn 参数；images 为包内资源路径；live_messages 为消息队列数据。工具审批探测会拒绝动作。公共流程探测验证引擎调用与事件边界，不会在用户项目里创建实际任务或修改流程。

报告路径 validation.json（本机签名和指纹）不可加入 files；导出只有安全摘要。register 必须通过且指纹不变，其他机器重新安装与验收。包大小最多 32 MiB，不包含运行依赖。
