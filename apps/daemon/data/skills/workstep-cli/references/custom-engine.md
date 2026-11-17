# 自定义引擎接入流程

适用于创建、更新和导入 CLI／ACP／SDK／Agent 引擎，使用普通项目聊天，不创建专用助手。

| 文档 | 负责内容 |
| --- | --- |
| 本页 | 准备包、CLI 操作、注册与分发 |
| [接口契约](custom-engine-contract.md) | 适配器、权限、事件、MCP 与连接生命周期 |
| [测试规范](custom-engine-testing.md) | 必测场景、公共验收覆盖范围与通过证据 |

## 准备与实现

1. 确认名称、唯一小写 ID、官方 SDK/CLI 文档、认证方式、目标系统和所需能力。先查已有引擎；更新时检查旧包，导入时沿用已有包，不重新创建适配器。
2. 在返回的共享 Runtime 工作目录下建立具名包目录，避免覆盖其他成果。按接口契约准备 `manifest.json`、Python 入口和 `tests/test_*.py`；先写行为测试，再实现适配。未经注册的源码不直接放入正式 `runtime/engines`。
3. 按[连接生命周期](custom-engine-contract.md#连接生命周期)区分一次性调用、同会话复用与跨会话共享，只声明已落实的能力；具体测试见测试规范，不在提示词或本页重复维护清单。

## CLI 操作

先按 [Transport](transport.md) 选择可用传输。以下 `workstep` 是简写，可替换为文档中的 `uv … python -m cli` 或桌面内置 Python；路径使用包目录或 Python 入口的绝对路径。

```bash
workstep engine list --verbose --json
workstep engine inspect /absolute/adapter --json
workstep engine install /absolute/adapter --json
workstep engine configure /absolute/adapter --config-file /private/engine-config.json --json
workstep engine validate /absolute/adapter --json
workstep engine register /absolute/adapter --json
```

| 操作 | 完成条件 |
| --- | --- |
| inspect | 清单、接口、能力与配置检查通过；用户源码只在隔离 worker 导入 |
| install | 依赖安装成功；SDK 延迟 import，未安装时仍能 inspect/install |
| configure | 保存认证、供应商与模型；优先复用 WorkStep 供应商配置 |
| validate | 按测试规范完成真实探测和专属测试，报告 `ok=true` |
| register | 报告签名及代码、依赖、配置指纹匹配，返回 `ok=true` |

依赖安装到引擎自己的目标目录：Python 用 `install_python_dependencies("官方包==版本")`，Node 用 `install_node_dependencies("官方包@版本")`。不要修改 WorkStep 的 Python 环境；不能假定桌面端已安装 Node。认证通过设置或私有配置文件传入，`--config-file` 支持 `values/clear/confirmed/provider_id/model`；临时凭据文件用后删除，不写入源码、包或聊天。

真实 validate 会产生供应商调用，执行前说明所需认证与调用成本。失败后修复再测，不编辑报告、删除测试或关闭所需能力绕过验收。代码、依赖或配置改变后重新 validate；仅在用户已明确更新现有引擎时给 register 加 `--replace`。

注册成功后在设置的引擎页面点击“重新扫描”，无需重启；其他操作返回 `restart_required=true` 时按返回值处理。

## 长操作、回退与分发

- install/validate 默认等待结束；加 `--no-wait` 返回操作 ID，用 `engine operation <ID> --json` 查询、`engine stop <ID> --json` 停止。排队或启动成功不等于验收通过。
- `engine export <ID> --output <绝对ZIP路径> --json` 只导出清单声明的源码、测试、资源和安全摘要，不含依赖、缓存、凭据及本机验收报告。接收者在自己的系统重新执行上述流程。
- `engine disable <ID>` 停用执行，`engine enable <ID>` 恢复；显示开关只影响选择列表。`engine rollback <ID>` 回退旧版，后续动作以返回结果为准。
- 启动故障可设置 `WORKSTEP_SKIP_CUSTOM_ENGINES=1` 跳过自定义引擎。worker 隔离不提供文件或网络沙箱，用户代码仍有宿主权限。
