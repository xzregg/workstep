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
