# 任务状态：用户操作模拟结果

日期：2026-11-12。范围：本地任务编排、并发队列、步骤交互、审核、返工、重跑、恢复以及前端状态消费。

## 修复验收（2026-11-12，当前版本）

本地整合补充：全量回归进一步发现取消等待者的清理可能先于取消审计落库，清除同一排队请求标识。新增确定性交错用例 `test_queue_cleanup_waits_for_cancellation_audit`，在修复前到达目标断言失败；首次启动与恢复排队的未接管清理现共用任务操作锁，等待取消记录写入后再按请求标识清理，不放宽健康检查超时或删除原断言。该问题不同于队列名额释放，验收同时保留操作人审计及当前请求所有权检查。

本节取代下方历史记录中的“未修复”状态。此次已经修改业务代码；没有启动应用服务、调用真实模型或操作真实任务。原先 16 个已复现失败已移除 XFAIL，保留目标断言作为普通回归测试；不把预期失败计入通过数。

| 根因 | 已实施修复 | 验收证据 |
| --- | --- | --- |
| E1 手动完成收尾 | 审核与失败消息两条接受产物入口统一检查当前范围；全通过/跳过则完成任务与轮次，否则保留合法等待/停止 | 单步骤、有下游、已有产物的失败消息、历史产物复用对照 |
| E2 终止范围 | “终止任务”取消并等待全部并行分支退出；无运行器时关闭全部待审核分支；活动步骤不会被错误主任务标签隐藏；发布任务及步骤快照 | 真实审核 API、运行中兄弟分支、两个待人工审核分支、AG-UI 状态断言 |
| E3 异常收尾 | 空流程在创建轮次前拒绝；准备阶段也进入异常收尾；并行异常先取消并等待其他协程；最终落库失败仍释放运行器、租约和名额 | 空流程、产物路由故障、最终数据库写入故障、慢收尾期间健康接口 |
| E4 名额泄漏 | 启动取得名额到运行器接管之间的所有失败/取消均释放；每次请求有独立身份，旧清理不能释放新请求 | 首次失败后重试、排队状态持久化失败、旧请求清理与新请求交错 |
| E5 排队取消 | 同一事件循环内取消与授权发放不交错；等待前后验证同一请求，取消后不因队列项缺失而启动 | 同轮取消/释放、状态事件发布/等待间隙取消、队列重启恢复 |
| E6 入口绕过名额 | 普通启动、指定步骤启动、审核恢复、自动重试、崩溃恢复统一在引擎调用前取得名额；已有排队启动时拒绝另一路步骤重跑 | 满额下重跑/审核不能进入模拟引擎；排队重跑停止后无执行、无残留资源；排队启动被重跑干扰时保持原队列并只执行一次 |
| E7 旧审核 | 普通决定校验当前轮次及有效审核；相同有效决定仍幂等；明确接受历史产物的 set_complete 保留原能力 | 旧窗口 approve/reject/terminate 拒绝；双窗口相同/冲突决定；原产物复用回归 |
| E8 恢复与停止 | 恢复准备受同任务操作锁保护；启动前重读当前轮次、停止状态和租约；已替换运行标记 superseded，已结束任务不重放 | 恢复准备/启动之间停止、旧 running 轮次残留、正常关闭与过期/有效租约恢复 |

补充边界覆盖在 `tests/test_workflow_lifecycle_regressions.py`：无限并发切换为有限并发、关闭服务保留队列输入、引擎调用前停止、慢数据库健康检查，以及两个待审核分支一并终止后的事件同步。所有持久化仍通过项目数据库执行器。

### 全量与专项验证

