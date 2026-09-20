# 阶段编辑动态引擎配置模板（跟随引擎、执行时传入）

> 状态：已实现。本文为实施记录，当前接口以引擎 capability、工作流 schema 和测试为准。

## 摘要
阶段（含评审）选择 LLM 引擎时，阶段编辑面板按该引擎的 `config_schema()` 动态渲染配置字段（不再只有模型），字段初始值带入该引擎当前全局配置值并固化到步骤定义中；执行时步骤配置作为覆盖项传给对应引擎的 `spawn()`，与全局配置按 key 合并（覆盖项优先，空值回退全局）。敏感字段（`sensitive=True` 或 `type=password`）不出现在阶段级配置中，仍只在设置页管理。

## 后端改动

**引擎接口（`apps/daemon/engines/`）**
- `BaseLLMEngine.spawn()` 抽象签名增加 `config_overrides: dict | None = None` 参数；所有引擎实现同步增加该参数并在内部与全局配置合并：
  - 合并规则：`effective = {**全局config_store值, **非空覆盖项}`；显式 `model` 参数优先级高于覆盖项中的 model。
  - `codex.py`：覆盖 `sandbox_mode` / `model_reasoning_effort` / `approval_policy` 后再拼 CLI 参数（注意 resume 重启循环里每轮都用合并后的配置）。
  - `codex_sdk.py`、`claude_agent_sdk.py`、`qoder_sdk.py`、`claude_code.py`、`pydantic_ai/engine.py`：在读取 `config_store` 处套用合并结果（pydantic_ai 覆盖 `provider_id` / `mcp_servers`）。
  - `hermes.py` / `openclaw.py` / `acp_base.py`：接收参数但不改变行为（无配置模板），保持签名一致。
- `BaseLLMEngine` 新增 classmethod `stage_config_schema()`：返回 `config_schema()` 中剔除 `sensitive` 与 `password` 类型后的字段列表，供阶段级使用。

**工作流定义与执行链路**
- `services/workflow_definition.py` `_normalize_step`：透传 `config`（dict，默认 `{}`）与 `review.config`（同结构）；对非 dict 值抛 `WorkflowValidationError`。
- `services/pipeline.py` `Step`：新增 `config: dict`（默认 `{}`），`from_dict` 读取 `config`；`review` dict 内的 `config` 随原样保留。
- `services/task_runner.py`：构建 `spawn_kwargs` 时加 `config_overrides=step.config or None`。
- `services/review_gate.py`：评审 `engine.spawn(...)` 增加 `config_overrides=config.get("config") or step.config or None`。
- 无需迁移：旧步骤无 `config` 键即回退全局配置；任务创建本就快照整个 steps JSON。

**API**
- `/api/engine/list` 已内嵌 `config.fields/values`；在 registry 的 `_engine_config_payload` 中额外输出 `stage_fields`（调用 `stage_config_schema()` 序列化），避免前端自行过滤敏感字段出错。

## 前端改动（`apps/web`）

**数据与类型**
- `api/client.ts`：`EngineConfigPayload` 增加 `stage_fields: EngineConfigField[]`。
- `FlowCanvas.tsx` `StepNodeData` 增加 `config`；`loadCanvasData` 两种格式均读取 `n.config || {}`、`review.config || {}`；序列化回写时原样带上。

**阶段编辑面板（`NodeConfigPanel`）**
- 选中引擎后，用该引擎 `config.stage_fields` 动态渲染字段；切换引擎时 `config` 重置为该引擎 `config.values` 中对应 key 的值（带入全局值并固定），`model` 仍清空走现有逻辑。
- 评审区块按其 `review.engine`（空则跟随主引擎）渲染一套动态配置。
- 保存校验：字段值命中 `confirm_values` 时用 `ConfirmDialog` 确认后再保存。
- 新文案先写 `zh-CN.ts`，其余词典用中文占位且键集合一致。

## 测试计划
- 后端 pytest：`test_workflow_definition.py`（config 透传/默认/非 dict 报错）、引擎覆盖测试（codex CLI 参数采用覆盖值、空覆盖回退、显式 model 优先）、`test_review_gate.py`（评审收到覆盖）、engine list 契约（`stage_fields` 无敏感字段）。
- 前端 node:test：切换引擎生成初始 config、序列化/反序列化保留 config。

## 假设
- 阶段配置保存后即固定，全局配置变更不影响已保存阶段。
- 字段留空运行时回退全局配置。
- 协调器配置不在本次范围。
