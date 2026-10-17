# HTML 预览隔离

HTML、JS 和原型文件属于不可信内容。预览允许执行脚本，但不允许取得 WorkStep 页面、登录存储或通用 API 权限。普通预览、独立预览窗口和分享预览均不开放 `allow-same-origin`；客户端未获得新版资源票据时回退到禁止联网的隔离 srcdoc。

## 普通项目与远程项目

已认证的 `GET /api/fs/preview` 为 HTML 签发内存中的随机资源票据，响应禁止缓存。票据有效期一小时，最多保存 256 份；后台重启、到期或容量淘汰后需重新打开预览。

`/api/fs/html-resource/{project_ref}/{token}/{path}` 只提供 HTML 所在目录及其子目录中的网页资源，不提供目录列表、写接口、隐藏文件、数据库或私钥。路径解析拒绝目录外符号链接和路径穿越；单个资源上限 25 MiB。票据授予这个目录内的只读资源访问，因此 HTML 应与允许一起预览的资源放在独立目录，不应与私有 JSON 数据混放。

HTML 响应通过 CSP 响应头设置沙箱及资源范围：脚本、样式、图片、字体、媒体和 fetch/XHR 限定在对应票据路径；另允许固定静态 CDN（cdnjs、jsDelivr、esm.sh、unpkg、Bunny Fonts 与 Google Fonts）的脚本/样式/字体等资源，不向这些来源开放通用 fetch。表单联网提交、插件和 Worker 禁止。嵌套 srcdoc 保持父级沙箱与 CSP，不能放宽父级策略。JS 按钮、原型表单事件、动画、页内跳转、模块导入及相对 JSON 请求使用浏览器原生行为。

直接访问 raw/file/upload 内容也附带响应头沙箱；这些入口不提供票据目录资源和联网权限。下载地址保持不变，交互预览应使用工具栏的预览窗口入口。SVG 等可执行文件同样受到响应头保护。

远程项目复用真实路由分发和原有项目范围校验，转发 CSP、资源票据、CORS 和缓存响应头。客户端代理按照本机地址重建 CSP，不能留下远端内部地址。

## 网关会话

网关为已认证的 HTML preview 响应登记资源票据与原设备会话的关系，最多保存 1024 份、一小时到期。只有相同公网 authority、设备路径、项目引用和票据的资源 GET 能通过该关系恢复内部认证；身份凭证不写入 HTML、URL 或转发给宿主。每个资源请求仍执行原有会话、账号、设备及项目授权复查。撤销原设备会话后，资源读取也失效。

这使不透明来源的模块、字体及 JSON 加载不依赖浏览器发送 SameSite Cookie。资源专用的 CORS/OPTIONS 只支持 GET，不能作为管理 API 的跨域入口。网关按公网 origin 和 `/workspace/{device}/` 重建票据路径 CSP，不恢复整个系统的 `connect-src 'self'`，也不把资源 HTML 当成 SPA 入口注入 base 标签。旧设备子域入口沿用同样策略。

## 分享与兼容范围

分享继续使用原分享授权接口加载正文、下载文件，不签发项目目录票据。HTML 使用隔离 srcdoc，网络访问关闭。不会为相对资源扩大分享的目录或任务授权。已有内联原型及章节跳转保持可用。

沙箱不提供 WorkStep 的 localStorage、IndexedDB、Cookie 或桌面桥接；依赖这些系统能力的 HTML 需要改为原型内状态。任意外部 API 请求和非白名单网络资源也不在默认预览能力中。本方案保证隔离下的交互能力，不保证任意网页与完整浏览器环境完全等价。

## 验证入口

- Web：`artifactPreviewHtml.test.tsx`、`htmlPreviewCompat.test.ts`，以及原 Markdown、下载、分享与窗口尺寸测试。
- daemon：`test_html_preview_isolation.py`、`test_remote_file_preview.py`，以及原文件接口、桌面认证、分享和网关桥接回归。
- Gateway：`test_html_preview_access.py`、`test_data_http.py`、`test_user_devices.py`；协议范围在 `packages/gateway-protocol/tests/test_protocol.py`。
- `test_html_preview_isolation.py` 的 Chromium 用例通过 `WORKSTEP_PLAYWRIGHT_MODULE` 和 `WORKSTEP_CHROMIUM` 显式启用。需要 Node Playwright、Chromium，以及可导入 gateway 源码与依赖的 Python 环境；测试只启动回环地址的临时服务和临时数据库，不连接真实宿主或 LLM。
- 浏览器矩阵覆盖本地、远程、网关登录本地、网关登录远程；执行真实 Gateway 登录/兑换和 DataConnection、远程路由分发。设备网络传输使用内存 HTTP 桥；签名桥另由既有 `test_gateway_workspace_bridge.py` 覆盖。CDN 请求使用确定性夹具，不依赖公网。
- 每条链路回放 `provider-layout.html`、其嵌套预览包装、`desktop-sidebar.html`、`task-execution-analysis.html`，并检查按钮、弹框、消息输入和正常渲染；这不是对全部历史 HTML 的兼容承诺。
