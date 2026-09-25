# 任务详情与流程运行时的模块设计

本文按 **module / interface / seam / adapter / depth / locality** 的设计词汇审查当前代码。设计目标是让调用方只需掌握少量稳定信息，让变化和测试集中在真正拥有行为的模块。行数仅用于发现问题，不作为拆分完成条件。

## Web：任务会话时间线

**基线。** 实施前 `apps/web/src/components/TaskDetailView.tsx` 约 3771 行，`TaskDetailViewProps` 混合了历史与实时消息、滚动、产物、审核、编辑器、Git 和布局。`TaskDetailPage.tsx` 已用 `TaskDetailReadCapabilities` 统一任务页与分享页的查看能力，但仍把大部分属性原样透传。部分测试读取 `TaskDetailView.tsx` 源码文本，移动职责时会因文件位置变化失败。

**第一条 seam：会话时间线。** 先把历史/实时消息归并、动作消息排序和最新消息索引放入 `taskConversationFeed.ts`；把未读、滚动跟随、媒体/内容尺寸变化与历史分页放入 `useTaskConversationScroll.ts`。两者已经由共享任务详情调用，任务页和分享页继续走同一实现。消息卡片、审核和编辑器仍在 `TaskDetailView.tsx`；只有找到能收口它们状态与交互的简洁 interface 时才继续移动。

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

上面的完整渲染模块仍是后续设计草图。当前已实现的两个内部 interface 分别是 `buildTaskConversationTimeline(...)` 和 `useTaskConversationScroll(...)`。未来若抽出消息卡片，应避免把整组页面 state/setter 装入对象后透传。

**依赖与验证。** 消息归并、筛选是 in-process 依赖；滚动依赖浏览器 DOM，用真实组件测试验证跟随、暂停与跳至最新。历史和产物的远程读取由现有 `TaskDetailReadCapabilities` adapter 提供，任务页与分享页是两个真实 adapter。新增行为测试归属新模块；仍保留的页面源码断言只检查组装，并在后续迁移消息卡片时同步替换。

**暂不做。** 不把 200 多行属性声明机械拆成几个透传对象，也不因文件超过 800 行就拆每个 JSX 区块；这两种做法不会缩小调用方需要掌握的 interface。

## Daemon：流程恢复决策

**基线。** 实施前 `apps/daemon/services/workflow_runtime.py` 约 3157 行。`WorkflowRuntime` 同时编排启动、消息、审核、重跑、启动恢复、租约和执行收尾。外部使用者主要通过 `WorkflowRuntime` 发起或恢复运行，无需扩大它的 interface。

**第二条 seam：单项目恢复工作单元。** `WorkflowRuntime.recover_running_workflows()` 保持外部入口。`workflow_recovery.py` 的 `prepare_project_recovery(...)` 在项目数据库执行器内读取运行状态、检查租约、封闭中断日志并持久化恢复状态，返回只含标识、时间、步骤配置等纯数据的 `RecoveryDecision`。运行时拿到结果后再读取启动所需模型、创建异步任务和发布事件；数据库工作线程不创建 `asyncio.Task`。

```python
decision = await project_manager.run_db(project_id, lambda project:
    prepare_project_recovery(
        project,
        active_task_ids=active_task_ids,
        owner_id=owner_id,
        current_workflow_steps=current_workflow_steps,
    )
)
```

`RecoveryDecision.runs` 包含需恢复的运行，`contended_run_ids` 包含活跃租约待重试的运行；终止运行不进入结果。租约续约仍由运行时持有，避免为单一实现引入抽象 adapter。该 seam 的依赖是本地可替代的项目 SQLite，测试使用真实项目数据库和慢 I/O canary，验证事件循环仍可响应。

**验证。** `tests/test_recovery.py` 守护活跃租约、过期接管、步骤恢复和收尾行为，并新增慢恢复工作单元、慢路径检查的事件循环 canary。`_resume_in_project` 已转为异步，在项目执行器内执行路径检查与必要的 ORM 写入。

## 优先级

恢复工作单元与 Web 会话数据/滚动模块已实施。Web 消息卡片的独立模块仍需先缩小动作、审核、产物等交互的 interface；在此之前保持它们集中于 `TaskDetailView.tsx`，避免浅模块和大量透传。
