# 决策模型下载、配置与代理

入口：设置 → 模型与能力 → 决策模型。此功能为可选扩展，不自动介入对话、任务或流程。

## 资源与运行方式

- 本地托管：分别手动下载对应推理组件与所需型号，由 WorkStep 管理离线 CPU 子进程。
- 本地服务：连接已有 Jev 兼容服务，不下载资源或管理其进程。
- 远程服务：连接远程 Jev 兼容服务，测试和保存服务地址、模型及认证信息。

默认目录为 `~/.workstep/decision-models/`，由 `WORKSTEP_CONFIG_DIR` 覆盖；设置页显示后台机器的实际目录。Laya 组件在 `runtime/`，原生组件在 `runtime-gguf/`，模型在 `models/<模型ID>/`。资源不随桌面包分发，升级保留；只在用户点击时下载。模型文件使用固定修订、大小与 SHA-256 校验，运行时禁止隐式联网下载。

## 可选下载型号

| 型号 | 下载大小（十进制，约） | 总内存 / 冷启动可用内存门槛 |
|---|---:|---:|
| Laya Multilingual | 678 MB | 4 / 2 GiB |
| Laya English | 846 MB | 4 / 2 GiB |
| Laya Typed-Decisions | 846 MB | 4 / 2 GiB |
| Kev 0.8B Q8_0 | 812 MB | 4 / 2 GiB |
| Kev 4B Q4_K_M | 3.03 GB | 8 / 4 GiB |
| Kev 9B Q4_K_M | 6.36 GB | 16 / 8 GiB |
| LiquidAI d1-omni-600M Q8_0 | 407 MB | 4 / 2 GiB |
| LiquidAI d1-2B Q4_K_M | 1.10 GB | 8 / 3 GiB |
| LiquidAI d1-3B Q4_K_M | 1.67 GB | 8 / 4 GiB |
| LiquidAI d1-Omni-2B Q8_0 | 1.85 GB | 8 / 4 GiB |

Laya 三个型号共用 Laya SDK 组件；Kev 与 LiquidAI 七个型号共用固定版本 llama.cpp CPU 组件。组件与各模型分别点击下载、取消和删除，不自动安装依赖。Kev 侧重英文；中文可先尝试 Laya Multilingual 或 LiquidAI d1-2B。Typed-Decisions 是英文专项型号。Omni 当前只接入文本，不下载图像／音频投影文件。型号可运行不代表在业务题集上表现更好，新增型号的准确率与吞吐须另行实测。Laya／Kev 使用 Apache-2.0；LiquidAI 使用其 LFM Open License，下载来源链接可查阅模型卡与许可。

点击“使用此模型”修改草稿，再保存为代理的当前型号；可在保存前测试所选型号，测试不会改变已保存选择。未下载的型号可以先选择，但测试和推理仍要求其资源齐备，不自动下载。切换型号时先关闭旧进程，只加载一份模型；对预览测试过的其他型号，下一次代理调用会恢复已保存型号。代理请求省略 `model` 时使用当前选择，显式填写其他型号返回 422，不自动切换。`GET /models` 也只显示已保存的当前型号。

下载清单由 `services/decision_catalog.py` 分别固定到审阅修订，各文件分别核对大小和 SHA-256；型号之间目录隔离。既有 Multilingual 目录和原 `model` 资源接口保留兼容，不要求重新下载。原三个型号的资源参数保留；原生组件参数为 `runtime-gguf`，其余型号的资源参数与模型 ID 相同。

## 本地托管环境检测

设置页按后台机器（Docker 中按容器额度）检测，不根据浏览器或手机判断。当前托管方案使用 CPU，不要求独立显卡；以下为 WorkStep 的保守保护门槛，不是模型官方最低配置或吞吐承诺：至少 2 个可用核心、4 GiB 总内存额度（建议 8 GiB）、冷启动时至少 2 GiB 可用内存；每个型号按上表分别检测内存；首次安装磁盘预留至少 3 GiB 或模型文件两倍加 128 MiB（取较大值），资源齐备后保留 128 MiB。

