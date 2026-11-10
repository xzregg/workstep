# WorkStep iOS

WorkStep 的 iPhone / iPad 客户端，使用 Swift、UIKit 和 WKWebView 加载现有移动端网页。任务和引擎仍运行在用户连接的电脑或服务器上。

## 当前状态

已建立 `WorkStep.xcodeproj`、原生外壳、共享网页桥接和核心行为检查。2026-11-10 使用 Xcode 27.2（27B52）及 iOS 27.2 SDK 完成模拟器版、未签名 iPhone 设备版和界面测试目标编译。**尚未完成真机验收，也没有生成签名可安装 IPA。** 以下“已接入”不代表已经过真机验证。

在 iPhone 18 Pro / iOS 27.2 模拟器完成两项 XCTest 界面测试（零失败）：空地址禁用与非法地址提示；连接回环测试服务、WKWebView 加载、悬浮导航开关、长按菜单、日志页打开和返回。模拟器首次运行发现的旧窗口生命周期启动崩溃已修复，窗口及前后台恢复现由 `SceneDelegate` 管理。测试使用独立假数据服务，不涉及真实项目。结果保存在本机 `build/SimulatorTests-Final.xcresult`，不纳入源码。

本机构建产物：`DerivedData/Build/Products/Debug-iphonesimulator/WorkStep.app`（模拟器），`DerivedData-device/Build/Products/Debug-iphoneos/WorkStep.app`（未签名设备版）；两者都不是可直接分发安装的 IPA。

## 与 Android 的功能对照

| 功能 | iOS 实现与状态 |
| --- | --- |
| 服务地址 | 已接入 HTTP/HTTPS 根地址校验、异步 `/api/health` 验证和本机保存；拒绝健康检查重定向 |
| 会话、任务、流程 | 复用现有网页和接口；需部署本分支的 Web 构建以启用 iOS 桥接 |
| 登录与 Cookie | 使用持久 WKWebsiteDataStore；同源页面、指定企业授权页和已校验回调的 HTTPS 网关登录链保留在应用内 |
| 详情恢复 | 按服务记忆最近会话或任务详情，包含网关工作区；不记忆授权页和设备门户 |
| 悬浮导航 | 轻点开关网页导航，长按连接菜单，可拖动并保存相对位置；提供辅助功能菜单入口 |
| 连接菜单 | 修改地址、重新加载、清缓存、返回设备列表、日志和测试通知 |
| 缓存清理 | 仅清理 WKWebView 磁盘和内存缓存，保留 Cookie、网页本地存储及服务配置 |
| 图片与附件上传 | 使用 WKWebView 自带文件选择器；图片、文件选择行为待真机验证 |
| 文件下载 | 使用 WKDownload 和系统文件导出界面；同源下载及 Blob，拒绝跨源重定向；一次保存一个文件 |
| 麦克风 | 仅配置服务同源主页面的 HTTPS 音频请求可申请系统权限；拒绝摄像头；授权返回后复核页面和前台状态 |
| 前后台恢复 | 返回时触发现有 `workstep:resume`；离开至少五分钟后重新加载；上传、下载选择器不触发主动刷新 |
| 页面错误 | 加载失败、180 秒超时、根节点未渲染时提供恢复入口；网页进程退出后自动恢复一次 |
| 诊断 | 最近 30 条固定事件与数值错误码，本地时区展示、复制和清除；记录脚本错误类别及 CSP 类别，不保存正文、完整 URL 或认证参数 |
| 前台完成通知 | 原生通知权限、标题截断、按服务持久去重、当前详情抑制、点击回到会话/任务；复用设备范围路由 |
| 后台完成通知 | **未实现**。不启动虚假的后台保活，不消费 `watch/project/unwatch` 去模拟安卓前台服务；需要后续 APNs 服务端及签名能力接入 |
| 安装包自更新 | **不提供 APK 式自安装**；iOS 更新使用所选签名分发渠道 |
| 崩溃堆栈 | 当前仅网页进程退出和受控错误日志；完整原生崩溃报告仍通过 Xcode / 系统诊断获取 |

