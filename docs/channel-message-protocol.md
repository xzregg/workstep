# 渠道消息协议与接入开发

WorkStep 渠道消息协议 v1 是项目内部的收发契约。它采用与 LLM 引擎相同的适配器、能力声明和注册发现方式。ACP 负责 LLM 引擎交互，渠道协议负责平台机器人消息收发。

## 接口与职责

- `services/channels/base.py`：`ChannelAdapter` 基类、`IncomingMessage`、`OutgoingMessage`、`ChannelAttachment`、`ChannelCapabilities` 和协议版本。
- `registry.py::discover_channels`：发现 `services/channels/` 下声明唯一 `CHANNEL_ID` 的具体适配器；扫描和模块导入在机器人管理器的执行器中完成。
- 每个平台适配器只处理连接、鉴权、重连、平台消息转换、媒体上传/下载和平台发送。统一接口为 `start/stop/send/download`，`send_text` 是文本兼容包装。
- `BotManager`：机器人实例、项目/任务路由、去重、串行处理和会话映射。项目和任务继续复用现有助手运行时。
- `sender.py`：接收者解析、项目范围与状态校验，供 CLI 通知与完成回复推送复用。
- `media.py`：附件大小限制、项目范围校验、异步网络和文件 I/O、入站附件存储及出站 Markdown 附件提取。

## 消息结构

入站消息包含机器人 ID、平台消息 ID、私聊/群聊类型、会话 ID、用户 ID/显示名、文本和附件。附件使用统一 `image/file` 类型，平台下载代码、AES 密钥等仅保留在不可见的 `reference`，聊天记录只保存项目相对路径。

出站消息包含文本和附件。附件有文件名、MIME 类型、项目路径和临时字节数据；适配器上传后转换为平台的媒体消息。文本与附件可以同时存在，也可以只发送附件。

能力声明包含收/发类型、等待状态、正文流式更新支持、图片/文件大小上限和允许的文件扩展名；必须与实际实现一致。企业微信声明 `waiting/streaming`，钉钉不合成这两种状态。

## 流式回复

企业微信入站消息先发送空的等待气泡；项目渠道助手和任务协调助手收到 LLM 正文事件后，通过统一 `update_reply` 接口更新同一气泡。`reply_stream.py::ChannelReplyStream` 在独立异步任务中发送累计正文，首段立即发送，后续更新至少间隔 0.5 秒；等待平台回执时只保留最新快照，避免网络阻塞 LLM 事件消费或堆积发送队列。思考和工具事件不作为正文推送。

最终发送前取消并等待中间更新任务，成功、失败和停止都收尾；中间更新超时或失败后停止预览更新，最终发送仍重试并保留主动发送兜底。根据 [官方 SDK 的流式接口](https://github.com/WecomTeam/aibot-node-sdk#replystream-详细说明)，单气泡正文最多 20480 字节，预览按 UTF-8 边界限长，最终超长正文的剩余部分按 4096 字节主动消息分段发送，完整内容不丢失。图片和文件在完成后上传发送；只有附件的最终回复也会结束等待气泡。

此路径用于拥有入站回调 `req_id` 的回复；CLI 主动通知和 WorkStep 内发起的完成回复没有该回调，继续走主动发送。行为、慢网络健康检查及消息隔离见 `tests/test_channel_streaming.py`、`tests/test_channel_bots.py` 和 `tests/test_channel_chat_responder.py`。

## 图片、文件行为

- 两个平台接收文本、图片、文件及适配器支持的图文混排消息。验证项目绑定并去重后，下载附件到绑定项目 `.workstep/uploads/`，图片写入 Markdown 图片引用，文件写入普通链接。
- 图片继续由现有 `extract_uploaded_images` 转换为引擎图片输入，包括任务的独立工作目录。文件通过项目内路径供助手读取；是否能理解图片取决于所选引擎和模型的图片能力。
- CLI/API 原始通知不创建 LLM 轮次或聊天历史。LLM 完成回复中的 `.workstep/uploads/`、`.workstep/artifacts/` 图片/文件引用会转换成原生媒体发送，公网链接保留为文本。
- 项目外路径和指向项目外的符号链接拒绝发送；上传目录不能指向项目之外。下载仅允许平台 HTTPS 域名，每次重定向重新校验，读取按块限额并设置超时。
- 当前 WorkStep 限额：图片 2 MiB、文件 20 MiB，出站最多 10 个附件。所有附件先校验和上传，再发送正文与媒体；平台发送不是跨多条消息的事务，后续失败时不自动重发已发送部分。
- 钉钉原生文件模板目前声明 `xlsx/pdf/zip/rar/doc/docx`，其它扩展名明确拒绝。企业微信文件不附加此扩展名限制。平台权限、频率、服务端限额和租户配置仍可能拒绝发送。

## 官方接口依据

企业微信接收和解密依据 [官方 Python SDK](https://github.com/WecomTeam/wecom-aibot-python-sdk)。当前 Python SDK 没有媒体上传方法，`wecom_media.py` 通过公开的 `reply(frame, body, cmd)` 复用其连接和回执机制，移植 [官方 Node SDK](https://github.com/WecomTeam/aibot-node-sdk) 的 `aibot_upload_media_init/chunk/finish` 协议（512 KiB 分片），上传后通过 `aibot_send_msg` 发送 `image/file`。

钉钉接收格式依据 [机器人接收消息](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/receive/)，下载采用 [机器人文件下载 API](https://open.dingtalk.com/document/orgapp/download-the-file-content-of-the-robot-receiving-message)。上传使用 `oapi.dingtalk.com/media/upload`；主动发送使用既有群聊/单聊 API，以 [官方消息模板](https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots) 的 `sampleImageMsg/sampleFile` 携带媒体标识。所有 HTTP I/O 使用异步客户端。

## 新增渠道

1. 新建一个平台模块或包，继承 `ChannelAdapter`，声明唯一 `CHANNEL_ID`、`DISPLAY_NAME` 和真实 `CAPABILITIES`。
2. 使用 `(bot, on_message, on_state)` 初始化，连接回调转换为 `IncomingMessage`；不向路由或助手传递平台专有字段。
3. 实现 `send` 和附件 `download`，发送前调用 `validate_outgoing`，不复制项目绑定、会话、助手或 CLI 流程。
4. 补平台帧、媒体上传/下载、失败、收件人隔离和慢网络健康检查测试。适配器会自动发现；设置界面的平台选择与凭证表单按需增加。

测试入口：`test_channel_protocol.py`、`test_channel_bot_adapters.py`、`test_channel_send.py`、`test_channel_media_cli.py`；原有会话/路由回归见 `test_channel_bots.py`、`test_channel_reply_forwarder.py`、`test_channel_chat_responder.py`。


入站会话来源统一通过 `IncomingMessage.conversation_name`（可选群名称）、`conversation_id`、`conversation_type`、`sender_id/sender_name` 表示。没有群名时不假造平台名称，使用可重命名的渠道对话标题。名称仅用于显示和背景，路由始终使用机器人与平台会话 ID。