固定运行组件支持 Python 3.11–3.14、64 位 Windows x86_64、macOS 14+ 的 ARM64、Linux x86_64/ARM64（Laya 要求 glibc 2.28+，原生组件要求 2.35+）。musl 镜像、32 位系统和其他未匹配平台不可托管。Laya 安装前需要 pip 或 uv；原生组件无需 Python 包安装器。两者均需可写的资源目录；实际运行组件安装后还需通过独立子进程导入校验。平台匹配不代表已经完成该平台的安装验收。

不满足条件时，页面置灰本地托管入口、下载和本地推理，列出具体原因与检测额度；可点击“重新检测”。后端同步阻止绕过页面的下载、测试和开启代理；冷启动再次核对。已运行的进程不因自身内存占用被当作可用内存不足，也不在热路径重复检测。释放、取消和删除操作仍可使用。已有本地服务与远程服务配置不受这些托管条件限制。

## 本地托管代理

在本地托管模式勾选“允许其他设备调用本地模型”，保存后生效。代理默认关闭；下载组件、下载模型和开启代理都是独立操作。资源不齐备时推理返回 503，不自动下载。

Base URL 为 `<WorkStep 后台地址>/api/decision-models/v1`。设置页显示本机地址、远程访问配置中的局域网地址和远程地址；实际端口随宿主运行配置变化，不使用前端开发端口。远程地址需要既有反向代理或网络转发可达；此功能不会自动创建公网隧道。

仅开放两个推理接口：

- `GET <Base URL>/models`：当前已保存的本地模型标识。
- `POST <Base URL>/systemone`：Jev 风格的 `state`、`questions` 决策请求，可选 `model`，不是聊天补全接口。

所有调用（包括本机）均须显式认证：`Authorization: Bearer <远程访问密钥>`，也支持现有的 `X-WorkStep-Access` 访问令牌。不接受仅凭浏览器 cookie 的推理请求。已有远程访问密钥直接复用，不复制到决策配置；未设置时可在决策设置中创建共用密钥。设置页不回填密钥。修改密钥立即使旧密码和旧访问令牌失效，清除密钥后代理拒绝服务。这些请求的认证不会为模型设置、下载或删除接口提供额外管理权限。

```bash
curl 'http://127.0.0.1:8765/api/decision-models/v1/systemone' \
  -H 'Authorization: Bearer <WORKSTEP_ACCESS_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"laya-multilingual","state":"The service is ready.","questions":{"ready":{"type":"noul","instructions":"Is the service ready?"}}}'
```

## 资源与性能边界

- 复用一个离线推理子进程，模型只在进程启动时加载；空闲 5 分钟释放。
- Laya 使用分块 JSONL 管道；原生组件仅在本机随机端口监听，采用每次启动生成的临时密钥，端口不直接对外展示。外部调用统一通过 WorkStep 代理。
- 原生计算和分词并行受限：CPU 计算 1 线程，支持 `nice` 的系统降低进程优先级。模型仍与 WorkStep 共用物理 CPU、内存和磁盘，不能保证零资源竞争。
- 单个请求执行，不维护等待队列；同时到达的请求返回 429 和 `Retry-After: 1`。设置测试或资源管理占用服务时也返回繁忙。
- 请求最多 64 KiB、1–8 个问题，状态最多 16000 字符，每个问题指令最多 2048 字符，单个问题序列化最多 4096 字符。
- 请求流读取最长 5 秒；子进程首次响应最长 120 秒，热推理响应最长 20 秒。超时或协议异常终止该进程，下次请求可重建。
- 配置和资源文件操作在线程中隔离；热推理复用内存配置，不重复扫描模型或访问项目数据库。

错误码：401 缺少／无效密钥，408 请求读取超时，413 请求过大，422 请求格式无效，429 繁忙，503 代理关闭、资源缺失或推理失败。远程服务配置不通过此接口转发。

