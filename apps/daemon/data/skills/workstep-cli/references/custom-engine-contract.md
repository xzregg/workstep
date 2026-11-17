# 自定义引擎接口 v1

操作步骤见[接入流程](custom-engine.md)，验收场景见[测试规范](custom-engine-testing.md)。本页只定义实现契约；签名与事件字段以 `$WORKSTEP_DAEMON_DIR/engines/core/{base,acp_base,permissions,events,schema,agui}.py` 为准。

## 包与运行边界

```json
{
  "api_version": 1,
  "id": "my_engine",
  "name": "我的引擎",
  "mode": "cli",
  "entry": "engine.py",
  "class_name": "MyEngine",
  "files": ["engine.py", "tests/test_adapter.py"]
}
```

- `mode` 支持 cli/acp/sdk/agent，入口均为 Python；类继承 `CustomEngineBase` 或 `AcpEngineBase`，调用 `super().__init__()`，`ENGINE_ID` 与清单一致。
- ID 为小写字母开头、最多 64 位的小写字母／数字／下划线。`files` 列出全部源码、测试、场景及运行资源，只允许包内相对路径，不得越界或使用符号链接；ZIP 不超过 32 MiB，不打包运行依赖。
- 安装写入 `self.install_context.target_dir`，按 system/architecture/python_version/python_executable 选择依赖；cache_dir/engine_dir 提供配套路径。不支持的平台明确失败，安装失败不覆盖可用版本。
- 所有同步文件、配置、SDK 初始化／退出及管道操作隔离到线程；优先使用原生异步接口。CLI stdout 使用 `iter_stream_lines`／`ChunkedLineReader` 分块读取，不能使用 `readline()` 或逐行迭代处理超长 JSONL。

## 方法与能力

| 接口 | 契约 |
| --- | --- |
| is_installed/get_version/resolve_binary | 真实、快速，不初始化网络客户端；第三方 SDK 延迟 import |
| async install | 返回 `EngineInstallResult(success, message, already_installed=False)`；使用安装上下文和 SDK 安装助手 |
| config_schema | 返回 `list[EngineConfigField]`，key 唯一；支持 text/password/select/textarea/json/number/checkbox/model_map；敏感项设 sensitive，不放默认密钥 |
| async spawn | 接收 prompt/cwd/model/session_id/images/config_overrides 及已声明能力的参数，产出 `InternalEvent` 异步流 |
| async stop | 空闲、重复调用安全；及时终止本会话执行、挂起交互和子孙进程 |
| 会话方法 | create_session/load_session/list_sessions/resume_session/close_session/cancel_session/fork_session；无原生支持时保留基类降级，不用恢复模拟独立分叉 |
| 审批与运行控制 | 复用 request_interaction 注册表和 respond_interaction/approve_tool/approve_tool_option/inject_response；set_config_option/set_session_mode/reset_options/set_permission_mode 对接原生入口 |
| 协调调用 | spawn_coordinator 必须禁用工具；实时消息通过 send_live_step_message 对接 |
| 供应商 | supported_provider_protocols/provider_required 声明范围；resolve_provider_runtime 解析已保存供应商及本次 provider_id/model，不硬编码供应商 ID |

`CustomEngineBase` 提供配置读取、脱敏和安装助手。声明的 schema/thinking_effort/system_prompt/live_message_queue 等参数必须实际进入原生执行，不支持的能力不声明；不修改中央引擎 ID 列表来接入能力。

## 权限与输入策略

在引擎自己的 schema 声明原生权限字段，宿主不强制统一五档：

```python
from engines.core.schema import EngineConfigField, EngineConfigOption

@classmethod
def config_schema(cls):
    return [EngineConfigField(
        key="approval", label="原生审批", category="mode", type="select",
        default="review", required=True,
        options=(EngineConfigOption("review", "需要审核"),
                 EngineConfigOption("trust", "信任执行")),
    )]
```

只支持非敏感 select/checkbox，可声明多个字段。worker describe 自动导出 ACP configOptions 形状的 `permission_config_options`；宿主绑定引擎并校验字段和值。空选择跟随保存的引擎配置，原生 default 是明确枚举，两者不能混用。没有权限声明就只显示引擎默认；无需硬映射其他引擎的模式。

