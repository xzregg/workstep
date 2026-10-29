# 官网原型的原有媒体组件

原型入口：`ui/DESIGN/landing-prototype.html`。此目录仅适配原型，不替换官网生产入口。

复用 `GuidedWalkthrough` 的真实录屏及章节控制、`DemoPlayer` 的画布／流式执行／并行分支动画。通过同源消息同步日夜主题、26 种语言和播放器高度。原型翻译来自官网词典及已翻译手册。中文采用新编排文案，其他语言复用现有官网内容。

在仓库根目录重新导出：

```sh
node apps/landing/prototypes/landing-media/build.mjs
```

生成 `ui/DESIGN/landing-prototype-media.html` 和 `landing-prototype-locales.js`。媒体内联用于独立评审，因此文件较大；不作为线上发布产物。当前依赖下的压缩器会将 Lucide 的 SVG 标签误编译为图标名，原型构建关闭 JS 压缩以保留可见按钮图标。

检查：官网 15 个测试文件、197 项测试通过；浏览器验证录屏播放／章节跳转、三组动画切换、语言与日夜主题同步，以及 320px／390px 无横向溢出。
