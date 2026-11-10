# WorkStep iOS

WorkStep 的 iPhone 客户端，目录名为 `apps/ios`，应用显示名称为 **WorkStep**，计划中的 Xcode 工程名为 `WorkStep`。

## 当前状态

目前仅建立项目目录与实现范围，尚未创建 Xcode 工程或可安装的 IPA 包。

## 实现方向

使用 Swift 和 WKWebView 构建原生外壳，加载现有 WorkStep 移动端网页，复用 `apps/web` 和现有后端接口。任务与引擎仍在电脑或服务器上执行，iPhone 负责连接和操作。

首版计划包含：

- 配置、校验和保存 WorkStep 服务地址。
- 网页登录、会话聊天、流程和任务查看。
- 文件与图片选择、文件保存、麦克风权限适配。
- 页面恢复、断网重试和返回前台后的连接恢复。

以上均为待实现范围，不代表当前已支持。

## 后续工程结构

创建 Xcode 工程时使用以下命名：

```text
apps/ios/
  WorkStep.xcodeproj/   # Xcode 工程
  WorkStep/            # 应用源码、资源及配置
  WorkStepTests/       # 单元与行为测试
  WorkStepUITests/     # 界面测试
  README.md
```

## 安装与通知

真机开发需要 macOS、Xcode 和相应签名配置；IPA 分发需按所选方式配置开发者账户、证书和描述文件。不得将签名私钥、账户凭据或本机签名配置提交到仓库。

iOS 后台通知单独规划：不能直接复用 Android 前台服务常驻连接的机制，后续通过苹果推送服务接入任务完成提醒。首版不承诺锁屏或切后台后的即时通知。
