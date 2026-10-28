# 任务状态优化验证记录

日期：2026-10-28。范围：任务主状态、原因子状态、待确认项及其 API、事件、列表、详情和通知消费者。验证针对当前工作区源代码；未部署、重启服务或修改真实远程任务。

## v1.0.16 发布回归补充

交付提交 `b39bdd80` 的本机后端全量为 3707 通过、4 跳过；显式配置现有 Chromium、Playwright ESM 入口及网关源码／依赖路径后，预览隔离文件 9 项通过，包含原先跳过的四种传输用例。Web 为 1687 项通过。

GitHub CI 首轮远程创建任务健康检查超过原有 150ms 阈值，本机创建／复制两项复测通过，CI 重跑也通过该项；未放宽阈值。重跑另发现并行审核通过／强制通过后不能完成，定位到人工审核记录已公开、原协程尚未消费待审核结果时，旧结果覆盖用户决定的竞态。

在原真实 API 用例中增加受控时序：阻止待审核结果落库，提交用户决定后再放行。旧代码下通过／强制通过两项稳定超时；修复为一次性初始化人工审核记录，且在数据库工作单元中核对决定，不覆盖已决定步骤或补写过时的等待消息。保留审核驳回、重复提交、兄弟步骤只执行一次和慢 SQL 健康检查。相关审核／恢复 77 项通过；修复后的全量及 GitHub CI 结果以随后发布检查为准。

## 自动验证

| 检查 | 结果 |
|---|---|
| daemon 全量 `WORKSTEP_ENV=test uv run --no-sync pytest -q --tb=short -ra` | 3701 通过、0 失败、4 跳过，390.91 秒 |
| Web 全量 `yarn test` | 1686 通过，0 失败、0 跳过 |
| Web `yarn build` | 通过 |
| 网关分享 `yarn build:gateway-share` | 最终状态修复后复核通过 |
| Web `yarn lint` | 通过，有现存警告 |
| `git diff --check` | 通过 |

后端首轮全量为 3678 通过、19 失败、4 跳过。失败逐项分析后，修复实际问题并更新旧状态断言和数据库执行器测试桩；相关 146 项回归及最终全量均已通过。后端 5 条警告来自依赖弃用提示及已有 OpenAPI Operation ID 重复。

## 核心覆盖

| 场景 | 验证入口 |
|---|---|
| 并行分支运行并保留待审核项；只剩人工决定进入等待 | `test_task_state.py`、Web `taskState.test.ts` |
| 多个工具审批/问题逐项响应；SQL 繁忙时健康检查仍响应 | `test_task_state.py`，真实 FastAPI、SQLite 和 AG-UI |
| 工具等待期间禁止任务删除、归档、Git 工作区移除 | `test_task_state.py`、`test_git_api.py`、Web `taskBoardCard.test.tsx`、`mobileTaskActions.test.tsx` |
| 流程增删节点、历史步骤、局部执行范围和汇总幂等 | `test_task_state.py`、`test_task_workflow_execution.py` |
| 旧数据库字段补齐、旧暂停状态归类、重复启动不丢会话 | `test_migrations.py` |
| 审核通过/驳回/终止/设置完成、返工上限、产物路由冲突 | `test_review_gate.py`、`test_rework_loop.py`、`test_artifact_port_routing.py`、`test_task_workflow_execution.py` |
| 手动停止后编辑并重跑；断线重试、会话恢复和清除旧审批 | `test_task_workflow_execution.py`、`test_workflow_runtime.py`、`test_recovery.py` |
| 任务状态事件、远程订阅、分享、CLI 和协调助手 | 后端全量中的 `test_main.py`、`test_agui.py`、远程/分享/CLI/协调助手测试组；Web 全量 |
| 通知订阅、事件去重和机器人正文 | `test_notification_hooks.py`、`test_notification_delivery.py` |

## 本轮测试发现并修复

- 工具审批时，卡片和移动端仍暴露归档入口；Git 工作区删除及任务删除的前置工作区清理只判断 `running`。
- 下游 `rework_waiting` 被当作执行活动，掩盖阻塞它的人工审核，导致执行器结束后总状态仍为运行中。
- 人工审核通过后触发路由冲突时，任务已失败但流程轮次与通知仍标为暂停。
- 新的任务 `waiting` 生命周期事件未触发现有通知订阅。保留旧 Webhook `paused` 标识以兼容接收方，面向使用者的名称改为“任务等待确认”；手动停止发送 `stopped`。

首轮有一个动作日志慢写健康检查用例在前端测试/构建并行期间超过计时阈值，单独复测通过。最终后端全量与前端构建错开运行，不放宽该阈值。

## 验证边界

- 远程和分享验证使用隔离的集成测试环境，未在真实远程任务上触发执行或审核。
- 后端 4 项跳过均来自 `test_html_preview_isolation.py:140`，需要配置 `WORKSTEP_PLAYWRIGHT_MODULE` 和 `WORKSTEP_CHROMIUM` 才能执行真实浏览器隔离验证；未将跳过计为通过。
- 320/390/1023px 的人工浏览器视觉核对尚未完成：前次本地预览被浏览器工具的 `file://` 协议限制拒绝，未绕过该限制。
- 构建仍有包体积和动态导入提示；静态检查仍有现存警告。本轮未扩展到无关样式、打包拆分或其他工作区变更。
