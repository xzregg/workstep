# 任务增量流程测试矩阵

本文定义任务独立配置的业务测试范围，不把“测试通过”等同于不存在未知问题。

## 配置规则

任务创建时不复制完整流程，`workflow_overrides_json` 为空。任务的有效流程为：**最新主流程＋任务增量覆盖**。任务改过的引擎、模型、提示词、审核及连接优先，任务新增节点保留；未覆盖字段继承主流程更新。

一次运行编译后保持内存配置不变，包括这一运行内的自动重试和返工。停止后再启动、人工审核续跑和服务恢复重新合并最新定义。任务流程画布在执行、审核或排队期间只读，不允许边执行边保存。输入框改引擎持久保存到任务覆盖；重置阶段只重置会话；同步主流程才清除覆盖，且不自动运行。

## 真实运行时组合测试

入口：`apps/daemon/tests/test_task_workflow_execution.py`。使用隔离项目、真实 API、项目数据库执行器、持久化、产物 manifest、DAG、审核和恢复；仅替换引擎传输为确定性测试适配器，不调用外部模型或部署。

| 场景 | 核验内容 |
|---|---|
| 返工组合 24 项 | 原引擎／任务换引擎 × 串行／并行／无连接新增节点 × 一／两次 Bug 返回 × 可恢复／无状态引擎；实际执行引擎、模型、提示词、会话及产物轮次正确 |
| PRD 与 Bug 输入 | PRD 只生成一次；可恢复会话保留原 PRD，新 Bug 增量注入；修复、复测、交付形成闭环 |
| 追加任务产物 | 开发追加 TaskExtra，新增并行节点消费正确端口及最新一轮；不能误用旧产物 |
| 并行迟到结果 | 可控阻塞支线直到测试返回 Bug；支线旧结果不能覆盖返工标记，重跑后交付消费第二轮 Extra；慢 SQL 时健康检查仍可响应 |
| 无连接节点 | 从明确起点的范围执行不包含该节点；手动指定后能执行，其他已完成阶段不能被改成跳过。`autoStart` 仅控制创建后的自动启动，不是节点人工门 |
| 自动／人工审核驳回 | 任务自定义执行和审核引擎、审核提示词生效；驳回反馈进入下一次执行，人工通过后继续下游 |
| 人工通过反馈产物 | 先审核通过 Bug 产物，再沿返回线修复，第二次通过正常报告后交付 |
| 任务返工上限 | 覆盖返回次数及审核重试次数；耗尽时暂停／转人工，不能无限执行或提前交付 |
| 输入框换引擎 | 已完成阶段 A→B；追问、再次启动仍用 B；同引擎复用会话，换引擎交接，新会话重置不把引擎退回 A |
| 同步主流程 | 清除任务引擎覆盖，不自动启动；再次运行用主流程引擎，并建立兼容会话 |
| 运行中配置隔离 | 任务画布拒绝保存；主流程后续编辑不热更新当前下游，下次启动才生效 |
| 停止后加节点 | 执行中或自动审核中停止，审核不能继续挂起；停止后编辑提示词及新增节点，下次运行使用新配置 |
| 返工中／审核中恢复 | 重建运行时恢复；返工中断必须重做未完成轮，不能误用旧成功；审核中断只重跑审核，不重跑已成功执行 |
| 网络故障与失败消息重启 | 引擎自动重试一次；耗尽后按钮重启仍使用任务引擎，复用失败消息，不重复插入执行回复 |
| 主流程新增节点及任务隔离 | 未覆盖新增节点进入任务有效定义并执行；另一个任务跟随主流程，不继承本任务覆盖 |
| 协调助手启动 | 提案校验识别任务新增阶段；确认启动使用任务引擎和动态消息，重复确认不能重复执行 |
| 任务新增流程阶段 | 派发生成独立子任务，从双输入交付阶段开始，上游初始跳过；子任务可独立改引擎，不继承父任务定制 |
| 主流程删除覆盖目标 | 显式冲突，不能静默改用主流程或执行错误节点；同步清除覆盖后恢复可执行 |
| 三种启动来源 | 手动、定时任务、预约启动的运行时入口，均使用任务配置；从双输入阶段创建时使用任务上下文，不错误启动上游 |
| 复制任务 | 保留增量配置及新增节点，但不复制会话或执行历史；复制后修改配置不影响原任务 |

