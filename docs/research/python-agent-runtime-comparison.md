# WorkStep API / BYOK Python Agent Runtime 选型

> 调研日期：2026-08-04。仅采用项目官方文档、官方 GitHub 源码与 PyPI 官方项目元数据。

## 结论

**唯一推荐：引入 `pydantic-ai-slim[openai]`，由 PydanticAI 承担单 Agent 的模型调用、工具调用 loop、流式事件和取消；WorkStep 继续拥有工具安全边界、SQLite 会话数据、统一 `InternalEvent`、任务取消与外层 DAG。不要继续自研完整 agent loop。**

原因是 WorkStep 已经有自己的工作流 DAG 和 `BaseLLMEngine`，需要的是一个可嵌入 FastAPI `asyncio` daemon 的“单次执行 runtime”，而不是第二套工作流编排器。PydanticAI 原生支持 async Agent、函数工具、完整模型/工具事件流、显式流取消、可序列化消息历史，以及 OpenAI-compatible 的 `base_url` / `api_key`；同时提供独立 provider/model 抽象和按 provider 安装的 slim extras，模型厂商绑定最低。[Agent 与 async 运行方式](https://pydantic.dev/docs/ai/core-concepts/agent/)；[完整事件流](https://pydantic.dev/docs/ai/core-concepts/agent/#streaming-all-events)；[流取消](https://pydantic.dev/docs/ai/core-concepts/output/#cancelling-run_stream)；[OpenAI-compatible 配置](https://pydantic.dev/docs/ai/models/openai/#openai-compatible-models)；[多供应商模型抽象](https://pydantic.dev/docs/ai/models/overview/)；[消息历史持久化](https://pydantic.dev/docs/ai/core-concepts/message-history/#storing-and-loading-messages-to-json)。

**次选：LangGraph。** 只有当“引擎内部”必须具备节点级 checkpoint、进程崩溃后从中间节点恢复、time travel 或复杂 human-in-the-loop 时才选它。它的持久化和恢复能力最强，但会和 WorkStep 已有 DAG、运行状态及 SQLite 持久化重叠；实际接入还需 LangChain Agent 与 provider integration，概念和依赖都更重。[LangGraph 定位](https://reference.langchain.com/python/langgraph)；[持久化与恢复](https://docs.langchain.com/oss/python/langgraph/persistence)；[interrupt/resume](https://docs.langchain.com/oss/python/langgraph/interrupts)。

## 对比总表

评分为对 **WorkStep 当前架构适配度** 的 1–5 分，不是框架通用能力排名。

| 候选 | 自定义 base URL / key | 多供应商 | 工具 loop | 流式事件 | 取消 | 会话恢复 | asyncio / FastAPI | 依赖与绑定 | 适配度 |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| **PydanticAI** | 5 | 5 | 5 | 5 | 5 | 4 | 5 | slim、MIT、低厂商绑定 | **5.0** |
| **LangGraph + LangChain** | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 中重；引入第二套图/状态模型，MIT | **4.1** |
| **OpenAI Agents SDK** | 5 | 3 | 5 | 5 | 5 | 5 | 5 | core 较轻、MIT；默认语义明显偏 OpenAI | **3.9** |
| **smolagents** | 5 | 4 | 4 | 3 | 2 | 2 | 2 | core 不大、Apache-2.0；主 loop 同步 | **3.0** |
| **Hermes Agent 内嵌** | 5 | 5 | 5 | 4 | 3 | 5 | 2 | 完整应用级依赖，版本精确锁定，MIT | **2.8** |
| **pi-agent 官方 runtime** | 5 | 5 | 5 | 5 | 5 | 3 | 0 | 官方实现为 TypeScript，MIT | **不适用** |

## 候选证据与判断

### 1. PydanticAI

- `OpenAIProvider(base_url=..., api_key=...)` 明确支持任意 OpenAI-compatible Chat Completions endpoint；另有 Anthropic、Google、Bedrock、Groq、Mistral、OpenRouter、Ollama 等独立 provider/model，实现不是绑定 OpenAI wire format 的单一抽象。[OpenAI-compatible models](https://pydantic.dev/docs/ai/models/openai/#openai-compatible-models)；[models/providers overview](https://pydantic.dev/docs/ai/models/overview/)。
- `Agent` 自带函数工具 loop；`run_stream_events()` / `agent.iter()` 可输出模型增量、thinking、tool call、tool result 和最终结果，便于映射到 WorkStep 的 `InternalEvent`。[Agent tools](https://pydantic.dev/docs/ai/core-concepts/agent/)；[streaming all events](https://pydantic.dev/docs/ai/core-concepts/agent/#streaming-all-events)。
- `StreamedRunResult.cancel()` 和 `AgentStream.cancel()` 可终止 provider stream，并把中断响应标为 `state='interrupted'`；这比仅在 turn 间检查 stop flag 更适合 WorkStep 的即时取消。[cancellation](https://pydantic.dev/docs/ai/core-concepts/output/#cancelling-run_stream)。
- 会话恢复不是强制绑定某个 store：`ModelMessagesTypeAdapter` 可把完整历史 JSON round-trip，再通过 `message_history` 继续新 run。正好复用 WorkStep 的 per-project SQLite，而不引入第二份数据库所有权。[message history persistence](https://pydantic.dev/docs/ai/core-concepts/message-history/#storing-and-loading-messages-to-json)。
- 官方提供 `pydantic-ai-slim`，核心依赖最小、provider 按 extras 安装；截至调研日 PyPI 项目为 MIT、Python >=3.10。[PyPI: pydantic-ai-slim](https://pypi.org/project/pydantic-ai-slim/)。

### 2. LangGraph

- LangGraph 是低层、长运行、有状态 Agent 编排框架；官方建议高级确定性/agentic workflow、自定义延迟和 durable execution 场景使用。WorkStep 本身已经承担这一层，因此能力虽强但职责重叠。[官方定位](https://reference.langchain.com/python/langgraph)。
- OpenAI-compatible BYOK 由 LangChain `ChatOpenAI(base_url, api_key)` 提供；多供应商需要对应 integration package，统一接口能力成熟。[provider/model abstraction](https://docs.langchain.com/oss/python/concepts/providers-and-models)；[ChatOpenAI](https://docs.langchain.com/oss/python/integrations/chat/openai)。
- `astream()` 提供消息、状态、任务和自定义事件；checkpointer 支持 async SQLite/Postgres、thread checkpoint、故障恢复和 resume，能力是候选中最完整的。[streaming](https://docs.langchain.com/oss/python/langgraph/streaming)；[persistence](https://docs.langchain.com/oss/python/langgraph/persistence)。
- 新版 stream handle 有 `abort()`，会关闭 graph iterator 并取消运行中的节点/子图；但普通 `astream()` 的生命周期与 checkpoint 语义仍需 WorkStep adapter 正确收口。[GraphRunStream.abort](https://reference.langchain.com/python/langgraph/stream/run_stream/GraphRunStream/abort)。
- 实际 Agent 方案需要 `langgraph`、`langchain`、至少一个 provider integration，持久化再加 checkpoint adapter；许可证 MIT。[LangGraph PyPI](https://pypi.org/project/langgraph/)；[LangChain PyPI](https://pypi.org/project/langchain/)。

### 3. OpenAI Agents SDK

- 可注入 `AsyncOpenAI(base_url, api_key)`，也可实现 `ModelProvider`；对 OpenAI-compatible BYOK 支持直接。[configuration](https://openai.github.io/openai-agents-python/config/)；[models](https://openai.github.io/openai-agents-python/models/)。
- Runner 自带标准工具调用 agent loop；`run_streamed().stream_events()` 提供异步事件流，`cancel()` 支持立即停止或 `after_turn` 停止。[agent loop](https://openai.github.io/openai-agents-python/running_agents/)；[streaming and cancellation](https://openai.github.io/openai-agents-python/streaming/)。
- 内置 SQLite/AsyncSQLite session，并能把 interrupted run 转为 `RunState` 后恢复，恢复能力优秀。[sessions](https://openai.github.io/openai-agents-python/sessions/)；[results and RunState](https://openai.github.io/openai-agents-python/results/)。
- 主要缺点是默认模型、消息和 streaming 语义以 OpenAI Responses / Chat Completions 为中心；Any-LLM 与 LiteLLM 多供应商适配被官方标记为 best-effort beta，需要逐 provider 验证工具、usage 和 structured output。[third-party adapters](https://openai.github.io/openai-agents-python/models/#third-party-adapters)。因此它是优秀 runtime，但不符合 WorkStep“避免单一厂商绑定”的首要约束。
- core 为 MIT、Python >=3.10，非 OpenAI provider 和数据库后端多为 optional extras。[PyPI: openai-agents](https://pypi.org/project/openai-agents/)。

### 4. Hugging Face smolagents

- `OpenAIModel(api_base, api_key)` 支持 OpenAI-compatible endpoint；还提供 LiteLLM、Bedrock、HF 等 model extras。[model reference](https://huggingface.co/docs/smolagents/reference/models)。
- `ToolCallingAgent` 有 JSON tool call loop，`stream_outputs` 可流模型输出；但官方仍把 Agent API 标为 experimental。[agent reference](https://huggingface.co/docs/smolagents/reference/agents)。
- 核心 `MultiStepAgent.run()` 返回同步 generator，源码没有原生 async run；`interrupt()` 只设置 flag，并在下一 step 循环处检查，无法保证立即取消正在等待的 provider 请求或同步工具。[official agents.py](https://github.com/huggingface/smolagents/blob/main/src/smolagents/agents.py)。这会迫使 FastAPI daemon 使用线程桥接，取消和背压都弱于前三者。
- memory 主要是进程内 steps，可 `reset/replay`；虽有 agent/RunResult 序列化能力，但没有 LangGraph/OpenAI Agents 那样明确的 durable session/checkpoint contract。[memory reference](https://huggingface.co/docs/smolagents/reference/agents#smolagents.AgentMemory)。
- Apache-2.0、Python >=3.10，wheel 较小但 provider、sandbox、transformers 等通过 extras 扩展。[PyPI: smolagents](https://pypi.org/project/smolagents/)。

### 5. Hermes Agent 与 pi-agent

**Hermes Agent：有官方 Python runtime，但不建议进程内嵌入。** 官方明确允许 `from run_agent import AIAgent`，支持 custom endpoint、多 provider、工具 loop、callbacks、SQLite session resume 和中断；所以它不是“只有 CLI”。[Python embedding FAQ](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/faq.md#can-i-use-it-in-my-own-python-project)；[agent loop internals](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md)。但其 `AIAgent` 是完整个人 Agent 应用的核心：包含 CLI、FastAPI/Uvicorn、cron、终端、浏览器、memory、skills 等大量精确锁定依赖；API 调用的中断实现还是后台线程 + interrupt event，而不是端到端 async cancellation。[pyproject dependencies](https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml)；[interruptible API calls](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md#interruptible-api-calls)。对 WorkStep 更合理的方式仍是沿用现有 Hermes ACP 子进程适配，而不是把 Hermes 安装进 daemon 解释器。

**pi-agent：官方 runtime 主要是 TypeScript，不存在官方 Python 实现。** 官方仓库的 `@earendil-works/pi-agent-core` 是 npm/TypeScript package，提供的 Agent loop、event stream、abort、steering 和 provider abstraction 都是 TypeScript API；仓库语言也以 TypeScript 为主。[official pi-agent-core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)；[official pi monorepo](https://github.com/earendil-works/pi)。PyPI 上同名 `pi-agent-core` 的 maintainer/author 不是 pi 官方组织，项目状态为 Alpha，不能视为官方 Python port，也不应作为 WorkStep 基础依赖。[PyPI: third-party pi-agent-core](https://pypi.org/project/pi-agent-core/)。

## WorkStep 落地建议

1. 保留 `BaseLLMEngine` 作为 WorkStep 稳定边界，新建/重构一个 `PydanticAIEngine` adapter；外部仍只看 `spawn()`、`stop()`、`InternalEvent` 与 WorkStep session ID。
2. 安装 `pydantic-ai-slim[openai]` 作为首期依赖。首期用 `OpenAIChatModel + OpenAIProvider(base_url, api_key)` 覆盖 Ollama、vLLM、LiteLLM、OpenRouter 等 OpenAI-compatible BYOK；后续按需增加 PydanticAI 原生 Anthropic/Google provider extra。
3. 将 PydanticAI 的 `PartDeltaEvent`、`ThinkingPartDelta`、`FunctionToolCallEvent`、`FunctionToolResultEvent` 和 usage 映射到现有 `text_delta`、`thinking_delta`、`tool_use`、`tool_result`、`usage`；不要把框架事件类型暴露到前端 API。
4. `stop()` 保存当前 run/stream handle 并调用显式 `cancel()`，同时取消 daemon task；工具 subprocess 仍由 WorkStep 自己负责 process-group 终止。
5. 将 `result.all_messages_json()` 或经 `ModelMessagesTypeAdapter` 序列化后的消息保存到 WorkStep 现有 per-project SQLite；resume 时从 WorkStep DB 恢复 `message_history`。不启用 Pydantic Graph/durable-exec，也不新增第二套 session DB。
6. 保留自研内容仅限：工具安全策略、路径 allowlist、BYOK SSRF/密钥保护、事件映射、WorkStep persistence adapter。模型协议解析、tool-call 拼接、retry/validation、stream cancellation 不再自研。

## 最终决策

**采用 PydanticAI framework，不做轻量自研 agent loop。** 这不是把 WorkStep 改造成 PydanticAI 应用，而是把 PydanticAI 当作 `BaseLLMEngine` 内部可替换 runtime。若未来明确需要“单个 Agent 在 daemon 重启后从工具节点中间精确恢复”，再把该 engine 的 runtime 换成 LangGraph；在此之前不要为未出现的 durable-graph 需求支付复杂度成本。
