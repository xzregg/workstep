# 前端（技术待定）

## 核心页面

| 页面 | 功能 |
|------|------|
| **Dashboard** | 多项目看板，每个项目显示任务列表和阶段状态 |
| **Canvas Editor** | Dify 风格节点画布，拖拽编辑工作流 DAG |
| **Task Detail** | 单任务详情：阶段时间线、LLM 对话回放、产物预览 |
| **Settings** | 引擎检测、项目注册、工作流模板选择 |

## 技术候选

| 方案 | 画布能力 | 包体积 | 适合场景 |
|------|---------|--------|---------|
| **React + React Flow** | 最成熟，Dify/n8n 同款 | 大 (~200KB) | 重度交互 SPA |
| **Vue + Vue Flow** | 可用 | 中 | 如果更熟 Vue |
| **Svelte + Svelte Flow** | 可用 | 小 | 最轻 |
| **纯 HTML + LiteGraph** | 自己写 | 最小 | 不想上构建链 |

## 状态管理

```
全局状态
├── projects: Project[]          # 已注册项目列表
├── activeProject: string | null # 当前选中项目
├── tasks: Record<projectId, Task[]>
├── taskSteps: Record<taskId, TaskStep[]>
├── sseConnection: EventSource   # 全局 SSE 连接
└── availableEngines: Engine[]   # 已安装引擎
```

## 看板任务状态与颜色规范

任务卡片左侧使用 `3px` 状态色边框，卡片右上角的状态徽标使用同一语义色的浅色背景。颜色必须来自全局 CSS token，不允许组件内另写十六进制颜色。

### 任务状态

| `task.status` | 中文语义 | 浅色主题 | 深色主题 | CSS token | 看板表现 |
|---|---|---:|---:|---|---|
| `ready` | 预备中 / 未开始 | `#86868b` 灰色 | `#636366` | `--status-ready` | 灰色左边框与徽标 |
| `running` | 进行中 | `#0071e3` 蓝色 | `#0a84ff` | `--status-running` | 蓝色左边框与徽标 |
| `paused` | 已暂停，等待继续或干预 | `#eab308` 黄色 | `#ffd60a` | `--status-paused` | 黄色左边框与徽标 |
| `stopped` | 已停止 / 已取消 | `#dc2626` 红色 | `#ff453a` | `--status-stopped` | 红色左边框与徽标 |
| `passed` | 已完成（兼容/目标状态） | `#16a34a` 绿色 | `#30d158` | `--status-done` | 绿色左边框与徽标 |
| `failed` | 执行失败（兼容状态） | `#dc2626` 红色 | `#ff453a` | `--status-failed` | 红色左边框与徽标 |

渲染规则：

1. 左边框只由 `task.status` 决定，当前实现位于 `TaskList.tsx::STATUS_COLORS`。
2. 未识别或缺失的状态回退为 `ready` 灰色，不能使用阶段颜色兜底。
3. 状态徽标和左边框必须使用同一个 CSS token。
4. 阶段配置中的 `color` 是阶段身份色，只用于泳道标题圆点、阶段头像、阶段标签和详情时间线；不得覆盖任务状态边框。
5. 卡片所在泳道由 `task_steps` 的当前进度推导，和任务状态颜色是两个独立维度。例如任务可以位于“测试”泳道，同时因暂停而显示黄色边框。

### 任务状态与阶段状态的边界

| 范围 | 状态集合 | 用途 |
|---|---|---|
| 任务 `tasks.status` | `ready / running / paused / stopped`，前端兼容 `passed / failed` | 整张卡片的运行状态、左边框和状态徽标 |
| 阶段 `task_steps.status` | `pending / running / passed / failed / skipped` | 当前泳道推导、阶段时间线、输入输出完成状态 |
| 阶段定义 `steps.json.nodes[].color` | 任意合法颜色值 | 阶段身份识别，不表达任务是否成功 |

### 已知状态模型缺口

当前后端在任务全部阶段完成后会把 `tasks.status` 重新设为 `ready`。这使“新建未运行”和“全部完成”共享同一状态，完成后的卡片可能显示灰色而不是绿色。

后续迁移应将任务终态拆为独立的 `passed`（或统一命名后的 `completed`），并同步修改：

- `models/task.py` 的状态说明；
- `TaskRunner` 与单阶段 `TaskService` 的成功收尾；
- WebSocket 状态事件；
- `TaskList` / `TaskDetail` 的中文标签；
- 旧数据库中完成任务的迁移或派生规则。

## SSE 消费

```javascript
const es = new EventSource('/api/events');

es.addEventListener('task_event', (e) => {
    const { project, taskId, step, type, ...data } = JSON.parse(e.data);
    // 路由到对应 task + step 的消息列表
    store.appendMessage(project, taskId, step, { type, ...data });
});

es.addEventListener('task_status', (e) => {
    const { project, taskId, step, status } = JSON.parse(e.data);
    store.updateStepStatus(project, taskId, step, status);
});
```

## 消息渲染

每条消息根据 `type` 渲染不同 UI：

| InternalEvent type | 渲染 |
|---|---|
| `text_delta` | Markdown 文本（实时追加） |
| `thinking_delta` | 折叠面板，灰色斜体 |
| `tool_use` | 工具卡片（文件路径 / 命令 / diff） |
| `tool_result` | 工具结果（代码块 / 输出） |
| `usage` | 底部统计条（token / 耗时） |
| `error` | 红色错误卡片 |
| `status` | 状态标签（initializing / running） |

## 画布编辑器需求

- 拖拽创建阶段节点
- 节点显示 inputs / outputs 端口
- 节点间连线表示产物流转
- 连线可拖拽端点重连
- 节点可编辑（prompt / engine / inputs / outputs）
- 保存为 steps.json
- 加载 steps.json 恢复节点位置与连线

## 中途干预 UI

当 Claude 触发 `AskUserQuestion` 或 Hermes 请求权限时：

1. SSE 推送 `tool_use` 事件（type 为 `AskUserQuestion`）
2. 前端弹出选择面板
3. 用户选择后 `POST /api/runs/{runId}/respond`
4. Daemon 注入 stdin → 引擎继续执行

## 产物预览

详情页内嵌预览：

| 产物类型 | 预览方式 |
|---------|---------|
| Markdown | 渲染为 HTML |
| JSON | 语法高亮 |
| 代码 | 语法高亮 + 行号 |
| 图片 | 直接显示 |
