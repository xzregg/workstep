# WorkStep Web

WorkStep 的 React + TypeScript + Vite 前端，包含任务列表与详情、工作流画布、项目会话、助手和设置页面。它通过 `/api` 与 `/ws` 连接本地 daemon；前端 store 只消费对外的 AG-UI 事件。

## 开发

需要 Node.js 24 LTS（Volta 固定 24.18.0）和 Yarn 1.22.22。开发时先启动 `apps/daemon`，再运行：

```bash
yarn install --frozen-lockfile
yarn dev
```

Vite 开发服务器会把 `/api` 和 `/ws` 代理到本地 daemon。仓库根目录的 `./start.sh` 也可以同时启动前后端。

## 验证

```bash
yarn test
yarn lint
yarn build
```

`yarn test` 最多并发运行 2 个测试文件，并关闭 Node 内置的只读 `navigator`，由测试的浏览器模拟环境提供该对象。直接运行 `node --test` 时也须显式指定 `--test-concurrency=2`；本机不要同时启动多组全量测试。

新增界面前请先阅读仓库根目录的 `AGENTS.md` 和 [`DESIGN.md`](../../DESIGN.md)。优先复用 `src/components/` 中的聊天、Markdown、确认框与引擎选择组件；移动端覆盖集中在 `src/mobile.css`。


## 运行诊断

从「设置 → 反馈问题」打开「运行诊断」。可查看页面异常、请求失败和录制期间的慢请求，或开始 15 秒性能录制并返回原页面复现。录制完成后可筛选消息处理、页面响应、资源和星图事件，并查看对应时段日志。可直接复制或导出完整的脱敏 JSON 报告。

使用 `rtk proxy yarn build:profile` 生成本地性能分析构建，产物在仓库根目录的 `tmp/runtime-diagnostics/profile-web/`。该构建在录制期间额外报告消息正文 React 子树的渲染耗时，用于排查频繁重渲染。
