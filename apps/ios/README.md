# WorkStep iOS

WorkStep 的 iPhone / iPad 客户端，使用 Swift、UIKit 和 WKWebView 加载现有移动端网页。任务和引擎仍运行在用户连接的电脑或服务器上。

## 当前状态

已建立 `WorkStep.xcodeproj`、原生外壳、共享网页桥接和核心行为检查。2026-11-10 使用 Xcode 27.2（27B52）及 iOS 27.2 SDK 完成模拟器版、未签名 iPhone 设备版和界面测试目标编译。**尚未完成真机验收，也没有生成签名可安装 IPA。** 以下“已接入”不代表已经过真机验证。

在 iPhone 18 Pro / iOS 27.2 模拟器完成原有两项 XCTest 界面测试（零失败）：空地址禁用与非法地址提示；连接回环测试服务、WKWebView 加载、悬浮导航开关、长按菜单、日志页打开和返回。本次新增的“新增地址 → 切换连接 → 删除当前地址”界面测试也已通过。模拟器首次运行发现的旧窗口生命周期启动崩溃已修复，窗口及前后台恢复现由 `SceneDelegate` 管理。测试使用独立假数据服务，不涉及真实项目。结果保存在本机 `DerivedData/Logs/Test/`，不纳入源码。

本机构建产物：`DerivedData/Build/Products/Debug-iphonesimulator/WorkStep.app`（模拟器），`DerivedData-device/Build/Products/Debug-iphoneos/WorkStep.app`（未签名设备版）；两者都不是可直接分发安装的 IPA。

## 与 Android 的功能对照

| 功能 | iOS 实现与状态 |
| --- | --- |
| 服务地址 | 已接入 HTTP/HTTPS 根地址校验、异步 `/api/health` 验证和本机保存；拒绝健康检查重定向；可保存多个地址、新增、选择切换和删除 |
| 会话、任务、流程 | 复用现有网页和接口；需部署本分支的 Web 构建以启用 iOS 桥接 |
| 登录与 Cookie | 使用持久 WKWebsiteDataStore；同源页面、指定企业授权页和已校验回调的 HTTPS 网关登录链保留在应用内 |
| 详情恢复 | 按服务记忆最近会话或任务详情，包含网关工作区；不记忆授权页和设备门户 |
| 悬浮导航 | 轻点开关网页导航，长按连接菜单，可拖动并保存相对位置；提供辅助功能菜单入口 |
| 连接菜单 | 修改地址、重新加载、清缓存、返回设备列表、日志和测试通知 |
| 缓存清理 | 仅清理 WKWebView 磁盘和内存缓存，保留 Cookie、网页本地存储及服务配置 |
| 图片与附件上传 | 使用 WKWebView 自带文件选择器；图片、文件选择行为待真机验证 |
| 文件下载 | 使用 WKDownload 和系统文件导出界面；同源下载及 Blob，拒绝跨源重定向；一次保存一个文件 |
| 摄像头／麦克风 | 分别申请系统摄像头和录音权限，仅配置服务的同源主页面可请求；HTTPS 或本机回环地址，带声音视频采集依次申请相机及麦克风且全部允许后才授权；授权返回后复核页面、WebView、服务、前后台与导航代次 |
| 系统文字转语音 | `WorkStepSpeech` 同源主框架桥接调用 `AVSpeechSynthesizer`；中文音色、语速／音量、逐句回执、按请求停止；后台／导航／切换服务停止 |
| 前后台恢复 | 返回时触发现有 `workstep:resume`；离开至少五分钟后重新加载；上传、下载选择器不触发主动刷新 |
| 页面错误 | 加载失败、180 秒超时、根节点未渲染时提供恢复入口；网页进程退出后自动恢复一次 |
| 诊断 | 最近 30 条固定事件与数值错误码，本地时区展示、复制和清除；记录脚本错误类别及 CSP 类别，不保存正文、完整 URL 或认证参数 |
| 前台完成通知 | 原生通知权限、标题截断、按服务持久去重、当前详情抑制、点击回到会话/任务；复用设备范围路由 |
| 后台完成通知 | **未实现**。不启动虚假的后台保活，不消费 `watch/project/unwatch` 去模拟安卓前台服务；需要后续 APNs 服务端及签名能力接入 |
| 安装包自更新 | **不提供 APK 式自安装**；iOS 更新使用所选签名分发渠道 |
| 崩溃堆栈 | 当前仅网页进程退出和受控错误日志；完整原生崩溃报告仍通过 Xcode / 系统诊断获取 |

前台通知不是后台推送；应用被挂起后不会继续接收 WebSocket 结果。返回前台时由现有网页连接恢复逻辑补回当前会话内容，不保证补发后台期间的系统通知。

长按悬浮按钮选择“修改服务地址”可管理地址。输入地址后点“新增地址”只保存，不立即切换；选中列表项后点“切换到所选地址”会先验证健康接口再连接，也可以直接输入并点“连接”。“删除所选地址”会移除列表项；删除当前地址会断开网页并清除启动地址。旧版保存的单个服务地址会自动进入列表。

