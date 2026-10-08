# WorkStep 产品介绍页（apps/landing）

独立的 Vite + React 落地页，用于向独立开发者 / 小团队介绍 WorkStep。与产品 UI
（`apps/web`）解耦，视觉沿用仓库设计契约中的 token（蓝 `#0071e3`、灰阶、圆角、阴影），
并支持浅色 / 深色模式与中英切换。

## 开发命令

```bash
corepack yarn install --frozen-lockfile
corepack yarn dev        # http://localhost:5174
corepack yarn test       # vitest：i18n 键集一致性 + 时间轴工具
corepack yarn lint       # oxlint
corepack yarn build      # tsc -b + vite build，产物在 dist/
```

`corepack yarn build` 会把脚本、样式和品牌图标内联到 `dist/index.html`。构建完成后可直接双击
该文件离线预览，不需要本地服务器，也不会触发 `file://` 跨域限制。

生产模式下 Daemon 会托管官网与 Web 应用：`./start.sh 8765 prod` 会同时构建
`apps/landing`（→ `http://<host>:8765/landing`，构建时使用
`LANDING_BASE=/landing/` 使静态资源位于 `/landing` 子路径）与 `apps/web`
（→ `http://<host>:8765/`，保持 home 不变）。

## 页面结构

- 首屏 Hero：产品标语 + 自绘的产品窗口预览（画布 / KPI / 引擎状态）。
- 操作演示（Demos）：四个“视频感”演示卡片，用确定性时间轴动画重演真实界面；
  卡片自动循环播放，点击后在弹窗中放大，可播放 / 暂停 / 重播 / 拖动进度。
- 内置模板流程 + `steps.json` 示意。
- 顶部「下载」直接打开 GitHub 最新发布页。
- 「立即体验」：Daemon 内置 `/landing` 官网返回工作台 `/`；独立发布的官网通过 `workstep://open` 唤起桌面端。

## 常见自定义

- 下载链接：`src/config/downloads.ts` 使用 GitHub Releases 的稳定资产名；修改平台产物名时，必须同步更新 Electron Builder 配置和下载测试。
- 演示内容：新增演示时在 `src/demo/demos.tsx` 注册 `DemoDef`，在
  `src/scenes/` 下新增场景组件（纯函数 `{ time: number } => UI`），并同步补充
  `src/i18n/zh-CN.ts` 与 `src/i18n/en-US.ts` 文案。
- 文案：新增任何展示文案必须同时写入中英两本词典，键集合一致性由
  `tests/i18n.test.ts` 保证。

## 用户操作手册

顶部“文档”进入 `#docs`，章节链接为 `#docs/<chapter-id>`。内容位于 `src/manual/onboarding.ts`（SDK 优先入门）与 `features.ts`（功能操作），页面复用官网主题和导航，提供章节搜索、前后章及原图查看。第一版正文为中文，英文界面显示语言提示。

真实截图存于 `src/manual/screenshots/<screenshot-id>.jpg`，构建通过 Vite 导入，发布目录中的图片需与 HTML 一起保留。本地离线打开也需保留 `assets/` 图片目录。仅在 `dev` 合并到本地 `main` 并提交本批代码时，集中更新本批已验证功能的章节和截图，并运行 `yarn manual:check` 检查覆盖（缺图返回非零）、测试和构建；日常开发不逐功能触发。截图统一复用本机 `8777` 端口的“操作手册演示”项目，见 [演示环境](../../docs/manual-demo.md)。发布时复核已合并版本的手册。截图不得包含密钥、私人对话或内部地址。