前台通知不是后台推送；应用被挂起后不会继续接收 WebSocket 结果。返回前台时由现有网页连接恢复逻辑补回当前会话内容，不保证补发后台期间的系统通知。

## 打开与构建

最低部署版本为 iOS 16。建议使用 Xcode 16 或更新版本，直接打开：

```bash
open apps/ios/WorkStep.xcodeproj
```

选择 `WorkStep` scheme 和模拟器。真机运行时，在 Signing & Capabilities 中配置自己的 Team 与可用 Bundle Identifier；默认标识为 `com.workstep.ios`。不得提交签名私钥、描述文件、账号凭据或个人 Xcode 状态。

在本目录执行模拟器构建（需要完整 Xcode）：

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project WorkStep.xcodeproj -scheme WorkStep \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build
```

界面测试需要实际可用的模拟器名称或 ID，例如：

```bash
xcodebuild -project WorkStep.xcodeproj -scheme WorkStep \
  -destination 'platform=iOS Simulator,id=<SIMULATOR-UDID>' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO test
```

归档及 IPA 导出通过 Xcode 的 Product → Archive → Distribute App，按自己的开发者账号选择分发方式；当前仓库不含证书，也不自动上传或发布。

工程已提交，无需额外安装工程生成器。新增 Swift 文件或更改工程构建设置时，在本目录执行 `python3 scripts/generate-project.py` 并提交生成结果；配置权威入口为该脚本。iOS 初始版本为 `0.1.0`、构建号为 `1`，不修改桌面端和 daemon 的统一版本。

## 服务与权限

- 手机必须能访问服务地址，网页、`/api`、`/ws` 应使用同一来源。仅监听电脑 `127.0.0.1` 的 daemon 无法直接被手机连接。
- iOS 首次连接局域网可能要求系统权限；拒绝后到系统设置允许 WorkStep 访问局域网。
- 为兼容用户自建 HTTP 服务，Info.plist 明确允许 HTTP 网络请求；HTTPS 仍沿用系统证书验证，不绕过证书错误。语音输入要求 HTTPS。
- 普通外部 HTTP/HTTPS 链接由系统浏览器打开；外部授权页没有 WorkStep 原生桥接权限。
- iOS 使用 `window.WorkStepIOS`，不伪装为 Android。共享通知传输保持原 APK 协议，iOS 保留网页移动端悬浮导航，浏览器推送入口仍由原生标识隐藏。

## 检查与验收

不依赖完整 Xcode 的检查（macOS Command Line Tools、Python 3、Node.js）：

```bash
sh scripts/check.sh
```

它编译并运行 Foundation 核心行为检查，覆盖地址与同源、登录授权链、页面记忆、恢复规则、通知目标与去重、健康接口成功/失败/超限/重定向；另外运行 JavaScript 桥接隔离及工程资源检查，并解析 Swift 语法和 plist。**语法解析不等同于 UIKit/WebKit 类型检查或 iOS 编译。**

Web 行为入口为 `apps/web/tests/iosNotifications.test.ts`、`completionNotifications.test.ts`；既有网关回归为 `apps/gateway-web/tests/android-notifications.test.tsx`。Xcode 界面测试入口为 `WorkStepUITests/WorkStepUITests.swift`。

待进一步模拟器 / 真机验收：

- iPhone 窄屏、横屏、iPad、安全区、动态字体、键盘和悬浮按钮触控。
- HTTP 局域网、HTTPS、无效证书、断网重试及局域网权限拒绝/恢复。
- 直连和网关登录、取消、认证回跳、重启后的详情恢复。
- 照片/文件上传、Blob/普通文件导出、取消选择后页面保持。
- 麦克风首次允许/拒绝、授权期间切换页面、录音结束和再次录音。
- 前台通知、去重、通知点击、网关跨设备目标及五分钟返回恢复。
- 测试签名安装、归档导出；APNs 作为后续独立开发项。

当前不登记为官网操作手册已交付功能，也没有用模拟效果图替代真实截图。