另由 `test_step_rework.py` 确定性模拟“旧成功晚于返工写入”，分别验证产物返回和审核返工，且不得丢失审核反馈。

## 其他层的回归

- 纯配置不变量：`test_task_workflow.py` 验证稀疏差异往返、重复合并稳定性、不修改主流程、受保护字段和引擎参数命名空间隔离；采用现有参数组合，不新增测试依赖。
- 路由边界：`test_task_workflow_boundary.py` 验证语义连接重新编号、范围重算、返回计数保持和未知反馈冲突。
- API、分享与数据库阻塞：`test_api_contracts.py`、`test_share.py`、`test_action_runtime.py`、`test_notification_hooks.py`。
- 原引擎回归：`test_pipeline.py`、`test_rework_loop.py`、`test_artifact_port_routing.py`、`test_review_gate.py`、`test_recovery.py`、`test_workflow_runtime.py`、`test_workflow_step.py`。
- 前端：`taskWorkflow.test.tsx`、`stepPromptEditor.test.tsx`、`flowCanvasNodeLayout.test.tsx` 等验证实时只读、陈旧请求、未保存保护、端口保护、分享查看及失败恢复。
- 网关：`packages/gateway-protocol/tests/` 验证配置读写路由及项目范围。

## 验证边界

之前真实浏览器＋CLI 验收覆盖正常链路和任务编辑、同步、换引擎。本轮新增返工组合为自动化真实 API／运行时测试，不宣称每个组合均逐一人工点击浏览器。真实模型质量、所有供应商实际网络行为、跨设备网络和真实部署不在确定性测试内。

测试不得使用日常项目数据库，不得将测试适配器装入生产引擎注册表。完整回归中若有既有失败，应单列名称和基线证据，不能将其计作通过。

## 2026-10-16 合并前验证结果

分支：`codex/task-flow-overrides`；基线：`dev` 提交 `838905a5`。以下为合并前的历史记录，当时尚未提交、合并或推送。未修改日常任务数据库。

| 测试批次 | 结果 |
|---|---|
| 新增真实运行时业务组合 | 45 通过 |
| 最终执行相关回归（含上述 45 项） | 302 通过 |
| 后端全量 | 3303 通过、12 失败；启动时收集 3315 项，之后补充的 4 项已包含在最终 302 项中验证 |
| 网关共享协议全量 | 86 通过 |
| 前端全量 | 1533 通过、16 失败，与此前干净基线一致 |
| 相关前端组合 | 20 通过 |
| 普通 Web／分享 Web 构建及类型检查 | 均通过 |
| `git diff --check` | 通过 |

后端 12 项在干净基线工作树使用同一环境定向重跑，得到相同名称、相同原因的 12 项失败（另 30 通过、217 未选中），不是本次新增回归：

- `test_backend_layering.py::test_all_api_routes_delegate_database_work_to_services`：三个既有分享 API 直接导入模型。
- `test_engine_live_injection.py` 的两个 `test_qoder_sdk_client_*`，以及 `test_p2_engines.py` 的七个 Qoder SDK 参数化用例：当前复用的开发环境缺少 `qoder_agent_sdk`；没有擅自安装依赖或将这些测试标为跳过。
- `test_system_prompts.py` 的协调助手紧凑英文和步骤术语两个用例：既有提示词长度 3505 超过 2200，且包含 `stage`。

前端 16 项为此前已验证的 browserActor（1）、chatInputLayout（1）、gatewayProjectSettings（6）、gatewayWorkspace（2）、remoteChatSync（1）、taskTableBulkActions（1）、userSettings（4）基线失败。本次不扩展修改这些无关行为，不能声称整个仓库测试全绿。

本轮测试复现并修复两项执行问题：