- 前端 `yarn --cwd apps/web test`：**1,993 passed**，没有跳过或失败。
- 前端 `yarn --cwd apps/web build`：通过；保留构建工具原有分包/动态导入警告。
- 后端首轮全量：4,496 passed、4 failed；失败中的两个渠道审核测试迁移到锁内恢复的模拟入口，一个产物路由测试补全真实启动应有的 active_workflow_run_id，统计权限测试补全创建者并增加同项目其他用户对照。未删除行为断言、未降低权限要求。
- 修正后专项：审核/API **205 passed**；新增生命周期/渠道审核/产物路由 **61 passed**；统计权限 **1 passed**。
- 最后补充“已排队启动与另一窗口重跑”保护后，启动、审核、恢复、并发、自动重试、渠道审核及全部新增状态测试重新运行：**271 passed**。
- 后端全量重跑：**4,516 passed、0 failed**（459.18 秒）。该轮在最后一项排队/重跑保护补丁前已启动；最后补丁完成后的当前代码另通过上述 **271 项**受影响回归，不将两轮相加为独立用例数。
- 本次修复范围的 `git diff --check`：通过。最终全工作区检查另外发现正在修改的 `services/html_preview.py:73` 存在行尾空格；该文件不属于此次生命周期修复，未覆盖他人的改动。
- 本次修改的 Python 业务文件 `py_compile`：通过。新增四份状态/生命周期测试没有 XFAIL 或跳过标记。后端的 5 条警告来自已有第三方弃用提示及 OpenAPI 重复 Operation ID，不是测试失败。

### 同根因搜索记录

以 `acquire_task` / `release_task` 为精确入口，扩展到所有 `_launch_prepared_run`、`_resume_in_project`、步骤重跑、人工恢复、自动重试和恢复队列调用；以 `manual_continue` 扩展到审核与失败消息两条手动完成入口；以当前轮次和运行租约核对恢复、停止与迟到审核。确认并修复的变体已归入 E1–E8，不另重复计数。聊天通道拥有独立名额语义，本次未改动。仅匹配 `status = ...` 的泛搜噪声过多，未将匹配数量作为缺陷数；每项以可复现行为判定。持续回归入口为上述四个状态审计/生命周期测试文件及原并发、审核、恢复测试。

### 验证范围

这里的“通过”指临时项目、真实 API/数据库/调度器及脚本化引擎的自动化验证。没有进行真实第三方模型端到端调用、真实浏览器断线重连手工验收、多设备网络分区或任意长度操作序列的穷尽验证。数据库持续不可写时，无法保证终态立即持久化；此次保证资源清理不依赖该写入成功，并保留恢复/孤立步骤停止入口。不得据此宣称零回归风险。

## 第二轮复核（2026-11-12，修复前历史记录）

本节取代上一轮的缺陷完整性判断。下方原始矩阵保留作历史证据，不代表交错窗口均已覆盖。
本轮未修改业务代码、未启动应用服务、未操作真实任务；新增 `tests/test_task_state_boundary_audit.py`，更新本报告。

**上一轮的 5 类根因需要扩展到 8 类。** 新增的不是单纯标签显示问题，而是执行入口缺少一致的名额约束、旧审核缺少执行轮次校验、恢复提交与实际启动之间缺少停止校验。已有异常还出现两个资源/排队变体。

### 统一问题清单

| 编号 | 已验证触发及实际结果 | 优先级 | 业务责任位置 |
| --- | --- | --- | --- |
| E1 | 最后一步人工设置完成、不调度下游：真实审核 API 返回成功，Task/Run 仍为 waiting/paused；还有下游时保留 waiting/paused 则正常 | 中 | `review_decision.py:279`、`task_state.py` |
| E2 | 并行 A 等审核、B 在执行；通过真实 API 终止 A：Task=stopped、B=running，运行保护为 false | 高 | `review_decision.py:265`、`task_state.py:104` |
| E3 | 空流程、产物准备异常使运行器退出而 Task 仍 running；补充注入最终执行轮次写入失败，证明后续资源清理会被跳过 | 高（资源清理）；其余中 | `task_runner.py:197`、`workflow_runtime.py:1502` |
| E4 | 首次启动检查失败，已经取得的并发名额未释放；最终写入异常也会留下名额（与 E3 交叉，不另算独立问题） | 高 | `workflow_runtime.py:109`、`:1532` |
| E5 | 取消与发放同轮竞争仍可启动；新增：queued 状态已发布但尚未进入等待时取消成功，队列已清空，随后 wait_task_slot 把“没有等待项”当作可继续，真实模拟引擎仍被调用 | 高 | `concurrency.py:138`、`:156`、`workflow_runtime.py:144` |
| E6（新增） | 并发上限 1、另一任务占有名额：指定步骤启动及人工审核通过后的续跑均直接进入模拟引擎，队列为空、门内只记录另一任务 | 高 | `workflow_runtime.py:1257`、`:969` |
| E7（新增） | A 的审核等待期间从 B 重跑：旧审核已 cancelled、父轮次已 superseded；旧窗口再提交通过/驳回/终止均返回 200。通过/驳回将父轮次重新写为 running；终止将当前 Task 写成 stopped | 高 | `review_decision.py:32` 起，普通决定未核对当前轮次，`:108` 仅 complete_task 有此校验 |
| E8（新增） | 自动恢复已准备、尚未启动时，用户停止审核步骤成功；释放恢复屏障后 Task 从 stopped 变为 completed，步骤仍 cancelled | 高 | `workflow_runtime.py:1141`、`:969` |

