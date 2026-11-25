# 自定义引擎测试规范

接入操作见[流程](custom-engine.md)，实现字段见[接口契约](custom-engine-contract.md)。创建、更新及 ZIP 导入使用同一套验收要求。

## 测试分层

| 层级 | 负责验证 | 不替代什么 |
| --- | --- | --- |
| 包内 unittest | 原生参数、事件、错误、权限、生命周期等适配行为 | 不证明真实服务可连接 |
| engine validate | 独立 worker 内的真实连接、公共协议和已声明场景 | 不证明所有权限、平台或原生共享能力 |
| 原生专项验证 | 指定 SDK/CLI 版本上的进程／连接及并发行为 | 不由外层 worker PID 或声明常量代替 |

包内文件用 `tests/test_*.py`，采用标准库 unittest，可导入入口模块 `workstep_user_adapter`；测试、场景 JSON 和资源均列入 manifest.files。测试产物与凭据不加入导出包。先写失败场景，再实现转换；使用官方原始事件样本和随机上下文标记，断言行为而非只比较常量。

## 专属测试矩阵

按实际能力覆盖下列场景；不适用项说明理由，不通过删测或关闭用户所需能力获得通过。

| 范围 | 必测行为 |
| --- | --- |
| 安装与配置 | 延迟 import、缺依赖、平台不支持、安装失败回滚、默认值／本次覆盖及敏感项脱敏 |
| CLI 与流式事件 | 超长 JSONL、分块／延迟读取、工具参数与输出、思考和正文、错误／EOF、真实用量及 ACP→AG-UI 转换 |
| 完成与超时 | 空最终回复、工具后空回复、无完成标记的断流、响应体内错误、长度截断、最终正文补齐且不重复；无数据／请求总时限／工具超时分别生效，等待审批不误超时，超时取消后资源已清理 |
| 图片与路径 | 原生图片字节及类型实际进入供应商请求，正文路径保留，多图与恢复续聊不丢附件；非原生图片接入保留正文路径且不因结构化附件拒绝整轮，不虚报视觉能力或识别结果 |
| 权限与计划 | 各原生字段／枚举实际传入；空覆盖跟随设置、原生 default 保持明确覆盖；允许／拒绝在执行前生效，原生 auto 上报的审批不被宿主吞掉；计划上限和已承诺的文件／命令边界覆盖连接器及子代理 |
| 重启与恢复 | 保存配置并注册后退出 worker，再用全新宿主进程发现／选择／执行；默认与明确覆盖均恢复；旧元数据仍可运行，跨引擎不带入旧选择；清除覆盖不残留复用实例策略 |
| 生命周期 | 多轮、同会话竞争、独立会话隔离、停止／取消／崩溃、审批等待时停止、迟到确认失效、重复清理及子孙进程回收 |
| 会话与可选参数 | 声明的恢复、独立分叉、图片、schema、思考强度、固定指令和实时插入实际生效；协调调用无工具 |
| 账户额度（声明时） | 原生接口／脚本真实采集、多个窗口与小数、余额缺失不补零、未登录／不可用／畸形结果、超时取消与自有进程回收；不发送模型请求 |
| MCP | 空配置、原生服务器合并、同名冲突、真实 SDK 参数、工具失败、审批拒绝、停止清理及支持时的会话恢复 |

同步 I/O 用慢磁盘、慢 SDK 或锁竞争配合轻量协程／健康检查证明不阻塞事件循环。保留关键 RuntimeWarning、未捕获线程异常等诊断，不能仅按正文断言判定生命周期通过。

## 公共验收覆盖范围

`engine validate <路径> --json` 执行 `engines/core/custom_validation.py`，每项返回 passed/failed/not_applicable；总结果 ok=true 后才允许注册。实际检查按下表分组：

| 组 | 检查项 |
| --- | --- |
| 基础 | environment、idle_lifecycle_and_fallback、adapter_unit_tests |
| 对话与事件 | real_connection_and_event_translation、execute_downstream_review |
| 协调与停止 | coordinator_no_tools（声明支持时）、stop_and_idempotency |
| 会话 | resume、sessions、fork（各自声明支持时） |
| 连接复用 | session_transport_reuse（声明 supports_process_reuse 时） |
| MCP | mcp_connector_roundtrip（声明 supports_mcp 时） |
| 其他能力 | declared_capability_scenarios |

