# 工作流编排

## 工作流定义 (steps.json)

每个项目的工作流定义在 `.workstep/steps.json`，是一个 DAG（有向无环图）：

```json
{
  "steps": [
    {
      "key": "req",
      "label": "需求",
      "color": "#0071e3",
      "engine": "claude",
      "model": "",
      "prompt": "根据业务需求产出 PRD 文档...",
      "inputs": [{"name": "业务需求", "type": "document"}],
      "outputs": [{"name": "PRD 文档", "type": "markdown"}],
      "dependsOn": []
    },
    {
      "key": "ui",
      "label": "UI 设计",
      "color": "#7c3aed",
      "engine": "claude",
      "prompt": "根据 PRD 设计 UI...",
      "inputs": [{"name": "PRD 文档", "type": "markdown"}],
      "outputs": [{"name": "UI 设计稿", "type": "markdown"}],
      "dependsOn": ["req"]
    },
    {
      "key": "frontend",
      "label": "前端开发",
      "color": "#059669",
      "engine": "claude",
      "prompt": "根据 UI 设计稿开发前端...",
      "inputs": [{"name": "UI 设计稿", "type": "markdown"}],
      "outputs": [{"name": "前端代码", "type": "code"}],
      "dependsOn": ["ui"]
    },
    {
      "key": "backend",
      "label": "后端开发",
      "color": "#d97706",
      "engine": "codex",
      "prompt": "根据 PRD 开发后端 API...",
      "inputs": [{"name": "PRD 文档", "type": "markdown"}],
      "outputs": [{"name": "API 服务", "type": "code"}],
      "dependsOn": ["ui"]
    },
    {
      "key": "test",
      "label": "测试",
      "color": "#dc2626",
      "engine": "codex",
      "prompt": "对前后端进行集成测试...",
      "inputs": [
        {"name": "前端代码", "type": "code"},
        {"name": "API 服务", "type": "code"}
      ],
      "outputs": [{"name": "测试报告", "type": "markdown"}],
      "dependsOn": ["frontend", "backend"]
    },
    {
      "key": "deploy",
      "label": "上线",
      "color": "#16a34a",
      "engine": "hermes",
      "prompt": "根据测试报告部署到生产环境...",
      "inputs": [{"name": "测试报告", "type": "markdown"}],
      "outputs": [{"name": "部署完成", "type": "markdown"}],
      "dependsOn": ["test"]
    }
  ]
}
```

**默认 DAG**：

```
                  ┌─ 前端开发 (frontend) ─┐
需求 (req) → UI 设计 (ui) ─┤                      ├─ 测试 (test) → 上线 (deploy)
                  └─ 后端开发 (backend) ─┘
```

## DAG 调度

```python
class DAGScheduler:
    """根据 steps.json 的 dependsOn 构建 DAG，决定执行顺序"""

    def __init__(self, steps: list[Step]):
        self.steps = {s.key: s for s in steps}
        self.graph = self._build_graph()

    def get_ready_steps(self, completed: set[str]) -> list[Step]:
        """返回所有 dependsOn 已满足的阶段（可并行执行）"""
        return [
            s for s in self.steps.values()
            if s.key not in completed
            and all(dep in completed for dep in s.depends_on)
        ]

    def get_downstream(self, step_key: str) -> list[Step]:
        """返回某阶段的所有直接下游"""
        return [s for s in self.steps.values() if step_key in s.depends_on]
```

## 任务执行流程

```
TaskRunner.run(task)
  │
  ├─ 1. 加载 steps.json → DAGScheduler
  ├─ 2. 从 task_steps 表读取已完成阶段
  ├─ 3. 找到 ready_steps（dependsOn 全部 passed）
  │
  ├─ 4. 对每个 ready_step:
  │     ├─ a. 拼接 prompt（见下方）
  │     ├─ b. 选择引擎 → engine.spawn(prompt, cwd)
  │     ├─ c. async for event in engine:
  │     │     event_bus.emit(project, task_id, step_key, event)
  │     ├─ d. 阶段完成 → 审查产物
  │     │     ├─ passed → UPDATE task_steps SET status='passed'
  │     │     └─ failed → UPDATE task_steps SET status='failed', task.status='paused'
  │     └─ e. 递归: get_ready_steps() → 触发下游
  │
  └─ 5. 并行分支用 asyncio.gather，汇合点自然等待所有上游
```