E8 的实测结果是**已接受的停止被覆盖，主任务与步骤不一致**。该用例恢复的是执行已成功、审核尚未完成的步骤，不据此宣称所有场景都会重新调用真实模型。

### 第二轮操作矩阵与证据级别

| 检查范围 | 本轮证据 | 结论 |
| --- | --- | --- |
| 启动、空流程、准备失败、失败后重试 | 原复现取消 XFAIL 后重跑 | 原 6 个失败均到达目标断言 |
| 人工终止与手动完成 | 新增真实审核 API + 真实运行器、临时数据库 | E1/E2 从内部函数证据升级到用户入口；有下游的手动等待对照通过 |
| 排队取消 | 原同轮竞争 + 新增状态发布/进入等待之间的确定性屏障 | E5 两个窗口均复现；不是靠随机 sleep 碰运气 |
| 指定步骤启动、审核后续跑 | 真正占用并发门名额，并观察模拟引擎 spawn | E6 两条入口复现；未把等待计数当作实际执行数量 |
| 旧窗口审核与新轮次 | 真实 restart 服务 + 三种真实审核 API，先断言 cancelled/superseded | E7 三种决定均接受并修改数据 |
| 停止与恢复 | 真实恢复服务，准备完成到 launch 之间加屏障，再调用停止服务 | E8；没有通过直接改 Task.status 伪造用户停止 |
| 收尾数据库失败 | 只替换 finalize_run 数据库写入点，保留其他运行路径 | E3/E4 变体，名额仍为 1 |
| 正常执行、返工、审核冲突、步骤配置、停止后重跑、租约恢复 | 原回归重跑，并扩大到自动重试、定时任务、租约、分享操作等 | 详见下方运行结果；通过不意味着新增边界也通过 |
| 当前窗口审核后刷新、共享消息快照、状态消费 | 前端组件、hook/store 测试；同时检查 useTaskReviewActions 的操作后刷新和 useWebSocket 的重连刷新代码 | 不将其称为真实浏览器、多设备断线重连验收 |

### 修复范围与验收调整

不能继续以“只修原 6 个场景即可”作为修复边界，也不能先承诺改动一定很小。仍没有要求重写 DAG 调度或各引擎协议的证据；需要统一的是启动/恢复/审核的生命周期边界：

1. 审核决定先核对当前轮次、审核有效状态，再在同一数据库事务中应用；明确终止是步骤还是整个任务，实际资源必须同步收尾。
2. 所有可发起执行的入口统一遵守名额所有权；重跑的名额转移、审核等待后重取、恢复并发策略需明确，不能只给 start 加 try/finally。
3. 取消与发放互斥，队列缺失必须区分取消和已经获准；启动前重新核验有效执行意图。
4. 恢复准备和实际启动之间校验当前轮次及停止状态，避免拿旧的模型快照覆盖用户操作。
5. 数据库收尾失败也必须尝试独立释放租约、运行器和并发名额；持久化失败需要留下可诊断、可恢复的记录，不能谎报成功。
6. 手动完成只在当前执行范围全部结束时收尾；保留还有下游时的人工等待。