`spawn` 合并本次 config_overrides 并实际传给原生 SDK/CLI，以最终配置调用 configure_interaction_policy。`PERMISSION_POLICY` 继续声明计划上限和配置对应的审批决定；overrides 只用于旧权限值兼容。原生 auto 应保留引擎上报的审批，不等于宿主无条件批准。用户问题不能代答。计划配置最后合并，声明不等于宿主沙箱。

set_permission_mode 原样跨 worker；继承空值时也必须重新读取已保存设置。支持热切换才更新正在运行的原生客户端，否则下一轮应用；不能仅改变菜单而保留旧策略。旧元数据仍可运行，声明更新后重新 inspect/validate/register。

技能通过 `SKILL_POLICY: EngineSkillPolicy` 或 `skill_policy` 声明，默认 unsupported；实际落实白名单后才能启用。`SUPPORTS_MANUAL_COMPACTION=False` 同时禁用 `/compact` 菜单和入口，默认沿用 ACP 命令入口。服务档位声明 `SUPPORTS_SERVICE_TIER=True`，才会接收助手的本轮 `service_tier` 并显示档位选择。需要宿主在执行前分配恢复会话 ID 时声明 `SUPPORTS_HOST_SESSION_IDS=True`；仅可用于真实接受该 ID 并按它恢复的引擎。两者默认关闭，worker 自动导出。

没有原生权限控制或审批桥时，显式声明 `EnginePermissionPolicy(overrides={})`，只保留引擎默认；不能继承 auto/ask 后静默忽略。声明变更后重新 inspect/validate/register，旧安装元数据不自动补全新能力。

## 事件

只产出已声明的 ACP 对齐 `InternalEvent`，由公共层翻译为 AG-UI。文本使用 `agent_message_chunk(text)`；工具保留稳定 tool_call_id、参数、状态和输出；审批保留 interaction_id 与原生 options。会话 ID、用量和成功状态均来自真实执行，不补造。`goal_update` 属于 WorkStep 扩展，单独放入 `workstep_events`，不加入 `acp_events`；不向事件输出凭据。

## MCP 连接器

不支持时保持 `supports_mcp=False`；支持时必须显式实现：

```python
supports_mcp = True

async def configure_mcp_servers(self, servers, config_overrides=None):
    return await super().configure_mcp_servers(servers, config_overrides)
```

该示例仅完成标准合并，`spawn` 和恢复路径还必须将返回配置交给原生 MCP 入口；原生字段不同时在此转换。`servers` 为 stdio 描述列表，每项含 name/command/args/env，上游 HTTP/SSE 认证由宿主桥接。保留既有服务器与其他配置，不修改入参，同名冲突报错；不将配置／凭据写入提示词或用户全局原生配置。无连接器时保持原行为，只读协调调用不自动注入；执行结束或停止时回收本引擎客户端。自定义 capabilities 中的 supports_mcp 必须与属性一致。

## 连接生命周期

| 运行方式 | 声明与实现 |
| --- | --- |
| 一次性 CLI | 每轮启动；能 resume 不代表进程可以复用 |
| 同会话持续连接 | supports_process_reuse=True 且 supports_resume=True；返回真实原生 session ID，保留内层客户端而非只保留外层 worker |
| 跨会话并发共享 | 当前自定义宿主不提供；原生支持也须先扩展宿主路由与所有权，不能靠一个 capability 开关启用 |

宿主按引擎、cwd、原生 session ID 独占 worker，同会话不重叠执行。成功完整收流后进入共享池，默认空闲 600 秒、最多 8 个空闲客户端；运行及审批等待不计空闲。配置／凭据／权限／技能／身份变化时重建，停止、异常、取消或提前收流不得归还可复用缓存。

可复用 `session_pool.ManagedConnection/get_session_pool/startup_fingerprint`，使原生上下文在同一所有者协程中创建和关闭。每轮绑定新的消费者、回调和队列，不保留旧审批授权；停止只影响对应会话。更深入的[复用与共享验证](custom-engine-testing.md#复用与共享验证)按实现能力执行。
