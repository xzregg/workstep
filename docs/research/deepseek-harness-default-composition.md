# DeepSeek Harness Python SDK 默认组合与模式

> 调研日期：2026-08-15。目标版本：`deepseek-harness-sdk==0.1.0rc6`。仅使用 DeepSeek 官方 GitHub 仓库、官方源码与已安装发行包元数据；源码引用固定到官方仓库提交 [`47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)。

## 结论

1. **`DeepSeekHarness()` 的常规零配置入口会自动使用 runtime wheel 随附的 `bundled_default_config`。** 条件是没有显式指定 `runtime_bin`、`bridge_bin`、`launch_args_override`，环境里也没有非空 `DSH_CORDIS_CONFIG`。SDK 先解析 bundled runtime，再把 `bundled_default_config_path()` 写入子进程的 `DSH_CORDIS_CONFIG`。[Python SDK README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md#L16-L27)；[`HarnessClient._inject_bundled_default_config`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/src/deepseek_harness/client.py#L438-L454)。
2. **Python SDK 没有 `mode` 或 `profile` 参数，WorkStep 不需要、也不应凭空传一个 profile。** SDK 公开配置是 provider/model、cwd/session root、Cordis 配置、运行时路径等；官方明确把 deployment persona 和持久化组合放到 `cordis.yml`。[`DeepSeekHarnessConfig`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/src/deepseek_harness/api.py#L13-L35)；[Python SDK README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md#L49-L51)。
3. **官方 SDK 的零配置默认组合并不是官方示例里的“完整 coding agent”。** 零配置默认只直接列出 JSON-RPC、agent spine、DeepSeek adapter、JSONL persistence/checkpoint、本地 bash 与本地文件系统 provider；由 spine 默认再装配 `bash`、`skill`、`job_output`、`job_list`、`job_kill` 等模型工具。它**没有**启用 `read`/`write`/`edit`、`subagent`、`todo_write`、自动 compaction、Web 或 MCP。
4. **DeepSeek Web/CLI 确实有 `standard`、`code`、`minimal`、`cordis` 四个 Agent preset，默认是 `standard`。** 但它们属于 Web/CLI host 上的 Agent plane，不是 Python SDK 的 profile；其中 `standard/agent.cordis.yml` 依赖 host plane 提供 tools registry、sandbox/approval、persistence、model route、Web、subagent backends 等，不能单独传给 `DeepSeekHarness(cordis=...)`。[官方 preset 与默认值测试](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/tests/web-agent-presets.e2e.ts#L187-L215)；[`standard` 组合的 host-plane 说明](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/standard/agent.cordis.yml#L1-L18)。
5. 官方仓库另有一份面向 Python SDK 的独立 **unattended coding-agent composition**，工具是 `bash`、`read`、`write`、`edit`、`subagent`、`todo_write`，并启用 JSONL persistence 与自动 compaction；它需要调用方显式把 [`examples/jsonrpc-agent/cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/examples/jsonrpc-agent/cordis.yml) 作为 `cordis` 传入，并不是 `DeepSeekHarness()` 的隐式 profile。[jsonrpc-agent README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/examples/jsonrpc-agent/README.md#L1-L15)。
6. **显式传 `runtime_bin` 会关闭 bundled default config 的自动注入。** 若仍要保持零配置默认插件，必须同时传 `cordis=str(bundled_default_config_path())`，或显式设置非空 `DSH_CORDIS_CONFIG`。自定义二进制还必须实际包含该 config 引用的插件依赖，否则 Cordis 启动会失败。[Python SDK README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md#L49-L50)；[runtime wheel README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk-runtime/README.md#L27-L29)。

## 1. `DeepSeekHarness()` 实际如何选择默认配置

`DeepSeekHarness()` 默认构造 `DeepSeekHarnessConfig()`，再把 `runtime_bin`、`launch_args_override` 和环境交给 `HarnessClient`。默认没有显式 runtime，也没有显式 Cordis 文件。[`DeepSeekHarness.__init__`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/src/deepseek_harness/api.py#L48-L83)。

`HarnessClient.start()` 的顺序是：

1. `_default_launch_args()` 解析 bundled runtime；
2. 合并调用方环境；
3. `_inject_bundled_default_config()` 检查是否属于 bundled launch；
4. 满足条件时设置 `DSH_CORDIS_CONFIG=bundled_default_config_path()`；
5. 启动 JSON-RPC 子进程。

对应源码见 [`HarnessClient.start`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/src/deepseek_harness/client.py#L63-L83)、[`_default_launch_args`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/src/deepseek_harness/client.py#L424-L436) 与 [`_inject_bundled_default_config`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/src/deepseek_harness/client.py#L438-L454)。官方还用零配置集成测试覆盖 `DSH_CORDIS_CONFIG` 未设置和空字符串两种情况。[`test_zero_config_run_injects_bundled_default_cordis_config`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/tests/test_bundled_runtime.py#L127-L148)。

自动注入的精确条件如下：

| 条件 | 是否自动注入 bundled default config |
|---|---:|
| 默认 bundled runtime，未传 `cordis`，环境无非空 `DSH_CORDIS_CONFIG` | 是 |
| 默认 bundled runtime，`DSH_CORDIS_CONFIG=''` | 是，空值视为未设置 |
| 显式 `cordis=...` | 否，使用调用方配置 |
| 显式 `runtime_bin=...` | 否 |
| 显式 `bridge_bin=...` | 否 |
| 显式 `launch_args_override=...` | 否 |

运行时本身没有隐藏默认值：它始终要求显式 Cordis 路径；所谓“零配置”是 Python SDK 包装层代为传入 wheel 内的 `runtime/cordis.yml`。[`deepseek_harness_runtime` 模块说明](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk-runtime/src/deepseek_harness_runtime/__init__.py#L1-L19)。

## 2. bundled default config 启用了什么

### 2.1 顶层 Cordis entries

发行 wheel 中的默认 [`runtime/cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml) 直接启用以下 8 项：

| entry id | Cordis plugin | 作用 |
|---|---|---|
| `sdk-jsonrpc-server` | `@deepseek-ai/dsh-sdk-jsonrpc-server` | Python SDK 的 stdio JSON-RPC 服务端 |
| `agent-core` | `@deepseek-ai/dsh-agent-spine-demo` | 通用 Agent 主干；工作区指令预算为 65,536 bytes |
| `llm-deepseek` | `@deepseek-ai/dsh-llm-deepseek` | DeepSeek provider adapter |
| `sessions` | `@deepseek-ai/dsh-session-persistence-jsonl` | JSONL 会话持久化 |
| `session-checkpoints` | `@deepseek-ai/dsh-session-checkpoint-policy` | request、tool dispatch、completed step 的语义检查点策略 |
| `subprocess` | `@deepseek-ai/dsh-subprocess-local` | bash 子进程组及输出管理 |
| `bash` | `@deepseek-ai/dsh-bash-local` | 本地 bash executor，cwd 来自 `DSH_CWD` |
| `fs-local` | `@deepseek-ai/dsh-fs-local` | 本地文件系统 provider，用于加载工作区指令；本身不暴露文件工具 |

最后一点由默认配置自己的注释明确说明：`fs-local` “does not expose model-facing file tools by itself”。因此，不能仅凭默认 config 出现 `fs-local` 就推断模型拥有 `read`、`write`、`edit`。

### 2.2 `agent-spine-demo` 默认嵌套装配

`agent-spine-demo` 是代码组合包。默认配置下，它进一步挂载通用 LLM/session/system-prompt/tools/agent/loop 服务，以及 skill、job、bash 等消费方。完整树由官方包说明与 `apply()` 实现定义。[agent-spine-demo README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/examples/agent-spine-demo/README.md#L9-L40)；[`apply()`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/examples/agent-spine-demo/src/index.ts#L212-L265)。

默认会挂载：

- 核心服务：timer、LLM vocabulary、session store/title、system prompt、tool registry、agent registry、agent loop、LLM retry；
- skill：skill registry、filesystem skill provider、模型工具 `skill`；
- jobs：local job registry、模型工具 `job_output`、`job_list`、`job_kill`；
- shell：shell environment、模型工具 `bash`；
- context：`AGENTS.md` / `CLAUDE.md` 工作区指令加载；
- diagnostics：invariant registry 与 session/agent/scope/agent-loop invariant companions。

默认**不会**挂载 goal stack，因为 `goals` 只有在配置明确提供且不为 `false` 时才装配；也不会自动挂载 top-level config 没有列出的 filesystem tool、subagent、todo、compaction、web、MCP 等插件。[goal 条件](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/examples/agent-spine-demo/src/index.ts#L237-L243)。

### 2.3 模型实际可见的默认工具

在 bundled default config、spine 默认值及默认 `native` 工具呈现方式下，模型工具是：

- `bash`
- `skill`
- `job_output`
- `job_list`
- `job_kill`

工具名称分别由 [`dsh-tool-bash`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/shell/tool-bash/src/index.ts#L243)、[`dsh-tool-skill`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/tool-skill/src/index.ts#L82) 和 [`dsh-tool-jobs`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/jobs/tool-jobs/src/index.ts#L303-L372) 注册。

其中 `skill` 工具是否有可加载的具体 skill，取决于 filesystem provider 在运行环境中发现的 skill 目录；“启用了 skill 工具”不等于 runtime wheel 预装了固定的一组用户 skill。

## 3. “安装进 wheel”不等于“默认启用”

`deepseek-harness-runtime-bin` 的部署根依赖清单包含大量第一方插件，例如 ACP、compaction、filesystem tools、subagent、todo、web、code runtime、approval 等。这个依赖闭包决定单文件 executable **具备加载哪些插件的代码**；实际启动时仍然只运行 `cordis.yml` 列出的顶层插件及其代码组合子节点。[runtime deploy `package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk-runtime/package.json#L7-L115)；[runtime wheel README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk-runtime/README.md#L9-L16)。

因此应区分：

- **bundled / installed**：插件代码被编进 runtime closure，可由 Cordis 配置引用；
- **enabled / mounted**：当前 Cordis 组合实际列出或由组合包实际挂载；
- **model-facing**：已挂载的插件最终向当前 Agent 注册并呈现工具 schema。

不能根据 runtime wheel 的 dependency list，把 `tool-fs`、`tool-subagent`、`tool-todo`、`tool-web` 等都声明成默认已启用。

## 4. 官方提供的其他组合，不是 SDK profile

### 4.1 Web/CLI Agent presets

官方 Web/CLI 交付四个 system Agent presets，并把 `standard` 设为默认：

| preset id | 官方名称 | 能力定位 |
|---|---|---|
| `standard` | 标准模式 | 功能完整的编码 Agent：文件编辑、Shell、文件/网页检索、skills、计划、目标、子代理、工作流 |
| `code` | PTC 模式 | 与 standard 相同的工具能力，但通过 Code Mode SDK 只向模型直接呈现 `run_code` |
| `minimal` | 极简模式 | persistent `bash` + `str_replace_editor` 两个工具 |
| `cordis` | 创造模式 | standard + Cordis 运行时检查、插件实验和 preset 创作能力 |

名称与描述来自各 preset 的官方 [`preset.yml`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets)，四项集合及默认 `standard` 由官方端到端测试锁定。[preset 列表和默认值](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/tests/web-agent-presets.e2e.ts#L187-L193)。

`standard` 在 POSIX 环境的精确工具目录（忽略依赖本机 `ripgrep` 可用性的 `glob`/`grep`）是：

```text
ask_user_question, bash, create_goal, edit, exit_plan_mode,
get_goal, interrupt_agent, job_kill, job_list, job_output,
list_agents, ralph, read, read_image, send_message, skill,
subagent, subagent_fork, todo_write, update_goal, web_search,
workflow, write
```

若本机具备 `ripgrep`，还可能有 `glob`、`grep`。这是官方端到端测试的 exact-catalog 断言，不是根据 package dependencies 推测。[standard 工具目录测试](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/tests/web-agent-presets.e2e.ts#L195-L211)。`code` 不改变底层能力目录，只把模型直接可调用的工具折叠成 `run_code`。[code preset 测试](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/tests/web-agent-presets.e2e.ts#L287-L312)。

但 `standard/agent.cordis.yml` 文件顶部明确声明它只是 **AGENT-PLANE composition**：registries、sandbox/approval、persistence、model route、Web 与 subagent providers 都属于 `base.cordis.yml + web.cordis.yml` 的 host plane。因此：

- 不能把 `apps/cli/config/agent-presets/standard/agent.cordis.yml` 直接当作独立 Python SDK config；
- WorkStep 若要完全复制 Web `standard`，必须为 JSON-RPC runtime 重新组合所需 host plane 与 Agent plane，并逐项处理审批、安全、Web 和 subagent 后端；
- WorkStep 若只需要官方支持的独立 coding SDK，优先采用下一节的 `examples/jsonrpc-agent/cordis.yml`。

### 4.2 官方完整 unattended coding-agent composition

官方 [`examples/jsonrpc-agent/cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/examples/jsonrpc-agent/cordis.yml) 是面向无人值守编码任务的完整组合，启用：

- `bash`，只允许前台运行；
- `read`、`write`、`edit`；
- `subagent`，使用前台 in-process spawn provider；
- `todo_write`；
- JSONL session persistence 与 checkpoint policy；
- token meter 与 automatic basic compaction。

它同时关闭 spine 的 filesystem skill、background job tools 和 workspace-context loader，以得到一套明确的 coding-agent 工具集合。工具清单与 compaction 行为由官方示例 README 明确列出。[jsonrpc-agent README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/examples/jsonrpc-agent/README.md#L5-L15)。

若产品所说的“默认标准模式”实际指这套常用编码能力，WorkStep 应把这份 Cordis composition 作为**自身明确选择的默认配置**，而不是声称 Python SDK 自动选择了某个 `standard` profile。官方 SDK 需要显式传：

```python
DeepSeekHarness(
    ...,
    cordis="/absolute/path/to/workstep-deepseek-coding.cordis.yml",
)
```

### 4.3 官方 minimal composition

官方还提供 [`examples/jsonrpc-agent/minimal.cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/examples/jsonrpc-agent/minimal.cordis.yml)：只暴露 persistent `bash` 与 `str_replace_editor`，不启用 compaction、skills、一次性 bash、task tools 等。[Python SDK 教程](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.md#L83-L102)。它同样需要显式传 `cordis`。

## 5. 各种 “mode / profile” 的真实含义

| 名称 | 可选值 / 示例 | 控制什么 | Python SDK 是否要传 |
|---|---|---|---:|
| SDK Agent profile | 无 | Python SDK 没有该参数 | 否 |
| Cordis composition | 任意 `cordis.yml` 路径 | 实际插件树、persona、持久化与工具 | 只有需要覆盖 bundled default 时才传 |
| Web/CLI Agent preset | `standard` / `code` / `minimal` / `cordis` | Web host 内每个 Agent 的工具与 persona；默认 `standard` | 不能直接传；Python SDK API 无此参数 |
| Tool presentation mode | `native`（默认）/ `code` / `both` | 工具以 function calling、`run_code` 或两者呈现 | bundled default 不需传；code/both 需自定义 composition 并挂载 code runtime |
| Runtime carrier mode | `exe` / `node` / 自动 | bundled runtime 用生产单文件 exe 还是仅开发 node closure | 生产默认自动选择 exe，不是 Agent 行为模式 |
| CLI profile | `web`、`headless`、自定义 profile 等 | `dsh` CLI 的插件 bundle patch stack | 与 Python SDK JSON-RPC 启动无关 |

工具呈现模式的 schema 默认是 `native`；`code` / `both` 还要求 composition 中存在受支持的 `ctx.codeRuntime`，否则系统提示组装会明确失败。[dsh-tools README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools/README.md#L5-L16)。runtime carrier 的选择顺序是显式参数、`DSH_RUNTIME_MODE`、自动，且自动只选择生产 exe。[runtime wheel README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk-runtime/README.md#L20-L25)。CLI profile 则由独立的 `dsh --profile <name>` 启动器解析。[CLI args](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/args.ts#L20-L48)。

## 6. 自定义 `runtime_bin` 时如何保持插件

### 保持 bundled zero-config 默认组合

显式 `runtime_bin` 后，正确做法是同时显式传 bundled default config：

```python
from deepseek_harness import DeepSeekHarness
from deepseek_harness_runtime import bundled_default_config_path

with DeepSeekHarness(
    runtime_bin="/absolute/path/to/dsh-jsonrpc-agent",
    cordis=str(bundled_default_config_path()),
) as harness:
    ...
```

也可以把同一路径放入 `env={"DSH_CORDIS_CONFIG": ...}`，但高层 `cordis` 参数更直接。官方要求自定义组合必须保留 `@deepseek-ai/dsh-sdk-jsonrpc-server`，否则 Python SDK 没有 JSON-RPC 通道。[Python SDK README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md#L27-L39)。

### 使用完整 coding-agent 组合

若 WorkStep 要启用 `read`/`write`/`edit`、`subagent`、`todo_write` 和 compaction，应把自身版本固定的 coding Cordis 文件传给 `cordis`；是否覆盖 `runtime_bin` 与这个选择相互独立。自定义二进制必须包含该文件引用的所有插件。

### WorkStep 实现核对

本次接入已按上述结论调整：`apps/daemon/engines/deepseek_harness.py` 把 WorkStep 自己的 `standard` preset 映射到 `apps/daemon/data/deepseek-harness/standard.cordis.yml`，并在每次构造 `DeepSeekHarness` 时显式传入 `cordis`。因此默认不再依赖 SDK 的精简 bundled zero-config composition。

该 composition 以官方 unattended coding-agent 示例为底座，启用 `bash`、文件读写、subagent、todo、persistence 和 compaction；同时保留 agent spine 默认的 workspace instructions、skills 与 background jobs。这里的 `standard` 是 **WorkStep 对 SDK composition 的产品命名**，不是向 SDK 传递一个不存在的 `mode/profile` 参数，也不宣称等同于 Web/CLI 的完整 `standard` host + agent plane。

## 最终建议

- 对外配置名称用“插件组合 / Agent 组合”，不要叫 SDK `mode` 或 CLI `profile`。
- 用户所说的“默认标准模式”如果明确指 Web/CLI 的 `standard` preset，不能只加一个 SDK 参数实现；要么重新组合完整 host + agent plane，要么清楚标注 WorkStep 首期采用功能较少但官方独立支持的 `examples/jsonrpc-agent/cordis.yml`。
- WorkStep 的 DeepSeek Harness 默认定位为独立编码引擎，采用官方 `examples/jsonrpc-agent/cordis.yml` 的 coding composition 语义并将配置随 WorkStep 固定版本交付；本次实现已完成该项。
- 可选提供“最小模式”，映射官方 `minimal.cordis.yml`；不要把它与 bundled zero-config config 混为一谈。
- 无论选择哪套 composition，WorkStep 上层仍只消费适配后的 ACP seam；Cordis 插件树是 `DeepSeekHarnessEngine` 内部实现细节。