修复验收必须保留本轮失败断言，逐项移除对应 strict XFAIL；XFAIL 仅记录未修复缺陷，不计通过。新增测试用 `raises=AssertionError`，非断言型运行异常不会被当成预期失败吞掉。

### 第二轮运行结果与复现命令

- 后端合并运行：**476 passed、16 xfailed，41.78 秒**。16 是失败测试用例数，包含相同问题的 API、内部函数、交错和决定类型变体，**不是 16 个独立缺陷**；归并为上表 8 类。
- 新增文件首次不加 XFAIL 执行：10 failed、1 passed；每个失败均到达预期的不变量断言，未出现测试准备报错。
- 原场景取消 XFAIL：6 failed、3 passed，均为原问题目标断言失败。
- 两份异常测试合并取消 XFAIL 再验证：**16 failed、4 passed，2.17 秒**，失败均到达目标断言。
- 前端扩大至 **71 passed、0 failed**（包含原 37 项）；是组件/hook/store 层，不是真实浏览器验收。

后端在 `apps/daemon` 执行（本机命令加 `rtk proxy`）：

```sh
uv run --no-sync pytest tests/test_task_state_boundary_audit.py tests/test_task_state_user_scenarios.py tests/test_task_state_user_interleavings.py tests/test_task_workflow_execution.py tests/test_parallel_review_decisions.py tests/test_rework_loop.py tests/test_step_rework.py tests/test_pipeline.py tests/test_concurrency_gate.py tests/test_concurrency_api.py tests/test_workflow_runtime.py tests/test_task_state.py tests/test_review_gate.py tests/test_recovery.py tests/test_live_step_message.py tests/test_agui.py tests/test_task_auto_retry.py tests/test_task_schedules.py tests/test_workflow_lease.py tests/test_task_step_start.py tests/test_step_success_reuse.py tests/test_task_workflow_boundary.py tests/test_step_artifact_routes.py tests/test_task_workflow.py tests/test_engine_interactions.py tests/test_shared_task_operations.py tests/test_task.py tests/test_task_review_overrides.py tests/test_channel_task_stop.py -q --tb=short
```

直接观察未修复断言（故意返回非零退出码）：

```sh
uv run --no-sync pytest tests/test_task_state_boundary_audit.py tests/test_task_state_user_scenarios.py --runxfail -q --tb=short
```

前端在 `apps/web` 执行：

```sh
node --no-experimental-global-navigator --loader ./scripts/test-loader.mjs --test tests/taskState.test.ts tests/taskDetailStatus.test.tsx tests/taskBoardCard.test.tsx tests/agui.test.ts tests/reviewDecisionActions.test.tsx tests/reviewTerminateAction.test.mjs tests/useTaskReviewActions.test.tsx tests/taskReviewRules.test.ts tests/taskReviewResult.test.tsx tests/sharedTaskMessages.test.ts tests/taskStepConfigController.test.tsx tests/taskWorkflowIsolation.test.ts
```

### 本轮仍未覆盖

- 任意长度操作序列、所有多实例数据库提交交错、跨连接旧事件乱序，未做穷尽验证。
- 全部真实第三方引擎的断网/超时/停止失败及操作系统强杀，没有做真实协议验收。
- 真实浏览器断线重连、多设备网络分区仍未验收；本轮未启动服务或操作用户环境。
- E6 实测两条入口；恢复、切换限额等相关路径已查代码和原测试，不声称每个入口均有新增满额模拟。
- E8 实测恢复审核窗口；执行恢复及多实例租约争抢的全部交错仍需修复时补充。

## 第一轮记录（历史）

## 方法与结果

使用临时项目、SQLite、真实服务/API和脚本化引擎；交互管理器与并发门另做确定性顺序测试。没有调用真实付费模型、外部推广或操作用户任务。注入异常的测试明确替换故障点，不把它们称为真实引擎安装验收。

