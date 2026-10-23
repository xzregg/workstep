# 通知钩子

任务列表工具栏／移动菜单的「流程钩子」中选择「通知钩子」。触发钩子接收外部请求创建任务；通知钩子向接收平台发出流程事件。两类配置与存储独立，切换类型、关闭窗口都会保护未保存的修改。

## 配置与事件

每个流程最多保存 100 个通知目标。每个目标配置名称、平台、Webhook 地址、启用状态、订阅事件、标题前缀和任务链接地址类别。支持钉钉群机器人（可选加签）、企业微信群机器人、飞书群机器人、Lark 群机器人、通用 JSON Webhook；普通个人微信不在此范围。地址和签名密钥默认遮盖，配置管理、预览、投递记录、测试及重试均要求项目编辑权限。

飞书与 Lark 使用群内添加的「自定义机器人」，分别选择「飞书群机器人」或「Lark 群机器人」后粘贴完整地址：

- 飞书：`https://open.feishu.cn/open-apis/bot/v2/hook/<机器人令牌>`。
- Lark：`https://open.larksuite.com/open-apis/bot/v2/hook/<机器人令牌>`。

地址必须为所选区域的 HTTPS 地址。若机器人安全设置开启「签名校验」，填写该处的签名密钥；这里不使用企业自建应用的 App ID／App Secret，也不要求先配置渠道机器人。平台要求关键词时，应将关键词写入标题前缀或消息模板；IP 白名单使用实际发送设备的出口地址。这类通知目标只负责发送流程事件，双向对话通过「渠道机器人」另行配置。

默认订阅任务完成、任务失败。可选任务开始、完成、失败、暂停、停止，步骤完成、失败、等待确认。任务事件来自执行轮次生命周期，不把 `ready` 或取消排队当作完成；开始按执行轮次去重，暂停按发生次数保留。人工审核通过通知步骤完成，手动完成任务和终止任务分别通知完成和停止。等待确认包含人工审核与引擎的用户交互请求。消息回复结束、引擎 `done` 与跳过步骤不会误报步骤完成。

设备直接访问配置的 Webhook，网关不代发、不保存通知配置。发送消息不携带对话正文、产物内容或任务创建凭据。通用 JSON 包含 `event_id/event/notification_title/project/workflow/task/step/occurred_at/task_url`，`occurred_at` 保留 ISO 8601 UTC 时间供程序处理；钉钉和企业微信使用各自 Markdown 消息格式，飞书与 Lark 使用包含 `lark_md` 正文的消息卡片（`msg_type: interactive`）。默认正文独立展示中文事件名称，事件与时间整行加粗；时间转换为发送设备的本地时区，按秒显示并附 UTC 偏移，例如 `2026-10-11 08:13:10 (UTC+08:00)`。正文最多 3900 UTF-8 字节；飞书／Lark 另按 JSON 转义后的大小裁剪，为加签字段预留空间，保持请求正文低于平台 20 KB 限制。

任务链接按配置选择网关、外网或内网地址。网关链接使用已授权平台设备标识的 `/workspace/{device_id}/tasks` 路径，内外网使用 `/tasks`，都携带项目、流程、任务定位参数。不生成分享凭据，打开仍需正常授权；所选地址缺失或网关设备身份不可用时不附带链接。

## Markdown 模板

钉钉、企业微信、飞书和 Lark 目标可在「通知配置」中编辑独立的 Markdown 消息模板，点击变量列表复制后粘贴；「模拟通知」的生成预览显示替换变量后、受平台长度限制的实际正文。「恢复默认模板」确认后成为未保存修改，保存后生效。默认模板沿用事件和时间加粗、设备本地时区、可选步骤及任务链接。

| 变量 | 内容 |
| --- | --- |
| `{notification_title}` | 标题前缀与中文事件名称 |
| `{event_name}` / `{event}` | 中文事件名称 / 事件代码（测试为 `test`） |
| `{project_name}` / `{workflow_name}` / `{task_title}` | 项目、流程名称及任务标题 |
| `{step_line}` / `{step_name}` | “步骤：名称”整行 / 名称；无步骤时为空 |
| `{time}` / `{occurred_at}` | 本地时间（含 UTC 偏移）/ 原始 UTC 时间 |
| `{task_link}` / `{task_url}` | “查看任务”Markdown 链接 / 地址；关闭链接或缺少地址时为空 |

模板中的任务链接位置由占位符决定，删除占位符即可省略，不在模板外自动追加。模板最多 8000 个字符；纯空白及未知变量会阻止保存和预览，变量大小写必须与列表一致。不执行表达式，也不递归替换任务标题内的占位符；项目、流程、标题等变量按普通文本转义，模板本身保留用户编写的 Markdown。文字中的字面花括号可用反斜杠转义。