1. 返工第二轮中断后，恢复完成集合误采更早的成功。现在仅检查同运行、同步骤最新尝试。
2. 并行支线在返工后才完成，旧结果覆盖返工状态。现在在并行批次边界按返工代次校正受影响结果，随后使用新一轮输入重跑；审核反馈仍保留。新增数据库校正通过慢 SQL＋真实健康接口测试。

同时修正了原恢复测试的等待边界：等待 runner 完成收尾后再断言 `WorkflowRun`，不把更早提交的 `Task.ready` 当作收尾完成；未放宽成功断言。

### 复跑命令

在仓库的 `apps/daemon` 目录执行（使用已安装开发依赖的环境）：

```sh
PYTHONPATH=../../packages/gateway-protocol/src uv run --no-sync pytest tests/test_task_workflow_execution.py -q
PYTHONPATH=../../packages/gateway-protocol/src uv run --no-sync pytest tests/test_task_workflow.py tests/test_task_workflow_boundary.py tests/test_task_workflow_execution.py tests/test_step_rework.py tests/test_rework_loop.py tests/test_artifact_port_routing.py tests/test_review_gate.py tests/test_recovery.py tests/test_workflow_runtime.py tests/test_workflow_step.py tests/test_task_review_overrides.py tests/test_pipeline.py -q
```

## 2026-10-16 合并 dev 后复验

- 功能提交：`0699de4f`；合入本地 `dev@2ac3f04a`，合并提交：`521d4fa3`。
- 唯一文本冲突是自动生成的语言目录 revision；基于两边合并后的词典重新生成，得到 3180 个键。提示词、消息归属、任务详情及分享改动均保留。
- 仅合并 `dev` 已提交内容。原 `dev` 工作区的其他未提交修改未被纳入、提交或覆盖；没有合回 `dev`／`main`，没有推送远端。

| 复验批次 | 结果 |
|---|---|
| daemon 后端全量 | 3318 通过、12 失败（共 3330 项） |
| 执行相关回归（含 45 项业务组合） | 302 通过 |
| 45 项业务组合＋dev 提交署名／消息归属测试 | 59 通过 |
| Web 全量 | 1544 通过、11 失败 |
| 网关后端全量 | 429 通过、1 失败、1 跳过 |
| 网关前端全量 | 首轮 225 通过、1 失败；完整复跑 226 通过 |
| 网关共享协议全量 | 86 通过 |
| Web、分享 Web、网关前端构建及类型检查 | 均通过 |

daemon 的 12 项失败在干净 `dev@2ac3f04a` 上再次定向重跑复现（30 通过、12 失败、217 未选中）。通过 JUnit XML 逐项比较，失败集合完全相同：仍为上述模型分层一项、缺少 Qoder SDK 的九项、协调助手提示词两项，没有新增的合并回归失败。

Web 的 11 项在干净的 `dev@2ac3f04a` 工作树定向重跑得到相同失败（22 通过、11 失败）：browserActor（1）、chatInputLayout（1）、gatewayTaskShare（1）、gatewayWorkspace（2）、remoteChatSync（1）、taskTableBulkActions（1）、userSettings（4）。此前 gatewayProjectSettings 的六项失败已随 dev 更新消失；dev 带入的可操作分享强制登录行为与 gatewayTaskShare 旧测试的密码预期不符，本次没有修改此无关行为。

网关后端失败为 `test_control_connection.py::test_local_workbench_manages_gateway_task_shares_over_authenticated_control`：测试仍预期未发布项目不能创建分享，实际已允许。在干净 dev 工作树单独重跑得到同一失败。

网关前端首轮的 `admin-usage.test.tsx` 时间区间用例相差 1 毫秒。`GatewayDateRangePicker` 的“最近 7 天”两次分别调用 `dayjs()`；其源码与 dev 完全一致。该文件在功能分支和干净 dev 各自单独重跑均 9 通过，功能分支完整复跑也 226 通过。保留首轮失败记录，不将其隐去。

所有测试使用隔离配置和项目数据，未启动日常应用进程，未修改真实任务数据库。测试日志位于本次独立临时目录，后端保留 JUnit XML，前端保留完整测试报告；未将临时文件或依赖目录加入提交。