- 后端执行命令：在 apps/daemon 下，`uv run --no-sync pytest tests/test_task_state_user_scenarios.py tests/test_task_workflow_execution.py tests/test_parallel_review_decisions.py tests/test_rework_loop.py tests/test_step_rework.py tests/test_pipeline.py tests/test_concurrency_gate.py tests/test_concurrency_api.py tests/test_workflow_runtime.py tests/test_task_state.py tests/test_review_gate.py tests/test_recovery.py tests/test_live_step_message.py tests/test_agui.py -q`。结果：344 passed、6 xfailed。
- 新增双窗口审核组合：`uv run --no-sync pytest tests/test_task_state_user_interleavings.py -q`。4 passed。
- 已知异常取消标记验证：`uv run --no-sync pytest tests/test_task_state_user_scenarios.py --runxfail -q`。6 failed、3 passed；失败均到达目标状态断言，非测试准备失败。
- 前端：在 apps/web 下，`node --no-experimental-global-navigator --loader ./scripts/test-loader.mjs --test tests/taskState.test.ts tests/taskDetailStatus.test.tsx tests/taskBoardCard.test.tsx tests/agui.test.ts tests/reviewDecisionActions.test.tsx tests/reviewTerminateAction.test.mjs`。37 passed。

XFAIL 表示已复现且未修复，不计为通过；strict 标记确保修复后必须更新测试。两份新增测试只记录/验证行为，没有修改业务逻辑。

## 操作矩阵

| 阶段 | 模拟操作与异常 | 结果 | 主要行为测试文件（apps/daemon/tests） |
| --- | --- | --- | --- |
| 启动 | 正常启动、空输入、用户身份、未知项目/任务 | 正常路径通过 | test_workflow_runtime.py |
| 启动 | 从中间步骤启动，选择两份边界输入 | 范围和上下文通过 | test_task_workflow_execution.py、test_workflow_runtime.py |
| 启动 | 空画布仍点击运行 | 异常 E3a | test_task_state_user_scenarios.py |
| 启动 | 获得并发名额后启动检查报错，再点击运行 | 异常 E4 | test_task_state_user_scenarios.py |
| 启动 | 产物路由准备发生 I/O 错误 | 异常 E3b | test_task_state_user_scenarios.py |
| 排队 | 满额排队、重复排队、释放后按顺序执行 | 通过 | test_concurrency_gate.py |
| 排队 | 取消后让出事件循环，再释放名额 | 通过 | test_task_state_user_scenarios.py |
| 排队 | 点击取消后，同一事件循环轮次释放名额 | 异常 E5 | test_task_state_user_scenarios.py |
| 排队 | 服务重启后恢复队列、保留用户输入和身份 | 通过 | test_concurrency_gate.py |
| 执行 | 串行、并行、断开节点；一或两次产物返回；恢复会话开/关 | 48 组合通过；脚本化 codex/codex_sdk 适配身份 | test_task_workflow_execution.py |
| 执行 | 发送实时消息、追加指导；引擎不支持实时输入 | 投递或显式拒绝通过 | test_live_step_message.py |
| 执行 | 网络错误后重试、消息未送达、空闲超时 | 错误/重试行为通过 | test_task_workflow_execution.py、test_live_step_message.py |
| 交互 | 工具授权、用户提问、多项等待、逐项回复 | 等待/恢复及待确认列表通过 | test_task_state.py |
| 交互 | 回复后立刻停止；停止后迟到回复 | 首个结果生效、迟到回复拒绝；无残留等待 | test_task_state_user_scenarios.py |
| 审核 | 跳过、自动通过、不通过返工、审核出错、次数耗尽 | 正常路径和人工回退配置通过 | test_review_gate.py |
| 人工审核 | 通过、驳回带反馈、终止后重跑、手动完成已有产物 | 常规路径通过；最后一步完成异常 E1 | test_review_gate.py、test_task_state_user_scenarios.py |
| 并行审核 | 一个审核等待、另一个执行；提前通过/强制通过/驳回 | 不重复执行兄弟步骤，通过 | test_parallel_review_decisions.py |
| 并行审核 | 两个审核连续通过；通过后马上停止任务 | 通过；停止后不启动下游 | test_parallel_review_decisions.py |
| 并行审核 | 两个窗口同时通过/通过，驳回/驳回，通过/驳回，驳回/通过 | 4 组合通过；相同决定幂等，相反决定一个被409拒绝 | test_task_state_user_interleavings.py |
| 并行审核 | 终止待人工审核分支，兄弟分支仍执行 | 异常 E2 | test_task_state_user_scenarios.py |
| 返工 | 上游返回、下游重置；并行分支迟到完成 | 当前覆盖通过，迟到成功不覆盖返工 | test_step_rework.py、test_task_workflow_execution.py |
| 重跑 | 停止执行/审核后改配置重跑；重跑指定阶段；旧轮次清理 | 当前覆盖通过 | test_workflow_runtime.py、test_task_workflow_execution.py |
| 配置 | 切引擎/供应商、重置会话、源流程新增/删除步骤、任务复制 | 配置隔离、上下文交接和明确失败通过 | test_task_workflow_execution.py |
| 恢复 | 执行中崩溃、执行完成但审核未完成、正常关闭、租约过期/仍有效 | 当前覆盖通过；人工等待不自动重放 | test_recovery.py |
| 界面 | 状态事件、审核卡片、步骤与主任务标签、工具等待、删除按钮 | 37 项通过；组件/事件测试，无真实浏览器手工验收 | Web 对应测试文件 |