回归测试：`apps/daemon/tests/test_decision_catalog.py`（独立下载校验／删除、草稿与保存选择、真实进程切换）、`test_decision_gguf.py`（固定清单、安全解包、原生进程鉴权／复用／释放）、`test_decision_proxy.py`、`test_decision_models.py`；设置行为：`apps/web/tests/decisionModelSettings.test.tsx`、`settingsDecisionDraft.test.tsx`。慢磁盘和并发请求的健康检查 canary 用于证明事件循环可响应，不代表真实模型吞吐基准。

## 从本地／远程服务读取模型列表

在“本地服务”或“远程服务”填写 Base URL 和可选密钥后，点击“读取模型列表”；无需先填写模型名称。服务地址带 `/v1` 时请求其 `/models`，否则请求 `/v1/models`。相同运行方式与规范化地址下，空白密钥字段沿用已保存密钥；修改地址或切换方式不会向新服务发送旧密钥。

读取成功后打开“搜索并选择服务模型”下拉框，输入关键词筛选并选择。选择只更新草稿，需“保存配置”后持久化，也可先“测试连接”。列表来源服务可能同时返回聊天模型等不支持 Jev 的型号，不能仅凭列表认定可用，连接测试仍核对决策结果。

服务不支持列表、网络不通或认证失败时显示提示，仍可手动填写模型。读取不修改原配置、不自动选择首项、不下载或启动模型；修改服务地址、密钥或方式时取消并清除旧列表。只接受有界模型列表（1 MiB / 1000 项），不跟随重定向。

## 本地型号列表

本地托管直接列出已适配的十个型号，不再设置独立搜索区。资源列表限高、支持纵向滚动和键盘聚焦，标题与后续测试、保存入口位于列表外。配置不足的型号置灰并说明原因；选择只更新草稿，模型和组件仍需分别手动下载。

## 框架兼容核对（2026-11-11）

仅允许选择、搜索和下载 `decision_catalog.py::COMPATIBILITY` 核对过的型号与固定修订；新增型号、修订或后端不能仅因加入清单就自动开放，需同步复核兼容依据。该白名单确认框架适配，不等于每台设备安装验收或业务准确率保证。

- [Laya 官方模型卡](https://huggingface.co/convaiinnovations/laya) 明确列出三种 checkpoint 和 SDK 使用方法，沿用 Laya SDK 0.4.17。
- llama.cpp 官方转换型号 [Kev 0.8B](https://huggingface.co/ggml-org/Kev-0.8B-GGUF)、[Kev 4B](https://huggingface.co/ggml-org/Kev-4B-GGUF)、[Kev 9B](https://huggingface.co/ggml-org/Kev-9B-GGUF) 均明确指定 `/v1/systemone`。
- LiquidAI 官方 [d1-omni-600M](https://huggingface.co/LiquidAI/d1-omni-600M-GGUF)、[d1-3B](https://huggingface.co/LiquidAI/d1-3B-GGUF) 给出 llama-server 与 `/v1/systemone` 示例；[d1-2B](https://huggingface.co/LiquidAI/d1-2B-GGUF)、[d1-Omni-2B](https://huggingface.co/LiquidAI/d1-Omni-2B-GGUF) 明确要求 b11960 及以上。
- 本项目固定原生组件 b12110，并核对该修订 `tools/server/server-decision.h/.cpp` 的 KEV、LFM2_D1、LFM2_D1_OMNI、LFM3_D1、LFM3_D1_OMNI 分支；不是以任意 GGUF 可加载作为兼容依据。
- 当前接入范围是文本 `noul`／`choice`／`score`。d1-2B、d1-Omni-2B 官方明确指出 llama.cpp 尚不支持 `multiple:true` 原生多选，以及 extraction、estimates、boxes；需要多标签判断时可分别提多个 `noul` 问题。Omni 不包含媒体能力验收。