## P2P 设备

连接页顶部切换「网关地址 / P2P 设备」。P2P 页可扫码或在输入框粘贴完整的 `/p2p/<设备>/#pair_key=...` 链接；扫描后保存并连接，手动输入先保存，再从设备列表切换。已保存设备可以再次切换或删除，重新扫描同一设备会更新配对密钥。设备列表不显示配对密钥，密钥存于 iOS Keychain；轮换密钥后需重新扫码或粘贴。扫码只在打开扫描页时申请相机权限。P2P 入口不进行网关根地址的 `/api/health` 检查。

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

工程已提交，无需额外安装工程生成器。新增 Swift 文件或更改工程构建设置时，在本目录执行 `python3 scripts/generate-project.py` 并提交生成结果；配置权威入口为该脚本。iOS 当前版本为 `0.1.1`、构建号为 `2`，不修改桌面端和 daemon 的统一版本。

## 服务与权限

- 手机必须能访问服务地址，网页、`/api`、`/ws` 应使用同一来源。仅监听电脑 `127.0.0.1` 的 daemon 无法直接被手机连接。
- iOS 首次连接局域网可能要求系统权限；拒绝后到系统设置允许 WorkStep 访问局域网。
- 为兼容用户自建 HTTP 服务，Info.plist 明确允许 HTTP 网络请求；HTTPS 仍沿用系统证书验证，不绕过证书错误。摄像头与语音输入要求 HTTPS（本机回环地址除外），局域网 HTTP 不能通过系统授权绕过 WebKit 安全上下文要求。
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
- 摄像头与麦克风首次允许/拒绝、授权期间切换页面或服务／进入后台、采集结束和再次采集。
- 摄像头预览／切换前后摄像头、发送时附加一帧；系统相册／拍照附件上传和取消。
- 系统中文朗读、语速／音量、分句完成回执、停止、进入后台停止及朗读和录音交错。
- 前台通知、去重、通知点击、网关跨设备目标及五分钟返回恢复。
- 测试签名安装、归档导出；APNs 作为后续独立开发项。

当前不登记为官网操作手册已交付功能，也没有用模拟效果图替代真实截图。

## 摄像头、录音与系统朗读对齐（2026-11-13）

`BrowserViewController` 对摄像头／麦克风分别申请 iOS 权限；拒绝后可在系统设置 → WorkStep 中重新允许。只在主动开启采集时申请，不在启动时预申请。网页识别继续使用已配置的 WorkStep 服务，不接入 Apple 本机语音识别。图片附件保留 WKWebView 系统选择器的照片／拍照入口；模拟器没有真实相机不能替代手机验收。

系统朗读使用 iPhone／iPad 自身的 `AVSpeechSynthesizer`，网页通过与 Android 共用的 `WorkStepSpeech` 请求／回执协议逐句播放；采用系统独立语音会话，避免替换 WebKit 的录音会话。它不需要麦克风授权。原生桥接、摄像头授权逻辑和权限说明需要更新 iOS 应用，仅更新服务器网页不能补齐旧客户端。此批不生成签名 IPA，不表示已完成真机录音、拍照或扬声器验收。

本批验证：核心行为检查、JavaScript 桥接／工程资源检查、Web 两端原生朗读协议回归通过；Xcode 27.2 的模拟器与未签名 iPhone 设备版编译通过。构建日志和产物位于仓库 `tmp/ios-media/`；未运行手机实机采集和出声验收。

带声音视频采集与单独相机／录音共用系统相机和麦克风权限，没有独立录像授权项。两次系统申请之间复核页面、服务和前后台状态；任一拒绝或上下文改变均拒绝网页请求。只在用户触发采集时申请，需安装更新后的 iOS 应用；网页 Permissions-Policy 禁止采集时不会进入系统授权回调，仍需更新对应后台。此处补齐采集授权，不新增独立录像界面。

## 应用图标

AppIcon 资产目录中的 `AppIcon.png` 沿用网站标识，使用与桌面包相同的带箭头图形和中央 80% 留白，并铺为不透明白底；iOS 由系统施加圆角，不在图中预裁圆角。资源随源码提交，Xcode 的 `ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon` 直接编译这张 1024px RGB PNG。

更新网站 `apps/web/public/favicon.svg` 后，安装桌面端开发依赖，在仓库根目录按顺序执行：

```bash
rtk proxy node apps/desktop/scripts/generate-icons.cjs
rtk proxy node apps/desktop/scripts/check-icons.cjs
rtk proxy swift apps/ios/scripts/prepare-icon.swift
rtk proxy swift apps/ios/scripts/prepare-icon.swift --check
```

`prepare-icon.swift` 默认读取桌面生成的 1024px PNG，仍支持显式输入、输出路径；`--check` 仅验证，不改写资源。Xcode 构建不依赖 Node 或 Electron。回归由 `tests/project.test.mjs` 验证资产尺寸、不透明度及生成结果一致性；安装后的系统遮罩效果需在模拟器或设备主屏检查。