## 异常归并：6 个触发场景，5 类根因

### E1：手动完成缺少最终收尾

步骤全 passed → set_complete 且不调度下游 → Task=waiting/manual_continue，pending_confirmations=[]。预期全部当前范围通过/跳过后完成。不能简单把所有 manual_continue 自动完成，仍有下游未执行时应保留等待。

### E2：终止审核写入整任务停止，但兄弟仍在运行

A=awaiting_review、B=running → 终止 A 审核 → Task/WorkflowRun=stopped、B=running、task_has_active_execution=false。预期终止范围与真实执行一致，运行中的资源始终受保护。审查对象为审核决策持久化及其调用方，而非外部模型。

### E3：执行器退出未统一收尾（两个触发场景）

E3a 空流程提前返回；E3b 产物路由初始化抛错。均得到 Task=running、WorkflowRun=failed、运行器不存在。应禁止非法启动并把准备过程纳入统一异常收尾。启动轮次失败与主任务失败必须一致。

### E4：启动失败未释放已占名额

并发上限1 → acquire成功 → 启动检查异常 → retry=already_active，其他任务queued。应将名额取得到运行器接管之间纳入失败释放。测试在启动检查边界注入异常，独立于具体校验文案。

### E5：队列取消与授权启动不互斥

取消被接受但异步清理未执行 → 前任务释放名额 → 被取消者获准并继续。应保证取消与发放原子化，启动前验证有效启动意图。只增加 sleep 不能修复。

## 不变量与修复验收

1. Task/TaskStep/WorkflowRun/运行器/队列名额必须描述同一执行事实；终态不能掩盖仍在运行的资源。
2. 不存在可恢复执行器或合法队列等待时，不能长期保留 running/queued。
3. 全部当前执行范围完成后，不留下空的手动继续等待；历史移除步骤不阻塞当前流程。
4. 同一审核同一决定幂等，冲突决定明确拒绝；停止后不可被审核续跑意图复活。
5. 已取消排队不得启动；启动失败不占并发额度。
6. 新轮次只接受自己的执行结果，历史会话和返工标记不被迟到成功覆盖。

## 覆盖边界

这是一轮已列明操作及交错顺序的验证，不是对任意长度操作序列的穷尽证明。恢复和人工停止精确撞在数据库提交窗口、旧轮次跨连接乱序事件、所有真实第三方引擎协议故障、真实浏览器断线重连及多设备网络分区，仍未新增确定性枚举。不得把已有恢复测试或组件测试表述为这些场景均已验收。

原任务未修改，业务修复未实施；后续修复应逐项移除对应 XFAIL 并保留断言。
