# WorkStep Web

WorkStep 的 React + TypeScript + Vite 前端，包含任务列表与详情、工作流画布、项目会话、助手和设置页面。它通过 `/api` 与 `/ws` 连接本地 daemon；前端 store 只消费对外的 AG-UI 事件。

## 开发

需要 Node.js 20 和 Yarn 1。开发时先启动 `apps/daemon`，再运行：

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

新增界面前请先阅读仓库根目录的 `AGENTS.md` 和 [`docs/frontend-design.md`](../../docs/frontend-design.md)。优先复用 `src/components/` 中的聊天、Markdown、确认框与引擎选择组件；移动端覆盖集中在 `src/mobile.css`。
