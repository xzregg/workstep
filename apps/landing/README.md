# WorkStep 产品介绍页（apps/landing）

独立的 Vite + React 落地页，用于向独立开发者 / 小团队介绍 WorkStep。与产品 UI
（`apps/web`）解耦，视觉沿用仓库设计契约中的 token（蓝 `#0071e3`、灰阶、圆角、阴影），
并支持浅色 / 深色模式与中英切换。

## 开发命令

```bash
yarn install
yarn dev        # http://localhost:5174
yarn test       # vitest：i18n 键集一致性 + 时间轴工具
yarn lint       # oxlint
yarn build      # tsc -b + vite build，产物在 dist/
```

## 页面结构

- 首屏 Hero：产品标语 + 自绘的产品窗口预览（画布 / KPI / 引擎状态）。
- 操作演示（Demos）：四个“视频感”演示卡片，用确定性时间轴动画重演真实界面；
  卡片自动循环播放，点击后在弹窗中放大，可播放 / 暂停 / 重播 / 拖动进度。
- 内置模板流程 + `steps.json` 示意。
- 下载区：平台选择弹窗 + 从源码运行指引。

## 常见自定义

- 下载链接：编辑 `src/config/downloads.ts` 中 `PLATFORM_DOWNLOADS` 的 `url` 字段；
  留空时按钮显示「即将开放」。
- 演示内容：新增演示时在 `src/demo/demos.tsx` 注册 `DemoDef`，在
  `src/scenes/` 下新增场景组件（纯函数 `{ time: number } => UI`），并同步补充
  `src/i18n/zh-CN.ts` 与 `src/i18n/en-US.ts` 文案。
- 文案：新增任何展示文案必须同时写入中英两本词典，键集合一致性由
  `tests/i18n.test.ts` 保证。