通用 JSON 目标继续发送结构化事件，无 Markdown 模板编辑。`markdown_template: null` 或缺少该字段表示使用默认模板；已有项目通过启动时增列保留原钩子数据。配置接口另返回 `default_markdown_template` 和 `template_variables`，供界面展示。已入队和重试通知使用发送时已保存的模板。

## 预览、测试和投递

「模拟通知」的生成预览只渲染内容，不访问目标。飞书／Lark 的请求预览不包含签名；正式发送时才以秒级时间戳和签名密钥生成 HMAC-SHA256 签名，加入请求正文的 `timestamp`／`sign` 字段。「发送测试通知」在确认后向已保存且启用的目标发送独立测试消息，不创建任务。未保存的地址修改不能用于测试或重试。

后台将已捕获的事件写入项目数据库 `notification_deliveries`，目标配置位于 `notification_hooks`。每个目标／事件标识唯一。异步采集沿用 EventBus，事件采集与任务状态事务分离；进程在采集落库之前退出可能漏报，不能声称严格事务一致或恰好一次投递。已落库的待投递记录可跨重启恢复；发送中记录使用有时限的领取标识，崩溃后到期可再次领取。

发送最多 4 路并发，HTTP 超时 10 秒、整体截止 12 秒，不跟随重定向。HTTP 2xx 对通用目标表示成功；钉钉和企业微信还必须返回业务 `errcode: 0`；飞书与 Lark 必须返回整数 `code: 0`，仅在缺少 `code` 时兼容旧字段 `StatusCode: 0`。网络、超时、HTTP 408／429／5xx 和可识别的平台临时错误（含飞书／Lark 限流 `11232`、系统繁忙 `-1`）最多自动重试 3 次，间隔 30／120／600 秒；签名、关键词等永久错误直接记为失败。原始响应、地址、签名和密钥不写入投递结果。

发送前重新核对流程是否删除、目标启用与事件订阅状态，并使用当前目标地址。等待并发名额后也执行此核对。停用、取消订阅或删除会跳过待发送记录；已经发出的请求无法撤回。删除目标同时删除其投递记录。失败记录可手动重试，保留总尝试次数并重新给予重试预算。超时和崩溃恢复可能重复投递，通用接收端可使用 `event_id` 去重。

投递记录按时间倒序，每页 50 条；展示事件、任务标题、状态、尝试次数和脱敏结果。记录存在待投递项时页面定时刷新，也可手动刷新。记录目前无自动保留期限。

## API 与维护入口

所有接口需 `project_id`，流程与目标归属在设备核验，网关共享协议只向项目编辑者开放这些明确的路径：

| 方法 | 路径（前缀 `/api/workflow/{workflow_id}/notification-hooks`） | 作用 |
| --- | --- | --- |
| GET／PUT | 空后缀 | 读取／批量保存目标 |
| POST | `/preview` | 草稿＋样例事件，返回消息快照及平台请求正文 |
| POST | `/{hook_id}/test` | 入队测试通知，202 返回投递 ID |
| GET | `/{hook_id}/deliveries?offset=0` | 投递记录 |
| POST | `/{hook_id}/deliveries/{delivery_id}/retry` | 重试失败记录，202 |

新增项目表通过现有模型注册与启动迁移创建。需要更新设备服务；通过网关管理时还需更新网关引用的共享协议权限表。既有触发钩子数据和公开调用路径不迁移。

行为测试：daemon `tests/test_notification_hooks.py`（真实 API、工作流成功／失败／暂停／停止／人工审核后台投递、多个目标、发送前配置变化、领取超时恢复及并发去重、手动重试、归属与保存事务、慢 SQL／网络健康 canary）；`test_notification_delivery.py`（模拟 HTTP 接收端、平台成功／业务错误／畸形响应、网络错误脱敏、重定向与重试分类）；`test_feishu_notification_hooks.py`（双区域地址、卡片模板、签名、业务错误及限流、持久化 API 和慢网络健康 canary）；`test_workflow_runtime.py`、`test_review_gate.py`；Web `tests/notificationHooks.test.tsx`（预览与发送确认、多目标保存及失败恢复、删除确认、记录分页和重试、飞书／Lark 配置与卡片正文预览）、`workflowHooks.test.tsx`；共享协议 `tests/test_hooks.py`。机器人投递测试使用模拟接收端，真实群机器人及设备外网连通性仍需实际环境联调。正式用户操作手册与真实演示截图在合并交付节点集中同步。

平台协议参考：[钉钉机器人接入](https://open.dingtalk.com/document/robots/custom-robot-access)、[钉钉安全设置](https://open.dingtalk.com/document/robots/customize-robot-security-settings)、[企业微信群机器人配置](https://developer.work.weixin.qq.com/document/path/91770)、[飞书自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)、[Lark 自定义机器人](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/bot-v3/use-custom-bots-in-a-group)。