普通对话／流程探测不允许工具或文件修改，检查非空真实回复、事件字段、错误和翻译；不在用户项目中创建任务。公共检查没有逐项证明只读限制或每个权限模式，相关行为仍由专属测试负责。

MCP 验收在隔离目录启动专用 stdio 服务，要求真实调用随机工具并回传 nonce；支持恢复时恢复同一会话再测。仅对该探测工具作单次批准，其他未知审批拒绝，不使用用户已有连接器凭据。伪造工具事件或只回复“支持”不能通过。

## 可选能力场景

以下能力为 true 时，在 `tests/scenarios.json` 提供对应场景：supports_tool_approval、supports_vision、supports_live_step_message、supports_native_schema、supports_workstep_tools、supports_thinking_effort、supports_plan_mode、supports_goal_mode。

```json
{
  "supports_native_schema": {
    "prompt": "输出包含 ok=true 的 JSON，不使用工具",
    "kwargs": {
      "schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
    }
  }
}
```

prompt 为真实请求，kwargs 原样传给 spawn；images 指向包内资源，live_messages 提供消息队列输入。公共检查核对对应事件，native_schema 还检查 JSON；审批场景显式选择需要审批的原生权限配置后拒绝动作，不能继承已保存的免审批配置来声称覆盖审批。视觉场景使用包内测试图，专属测试同时检查原生请求携带真实图片，不能只靠文本回复声称看图成功。事件出现只证明这条探测路径，参数是否正确传入及完整交互行为仍须专属测试覆盖。

## 复用与共享验证

### 进程复用声明与验收

先区分恢复历史、同会话连接复用和跨会话共享，声明方式见接口契约。`session_transport_reuse` 实际经过宿主代理，验证两个代理对象续聊时复用外层 worker PID、不同会话使用不同 worker、关闭其中一个不影响另一个。

专属测试还须验证内层 SDK/ACP/双向 CLI 的原生 PID 或连接 ID 保持，覆盖配置变化重建、TTL/LRU、停止和异常回收。只缓存 Python worker、内层每轮重建客户端，不能作为原生复用证据。

宿主主会话保护另须覆盖：受保护会话跨空闲窗口和普通 LRU 保留原客户端；解除保护后恢复回收；`/new`、原生 ID 更新或跨引擎交接不继承旧上下文／旧授权；停止、异常、配置变化及退出不被保护阻挡。宿主通用验收入口是 `tests/test_native_session_retention.py::test_custom_worker_retention`，内层客户端是否持续复用仍由引擎专属测试证明。

### 同会话复用与跨会话共享

仅在实现原生共享并扩展宿主后执行本节；普通一次性 CLI 无须为此改造成常驻服务。当前外层 worker 仍按会话独占，内置 Codex 五会话池不是自定义引擎的通用能力。

共享专项须记录原生版本、容量和项目／供应商／凭据／身份边界，并验证：

1. 至少两路及容量加一的真实重叠执行；以随机标记、原生 session/run ID 与内层 PID／连接证明上下文、固定指令、事件和回调不串会话。
2. A 等审批时 B 继续输出并能独立停止；双审批分别允许／拒绝，同会话重叠请求拒绝或排队。
3. stop/cancel/unload 精确作用于目标会话，最后一个租约释放才关闭共享运行时；等待审批不算空闲，不被 TTL/LRU 淘汰。
4. 崩溃／EOF／协议错误立即终结相关等待者和审批；旧确认绑定旧进程代次及请求 ID，迟到点击失效，恢复后产生新审批。
5. 配置／身份变化、插入、卸载和退出回收；不能在不同 worker 间私借子进程，或私建无人管理的共享服务。

报告分别列出离线协议测试与真实原生证据；协议有字段、同一 Python 对象或外层 PID 均不等于共享验收。原生版本、依赖或宿主共享实现变化后重测。

## 报告与注册

`validation.json` 为本机签名报告，绑定代码、依赖和配置指纹，不列入 files，不手动修改。任何变化后重新 validate；注册核验签名与指纹。导出只附安全摘要，接收者重新安装和验收。报告明确实际版本、平台、通过／失败／不适用项及证据范围，不把一个平台通过扩展成全部平台通过。