## Prompt 拼接

每个阶段启动时，Daemon 拼接完整 prompt：

```
┌──────────────────────────────────────────┐
│ ① 系统指令块                              │
│    WorkStep 系统 prompt + 工具契约         │
│    (instruction_hash 未变 → 可跳过)        │
├──────────────────────────────────────────┤
│ ② 上游产物引用                            │
│    从 dependsOn 阶段的 artifacts 生成      │
│    "以下文件已就绪: .workstep/artifacts/..." │
├──────────────────────────────────────────┤
│ ③ 阶段专属 Prompt                         │
│    来自 steps.json 的 prompt 字段          │
├──────────────────────────────────────────┤
│ ④ 用户补充说明（可选）                      │
│    任务创建时用户输入的描述                   │
└──────────────────────────────────────────┘
```

```python
def assemble_prompt(self, task: Task, step: Step, project: Project) -> str:
    parts = []

    # ① 系统指令
    parts.append(self._system_prompt(task, step))

    # ② 上游产物引用
    upstream_artifacts = self._collect_upstream_artifacts(task, step, project)
    if upstream_artifacts:
        parts.append(self._format_artifact_refs(upstream_artifacts))

    # ③ 阶段 prompt
    parts.append(step.prompt)

    # ④ 用户补充
    if task.description:
        parts.append(f"## 用户补充说明\n{task.description}")

    return "\n\n".join(parts)
```

## 产物衔接

阶段间通过文件系统传递产物：

```
.workstep/artifacts/
  req/<taskId>/
    prd.md                # 需求阶段产出
  ui/<taskId>/
    design-spec.md        # UI 阶段产出（读取了 prd.md）
  frontend/<taskId>/
    src/...               # 前端代码（读取了 design-spec.md）
  backend/<taskId>/
    api/...               # 后端代码（读取了 prd.md）
  test/<taskId>/
    report.md             # 测试报告（读取了前端 + 后端产物）
```

下游阶段启动时，Daemon 扫描所有上游阶段的 artifacts 目录，生成引用列表注入 prompt。

## 阶段审查

每个阶段完成后，可选启动审查子进程验证产物：

```
阶段完成
  → 审查 prompt（检查文件存在性 + 格式 + 需求匹配度）
  → spawn 审查引擎（可配置，默认同阶段引擎）
  → 审查结果 JSON:
      { "passed": true/false, "score": 0-100, "issues": [...] }
  → passed=true → task_steps.status = 'passed'，触发下游
  → passed=false → task_steps.status = 'failed'，task.status = 'paused'
```

## 并行分支

当 DAG 中有多个阶段同时 ready 时：

```python
async def execute_ready_steps(self, task, project, completed):
    ready = self.scheduler.get_ready_steps(completed)
    if not ready:
        return  # 管道完成

    # fan-out: 同时 spawn 多个引擎
    results = await asyncio.gather(*[
        self._run_step(task, step, project) for step in ready
    ])

    # 更新 completed 集合
    for step, result in zip(ready, results):
        if result.passed:
            completed.add(step.key)

    # 递归: 检查是否有新的 ready 阶段
    await self.execute_ready_steps(task, project, completed)
```

## 工作流模板

内置默认模板（研发流程），用户可在画布编辑器中自由修改或从零创建：

| 模板 | 阶段 | 说明 |
|------|------|------|
| 研发流程（默认） | req → ui → {frontend, backend} → test → deploy | 含并行分支 |
| 写作流程 | 选题 → 大纲 → 初稿 → 审校 → 排版 | 线性 |
| 数据流程 | 数据采集 → 清洗 → 建模 → 评估 → 报告 | 线性 |
| 空白 | （无） | 用户自定义 |
