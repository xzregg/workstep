# 自定义引擎接口 v1

最小包：

```json
{"api_version":1,"id":"my_engine","name":"我的引擎","description":"官方 SDK 适配","mode":"sdk","entry":"engine.py","class_name":"MyEngine","files":["engine.py","tests/test_adapter.py"]}
```

`files` 是可移植包白名单；所有代码、测试、测试场景与资源都必须列入，路径必须相对且不能越界/符号链接。供应商认证不放入包。支持 cli/acp/sdk/agent，入口始终为 Python。

## 方法

### 进程复用声明与验收

能持续接收请求的 SDK、ACP、双向 JSONL CLI 应复用同一原生会话的连接；普通一次性 CLI 不声明复用。`supports_process_reuse` 是传输生命周期属性，与恢复历史的 `supports_resume` 不同；支持复用的适配器必须同时支持原生恢复，并返回真实 `session_started.session_id`。ACP 基类在可恢复时默认支持，`CustomEngineBase` 的 SDK/Agent 适配器须显式声明 `supports_process_reuse = True`、`supports_resume = True`。

宿主按引擎、项目 cwd、原生 session ID 独占隔离 worker，跨不同代理对象的连续请求仍复用同一个 worker／适配器实例；不同 session 不共用执行实例，同一 session 不接受重叠执行。成功完整收流后才进入缓存；默认空闲 **600 秒**、每个引擎最多 **8 个空闲客户端**，运行中及等待审批不计入空闲。异常、停止、提前关闭、配置／凭据／身份／包内容变化必须销毁或重建，恢复时保留原生 ID。不要把请求专属回调、来源权限、消息队列及旧的审批授权留给下一轮。

内部原生客户端也要保留：不能只缓存外层 Python worker，而 `spawn` 仍每轮创建并关闭 SDK。可复用 `engines.core.session_pool` 的 `ManagedConnection`、`get_session_pool` 与 `startup_fingerprint`；`ManagedConnection` 保证 SDK/ACP 上下文在同一常驻协程中创建和销毁，适用于持有 anyio cancel scope 的 SDK。同步磁盘、配置、SDK 初始化／退出必须隔离到线程。`stop()` 及时取消本实例的执行与挂起审批；只有明确关闭时销毁对应资源，不能取消其他 session。

`engine validate` 对声明复用的包增加 `session_transport_reuse`：真实隔离 worker 跨两个代理对象执行同一原生会话，核对 worker PID 保持、独立会话 PID 不同、关闭其中一个不影响另一个。声明复用却不支持恢复、没有原生 session ID 或未通过检查均不能注册。专属 unittest 还须证明内层真实 SDK/ACP 进程或连接复用，覆盖多轮、同会话竞争、并发、审批允许／拒绝、审批中停止、协程取消、异常／崩溃、TTL／LRU、配置／身份变化、原生恢复以及子孙进程回收；宿主 worker PID 不代替内层客户端验证。

### 同会话复用与跨会话共享

接入时必须分别判断三种情况：一次性命令每轮启动；双向连接可供同一会话连续复用；原生运行时可在同一连接／进程内并发托管不同会话。`supports_process_reuse` 只声明第二种生命周期能力，不代表第三种，也不承诺每个客户端可同时处理五个对话。存在 `session_id` 字段、能恢复历史、能连续 query 或有后台进程，都不能单独证明可跨会话共享。

当前自定义宿主的外层 Python worker 仍按原生会话独占，`session_transport_reuse` 验收继续要求不同会话的外层 worker PID 不同。内置 Codex 的五会话池不是自定义宿主的通用开关；不要杜撰一个多路复用 capability 属性或仅改配置就声称宿主已共享。原生运行时有能力时，应先明确宿主的路由、所有权与生命周期扩展，再完成下面的验收；这些能力未实现／未验证时保留独占 worker 和同会话复用，不得把不支持写成“已通过”。

跨会话共享的实现和验收要求：

1. 明确原生版本、共享边界、单进程活动会话容量、空闲会话容量及十分钟空闲策略。按项目／供应商／凭据／来源身份／环境与启动参数的兼容指纹分组；等待审批仍占活动槽，满载才扩容，忙会话不能被 LRU 或计时器淘汰。
2. 每个 native session/run ID 独立保存历史、开发者／系统规则、工作目录、消费者、审批回调和授权缓存。同会话重叠执行要拒绝或明确排队；不同会话事件交错也不能串流。接收线程不能因为 A 等用户审批而停读 B 的通知／响应。
3. stop/cancel/unload 必须精确作用于对应会话；释放 A 只能回收 A 的资源，最后一个租约释放才允许关闭共享运行时。不能通过关闭全局连接模拟单会话停止；若原生没有会话级取消，只能如实说明限制，不得声称满足该共享模式。
4. 崩溃、EOF、协议错误、回收和停止必须终结受影响的所有未决审批／提问，同时通知宿主。等待用户的上层也必须结束；不能只在继续消费事件后才发现断连。旧审批绑定原进程代次、session/run ID 与原请求 ID；恢复历史不会恢复授权，迟到确认不能重放给新进程，新请求必须重新确认。
5. 禁止在不同外层 worker 间私借某个 worker 的后代进程：宿主会回收其拥有的进程树。原生共享服务如需独立常驻，必须先有明确的宿主生命周期、连接租约和退出回收方案；不能偷偷创建无人管理的后台服务。
6. 专属测试使用随机上下文标记，至少覆盖两路与容量加一的实际重叠执行；核对内层原生 PID／连接 ID、不同会话 ID、事件归属、A 审批中 B 输出／停止、双审批分别允许／拒绝、局部停止、插入、原生卸载、崩溃后旧确认被拒绝、同会话 ID 恢复后的新审批，以及配置变化和退出后的子孙进程。外层 worker PID、同一 Python 对象或 `session_transport_reuse` 通过都不能代替这些证据。离线协议测试与真实原生测试分别报告，协议有字段不能冒充具体引擎已经验收。

按当前安装的 SDK／CLI 版本核对上述条件；内置 Codex 的共享验收不能作为本包或其他原生运行时的保证。升级原生版本、依赖或宿主共享实现后，需要重新验证。

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
