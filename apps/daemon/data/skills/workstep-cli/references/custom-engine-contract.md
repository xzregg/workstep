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
