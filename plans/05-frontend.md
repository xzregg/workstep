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
