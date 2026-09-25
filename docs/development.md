# 开发指南

## 从功能找到代码

先看[功能代码地图](code-map.md)，再在职责所有者内查调用链和测试。页面负责组装，领域 API 放入 `apps/web/src/api/` 的对应模块；后端路由、服务、schema、模型分别放在 `apps/daemon/api/`、`services/`、`schemas/`、`models/`。`src/api/client.ts` 兼容已有导出，不作为新领域逻辑的默认入口。

文件超过 800 行、局部状态超过 15 个或 effect 超过 10 个提示检查职责，但不要求拆到固定行数以下。按独立行为和数据边界抽模块，让模块自己管理请求、校验、错误与关闭保护；不要只把 JSX 搬走，再从页面透传一组 state/setter。重复实现出现两次时优先复用现有组件或领域服务。

## 后端 I/O 与并发

`async def` 中的文件、目录、网络、数据库、同步 SDK 和子进程 I/O 都不能直接阻塞事件循环。优先原生异步 API；没有时把**完整同步工作单元**交给 `asyncio.to_thread` 或专用执行器，包括路径检查、文件打开/关闭、迭代、事务和序列化。Peewee 项目数据库工作单元统一用 `project_manager.run_db(project_id, operation)`；不要让惰性查询或数据库上下文跨越 `await`。子进程 stdout 使用 `engines/core/stream_lines.py` 分块读取。

修改 I/O 路径时写慢盘、慢 SQL、网络延迟或锁竞争回归，并在慢操作进行时测轻量协程或健康检查是否及时响应。静态搜索只能辅助定位，不能代替真实调用路径测试。详细约束见 [`AGENTS.md`](../AGENTS.md)。

## 前端控件与样式

优先用 `Button`、`Input`、`Select`、`Textarea`、`ChatInput`、`ConfirmDialog` 等共享组件，设计规则见[前端设计文档](frontend-design.md)。移动端普通可见控件统一为 32px，高点击区域和菜单项用 44px；使用 `src/mobile.css` 的 `--mobile-control-*` 变量，不在页面样式写一次性高度。消息操作按钮保持紧凑；图标按钮要有明确内边距。新增文案先写 `zh-CN.ts`，所有词典键集合保持一致且非空。

组件新增请求前检查页面、父级和 store 是否已有同一请求；合并重叠 effect 或复用去重的 store action。行为测试跟随拥有状态和请求的组件，页面测试组装。

## 环境与验证

```bash
cd apps/daemon
uv sync --dev
uv run --no-sync pytest
```

```bash
cd apps/web
corepack yarn install --frozen-lockfile
corepack yarn test
corepack yarn build
```

官网在 `apps/landing`，也使用 Yarn。仓库检查可运行 `python scripts/check_repository_health.py`。行为变更先写失败回归，再实现和验证；跨层变更还需运行相关 API、组件和端到端检查。不要提交构建产物、数据库、日志、密钥或个人配置。可选引擎 SDK 在设置中安装后，重启 daemon 用 `uv run --no-sync` 保留环境；只有需要恢复锁定依赖时运行 `uv sync --dev`。

外部贡献流程见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。
