# 分阶段构建计划

## P1：单引擎线性管道

**目标**：一个任务用 Claude Code 引擎，沿线性管道从头跑到尾。

**范围**：
- [ ] Daemon: FastAPI + 基础路由（项目注册、任务 CRUD）
- [ ] 引擎: `ClaudeCodeEngine`（spawn + 流式解析 + SSE）
- [ ] 数据: SQLite schema + Peewee 模型
- [ ] 管道: 线性步骤执行（req → ui → frontend → backend → test → deploy）
- [ ] 产物: 落盘 + 下游阶段自动引用
- [ ] 前端: 极简页面（任务列表 + 详情页 + SSE 实时显示）

**验收**：
- [ ] 注册一个项目目录，创建任务，启动后 SSE 实时推送 Claude 的 text_delta
- [ ] 需求阶段完成后产物落盘，UI 阶段自动启动并引用上游产物
- [ ] 任务跑完 6 个阶段，所有事件写入 workstep.db
- [ ] 重新打开项目，能看到上次执行的全部历史和阶段状态

## P2：多引擎

**目标**：支持 Claude / Codex / Hermes 三种引擎切换。

**范围**：
- [ ] `CodexEngine`: spawn + JSONL 解析 + 沙箱策略
- [ ] `HermesEngine`: JSON-RPC 双向通信 + 权限自动批准
- [ ] 引擎注册表: `is_installed()` 检测 + 前端显示可用引擎
- [ ] 每阶段可选引擎（steps.json `engine` 字段）
- [ ] 会话恢复: Claude `--resume` 支持

**验收**：
- [ ] 同一个管道，不同阶段用不同引擎，都能跑通
- [ ] Codex 在 macOS 默认 workspace-write 沙箱
- [ ] Hermes 权限请求自动批准，不阻塞
- [ ] Claude 任务停止后重启能 --resume 继续

## P3：管道编排

**目标**：画布编辑器 + DAG 调度 + 并行分支。

**范围**：
- [ ] DAGScheduler: dependsOn 解析 + ready_steps 计算
- [ ] 并行分支: fan-out (asyncio.gather) + join (等待所有上游)
- [ ] 画布编辑器: 拖拽节点 + 连线 + 保存 steps.json
- [ ] 条件路由: 根据产物内容走不同分支（P1 阶段）
- [ ] 阶段审查: 完成后自动验证产物

**验收**：
- [ ] UI 设计完成后，前端 + 后端同时 spawn 并发执行
- [ ] 测试阶段在前端和后端均完成后才启动
- [ ] 画布上拖拽修改管道，保存后下次打开恢复
- [ ] 阶段审查失败时任务暂停，用户可重试

## P4：干预与回溯

**目标**：中途干预 + 历史回放 + 产物版本。

**范围**：
- [ ] 中途干预: AskUserQuestion → 前端弹窗 → POST respond → 注入 stdin
- [ ] 历史回放: 从 events_json 重放思考 / 工具 / 产物
- [ ] 产物版本: 每次重跑生成新版本，可对比
- [ ] 搜索: 按任务名 / 阶段 / 时间筛选
- [ ] JSONL 调试视图: 查看原始事件流

**验收**：
- [ ] Claude 触发提问时前端弹窗，回答后引擎继续
- [ ] 任意历史任务可回放当时的完整执行过程
- [ ] 重跑某阶段后，旧产物保留为 v1，新产物为 v2

## P5：扩展

**目标**：更多引擎 + API 直调 + 团队。

**范围**：
- [ ] QCodeEngine / OpenClawEngine
- [ ] APIEngine: 直接调 OpenAI / Anthropic API（HTTP + SSE 流式）
- [ ] 工作流模板市场
- [ ] 团队配置（v2，暂不实现）

## 开发原则

1. **TDD**: 每个引擎的 stream parser 先写测试用例
2. **先跑通再优化**: P1 不做画布编辑器，用默认 steps.json
3. **引擎独立**: 每个引擎的 parser 独立测试，不依赖 Daemon
4. **项目隔离**: 所有数据在项目 DB 内闭环，不依赖全局状态
