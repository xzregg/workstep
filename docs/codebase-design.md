# 任务详情与流程运行时的模块设计

本文按 **module / interface / seam / adapter / depth / locality** 的设计词汇审查当前代码。设计目标是让调用方只需掌握少量稳定信息，让变化和测试集中在真正拥有行为的模块。行数仅用于发现问题，不作为拆分完成条件。

## Web：任务会话时间线

**现状。** `apps/web/src/components/TaskDetailView.tsx` 约 3771 行，`TaskDetailViewProps` 从第 201 行到 408 行，混合了历史与实时消息、滚动、产物、审核、编辑器、Git 和布局。`TaskDetailPage.tsx` 已用 `TaskDetailReadCapabilities` 统一任务页与分享页的查看能力，但仍把大部分属性原样透传。大量测试读取 `TaskDetailView.tsx` 源码文本，移动职责时会因文件位置变化失败。

**第一条 seam：会话时间线。** 先抽出拥有消息合并、步骤筛选、未读/滚动跟随、历史分页、消息事件加载和产物入口的模块。它接收任务与步骤标识、历史/实时消息快照、已有查看能力，以及用户意图回调；具体消息渲染和滚动状态留在实现内部。共享页面只负责把任务页或分享页的查看能力接到这条 seam，不重新实现分享版时间线。

```ts
type TaskConversationTimelineProps = {
  taskId: string
  selectedStepKey: string
  feed: TaskConversationFeed
  read: Pick<TaskDetailReadCapabilities,
    'loadMessageEvents' | 'openArtifact'>
  onLoadOlderHistory?: () => void
  onSelectStep: (stepKey: string) => void
}
```

草图中的 `feed` 应是领域快照，避免把整组页面 state/setter 装入对象后透传。编辑器、审核决定和流程配置不属于这个 interface；它们沿现有职责继续独立演进。`TaskDetailView` 最终只选择当前区域并组装模块。

**依赖与验证。** 消息归并、筛选是 in-process 依赖；滚动依赖浏览器 DOM，可用组件测试环境替身；历史和产物的远程读取由现有 `TaskDetailReadCapabilities` adapter 提供，任务页与分享页是两个真实 adapter。测试从任务页和分享页进入同一时间线，覆盖历史+实时去重、切换步骤、未读跟随、加载旧消息、产物打开和分享会话。行为测试迁至模块接口；页面只测试组装。删除对应的页面源码文本断言，不叠加一层同义断言。

**暂不做。** 不把 200 多行属性声明机械拆成几个透传对象，也不因文件超过 800 行就拆每个 JSX 区块；这两种做法不会缩小调用方需要掌握的 interface。

## Daemon：流程恢复决策

**现状。** `apps/daemon/services/workflow_runtime.py` 约 3157 行。`WorkflowRuntime` 同时编排启动、消息、审核、重跑、启动恢复、租约和执行收尾。恢复逻辑从 `recover_running_workflows` 延伸到 `_prepare_project_recovery_sync`；租约续约与延后重试在文件末段。外部使用者主要通过 `WorkflowRuntime` 发起或恢复运行，当前不需要扩大它的 interface。

**第二条 seam：单项目恢复工作单元。** 保留 `WorkflowRuntime.recover_running_workflows()` 作为外部入口。内部提取一个完整的同步数据库工作单元，负责在项目数据库上下文中读取运行状态、检查租约与步骤、生成明确的恢复结果。运行时拿到纯数据后再创建异步任务和事件；不得把 Peewee 模型或惰性查询跨线程返回，也不得在数据库工作线程创建 `asyncio.Task`。

```python
def prepare_project_recovery(project, *, owner_id: str, now: datetime) -> RecoveryDecision:
    """在项目数据库执行器中完成查询与决策，返回可跨线程的纯数据。"""

decision = await project_manager.run_db(
    project_id,
    lambda project: prepare_project_recovery(project, owner_id=owner_id, now=now),
)
await runtime.apply_recovery(decision)
```

`RecoveryDecision` 应明确区分恢复、跳过活跃租约、等待过期及终止状态，并包含调用方执行动作需要的标识；不要返回多个位置相关的元组。租约续约仍由运行时持有，避免为单一实现引入抽象 adapter。该 seam 的依赖是本地可替代的项目 SQLite，测试使用真实项目数据库和慢 SQL canary，验证事件循环仍可响应。

**迁移顺序。** 先用现有 `tests/test_recovery.py` 的活跃租约、过期接管、步骤恢复和收尾行为守护结果；再抽同步决策工作单元；最后让运行时只执行决策。每一步运行相关测试和后端全量测试。若抽取要求把大量可变运行时状态透传进工作单元，应停止该拆分，先缩小决策范围。

## 优先级

先做 Web 时间线：它的查看能力已有两个真实 adapter，seam 较清楚，能同时改善任务页和分享页。后做 Daemon 恢复决策：SQLite 执行器与租约状态需要更谨慎地保持线程及事务不变量。上述接口是设计草图，实施时以现有行为测试与类型检查确定最终形状。
