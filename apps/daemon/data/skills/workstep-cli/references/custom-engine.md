# 自定义执行引擎接入

本指南使用现有项目聊天，不创建新助手。接入完成的标准是公共验收通过且注册成功。

## 接入步骤

1. 补全引擎名称、唯一小写 ID、官方 SDK/CLI/ACP 文档、认证方式、操作系统和需要的能力。优先查询官方文档。使用 `workstep-cli` Skill 的可用传输执行 `engine list --verbose --json`，确认是否已经接入；更新现有引擎先检查旧包，明确替换意图。
2. 在本次对话提供的工作目录创建 `manifest.json`、`engine.py`、`tests/test_adapter.py`（标准库 unittest）。先写失败测试，再实现映射。参考 [接口规范](custom-engine-contract.md)。不要直接把未验证源码放到正式 `runtime/engines`。
3. Python 类继承 `engines.core.custom_sdk.CustomEngineBase`（或 `AcpEngineBase`），调用 `super().__init__()`，声明唯一 `ENGINE_ID`。实现真实事件转换、实际依赖检查、版本、配置、安装、spawn 与 stop。能力声明必须与真实支持一致；不支持的能力安全降级，不能伪造用量、会话分叉或成功事件。
4. 使用 CLI `engine inspect <绝对目录或py路径> --json`。修复清单、接口、能力与配置错误。inspect 导入发生在独立进程；不要在守护进程里导入用户源码。
5. 实现异步 `install()`，返回 `EngineInstallResult`。读取 `self.install_context` 的系统、架构和目标目录。依赖只能装入 `target_dir`；Python 使用 `install_python_dependencies("官方包==版本")`，Node 使用 `install_node_dependencies("官方包@版本")`。Node 运行时未安装时应明确提示，或按官方校验下载到目标目录；不能假定应用提供 Node。不要写全局 Python site-packages。SDK 必须延迟 import，让 inspect/install 在尚未安装时也能运行。
6. `engine install <路径> --json` 等待成功。供应商优先复用 WorkStep 配置：按 `supported_provider_protocols()` 声明协议，运行时通过 `resolve_provider_runtime(provider_id=(config_overrides or {}).get("provider_id"), model=model)` 获取认证；也支持自定义供应商或引擎私有配置。密钥通过设置/受保护配置传入，禁止写进 py、清单、测试和聊天。`engine configure <路径> --config-file <本机私有JSON> --json` 支持 values/clear/confirmed/provider_id/model；用后删除临时凭据文件。
7. `engine validate <路径> --json`。要求真实联网连接、专属映射测试、生命周期与停止、事件到 AG-UI 转换、执行→下游→审核探测；所有声明的可选能力必须有 `tests/scenarios.json` 真实场景。失败必须修复重测，不改报告、不删测试、不通过关闭必要能力绕过。请告知用户真实探测会产生供应商调用费用。
8. 通过后 `engine register <路径> --json`，只有更新已存在引擎才使用 `--replace`。注册会验证报告签名与代码、依赖和配置指纹，原子发布到可写 runtime 目录，保留旧版。代码/依赖/配置变化后需要重新 validate。
9. 只有注册返回 ok=true 后，才提示在设置的引擎页面点击“重新扫描”；后台会重新发现自定义引擎，各处引擎选择列表随之更新，无需重启 WorkStep。引擎仍需完成配置与连接验证；若其它操作返回 restart_required=true，按该操作结果提示重启。

## 故障与分发

- install/validate 默认轮询长操作；`--no-wait` 返回 operation ID，可用 `engine operation <ID> --json` 查询，`engine stop <ID> --json` 停止。
- `engine export <引擎ID> --output <绝对ZIP路径> --json` 或设置页导出 ZIP。导出只包含清单显式列出的源码/测试/资源及安全测试摘要，排除 dependencies/cache/本机配置/密钥。接收者解压后按自己的系统重新 inspect/install/configure/validate/register，不直接复制已安装的依赖。
- `engine disable <ID>` 停用自定义运行，`engine enable <ID>` 恢复；这与“下拉显示”开关不同。`engine rollback <ID>` 回退旧版后重新验收注册。
- 不能正常启动时使用 `WORKSTEP_SKIP_CUSTOM_ENGINES=1` 启动，跳过全部自定义引擎。用户代码运行在子进程但拥有本机权限，进程隔离不等于文件/网络沙箱。
