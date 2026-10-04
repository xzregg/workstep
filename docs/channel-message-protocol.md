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

## 任务阶段消息广播

任务绑定群后，`task_forwarder.py::ChannelTaskForwarder` 订阅该任务的 `TEXT_MESSAGE_START/CHUNK/CONTENT/END`，向所有仍有效且启用的 BOT 群绑定转发可见助手正文。首行是普通文本 `@阶段名称`，协调助手为 `@协调`，审核为 `@阶段名称 · 审核`；开始、结束分别显示执行中和完成／停止／失败状态，不发送用户输入、思考、工具日志或提示词。

阶段标题复用 `WorkflowDefinition` 的标准编译结果：画布节点的 `type/key` 用于关联执行阶段，`title/label` 才是显示名称；兼容旧 `steps[].name`，不把阶段 key 当作标题。

钉钉以标准 Markdown 卡片承载回复，首次创建后通过同一 `outTrackId` 持续更新累计正文，任务转发更新间隔至少 0.5 秒，结束时更新完整结果；卡片失败后回退发送完整文本。企业微信自动阶段没有入站 `req_id`，无法使用被动流式回复，等待结束后主动发送完整结果，不按正文片段发送新消息。图片和文件通过统一消息层发送一次（超出平台单条容量的正文仍按平台限制拆分）。群内发起的协调回复登记原始入站上下文，由此模块独占正文发送，企业微信继续更新原流式气泡（首段立即、后续至少间隔 0.5 秒），原任务路由继续处理提案和交互卡片。各消息、各群独立异步发送，配置与数据库读取均异步隔离；不支持更新或预览失败后只等待结束，不随正文片段重新读取配置；每次发送检查最新绑定，重复事件去重，同消息 ID 的显式阶段重试开启新一轮转发。预览发送失败后关闭预览，结束时仍尝试发送完整结果；最终失败发布 `channel_bots.reply_error`。启动后仅消费实时事件，不补发历史。

测试见 `tests/test_channel_task_forwarder.py`：阶段切换、并行消息、群隔离、绑定变更、原入站去重与按钮确认、慢 SQL／网络配合真实健康检查、阶段重试、最终正文读取及附件转发。

## 任务渠道来源提示词

群内发给任务协调助手的消息以原文持久化，可信渠道背景由 `source_prompt.py` 白名单提取并单独保存到该用户消息的 `prompt_json.channel_source`，包含平台、BOT、群／私聊、消息及发送者标识与显示名称，不含凭证。协调轮次从对应用户消息读取快照，独立传入引擎系统提示词，排队和重启不读取其他群的最新来源；网页用户接续时显式更新来源为 WorkStep。无独立指令入口的引擎按既有策略仅在实际模型输入中降级注入，不把背景写回用户正文。

测试见 `tests/test_channel_coordinator_source.py`：系统提示词／正文降级、同会话换群、队列恢复、来源白名单、网页来源切换，以及后台慢 SQL 与真实健康检查。

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


## 按钮卡片与交互回调

统一层新增 `ChannelButton(key, label)`、`ChannelCard(id, title, text, buttons, running)` 和 `ChannelAction(bot_id, card_id, key, sender_id, conversation_id)`；`ChannelCapabilities.cards` 声明平台按钮能力，适配器实现 `send_card`、`update_card` 并通过 `set_action_handler` 注册独立回调。回调不进入普通消息的串行锁。

`services/channels/controls.py::ChannelControls` 持有卡片与消息、项目、任务／会话、协调轮次及交互请求的对应关系，保存在全局配置 `channel_button_actions`，不含凭证与附件。停止及阻塞交互只在对应原始轮次仍活跃时有效；提案及普通选择题可在回复结束后点击，提案经过现有状态版本检查。机器人、发起用户、会话和最新绑定必须匹配；重复点击去重。用户发起的回复、确认和权限卡片仅发起者可点击。自动任务阶段和审核广播不发送中止卡片。

- **中止**：仅为渠道收到用户消息后触发的本条回复发送，协调任务复用 `CoordinatorModule.stop_current(expected_message_id=...)`，项目对话复用 `ChatSessionResponder.stop` → 原聊天模块 `stop_current`。按钮只能针对原回复，不能停止随后创建的回复。
- **提案确认／取消**：`CUSTOM workstep.action_proposal` 复用 `confirm_action`／`cancel_action`，维持原任务版本校验和执行幂等。
- **阻塞问题／权限**：`CUSTOM workstep.interaction_request` 直接向 `intervention_manager` 的原轮次交付标准 ACP outcome／elicitation response，继续原引擎。支持权限选项及单字段枚举／布尔选择；多字段和自由输入表单提示用户在 WorkStep 回答，并提供取消按钮。
- **普通选择题**：`CUSTOM workstep.async_question` 的选项作为带问题标题的用户消息回到原群／私聊和原协调助手。协调助手响应 JSON 可包含 `questions: [{title, options: [string]}]`，在通用事件日志与 WebSocket 中同步发布，任务详情也显示相同选项。较长选项列表拆分卡片，选择后其余分页失效。

任务转发器仅在 `_origins` 登记的原渠道会话为用户发起的协调回复确保中止卡片存在，与接收入口按助手消息 ID 去重；任务阶段自动执行、审核及向其他绑定群转发正文均不附带中止按钮。结束、解绑或关闭时对应操作失效。行为测试见 `tests/test_channel_task_forwarder.py`、`tests/test_channel_origin_stop.py`。

企业微信对用户消息触发的回复，使用普通 `stream` 气泡持续更新正文与最终状态；私聊以空首帧恢复原生等待气泡，群聊首帧显示「正在处理…」，并通过主动发送的 `template_card` 独立提供中止按钮，私聊与群聊使用相同路径。官方协议支持 `stream_with_template_card` 组合回复，但当前接入在实际企业微信移动客户端中出现接口回执成功、按钮不显示的情况，原因尚未确认，因此恢复独立按钮卡片。卡片发送不阻塞正文更新；后续选择题和确认卡片也独立主动发送。自动步骤不发送中止按钮；无原始回调帧时，主动接口没有 `stream` 类型，只在结束时推送完整正文；使用 `button_interaction` 模板卡片与 `event.template_card_event`，通过原回调帧在五秒内确认更新；官方接口不能在没有卡片点击回调时主动更新旧卡片，因此回复结束后未点击的旧停止按钮可能仍可见，但服务端会拒绝其操作。钉钉订阅 `/v1.0/card/instances/callback`，立即 ACK，再异步处理与更新卡片；发送和更新使用原生异步 HTTP。

企业微信卡片回调优先从 `body.event.template_card_event` 读取 `task_id` 和 `event_key`，兼容字段直接位于 `body.event` 的格式；这里的 `task_id` 是发送卡片时生成的卡片 ID，由持久化记录反查 WorkStep 任务与提案，不能作为 WorkStep 任务 ID 使用。格式兼容及回调确认原任务、重复点击去重见 `test_channel_bot_adapters.py` 和 `test_channel_controls.py::test_wecom_nested_callback_confirms_original_task_proposal`。

协议及阻塞 canary：`tests/test_channel_controls.py`、`tests/test_channel_bot_adapters.py`、`test_channel_bots.py::test_task_channel_stop_callback_bypasses_message_queue`、`test_coordinator.py::test_channel_stop_targets_exact_coordinator_reply_and_slow_sql_keeps_health_responsive`。

## 引用消息

统一入站消息可携带 `IncomingMessage.quote: ChannelQuote(text, attachments)`。企业微信适配器解析官方 `body.quote` 的文字、语音转文字、图文、图片和文件；机器人路由在提交给助手前通过 `media.py::incoming_content` 合成为用户正文：先是「引用消息」的 Markdown 引用区块，再是「本次消息」原文。引用附件复用异步下载、解密与项目上传目录持久化，正文只含项目相对路径，不含临时 URL 或密钥。没有引用时保持原文；平台未提供的原消息作者和消息 ID 不推测。此接入目前针对企业微信，钉钉适配器尚不提取引用字段。测试见 `tests/test_channel_quotes.py`，覆盖官方回调、两种助手路由、引用附件及慢磁盘健康检查。

企业微信主动发送的按钮卡片必须包含非空 `main_title.title`，缺失时实际接口返回 `41016: missing title`；标题限制为 26 字，字号和留白由客户端控制，正文不重复标题。按钮文案较长（超过 4 字）时，适配器改用短编号按钮，并在 `sub_title_text` 列出编号与完整选项；确认／取消／中止等短按钮保持原文。说明超过官方建议的 112 字时，先主动发送完整说明，再发送对应卡片，不截断选项，也不结束正在运行的回复流。显示编号不改变按钮 key 或回调原选项，测试见 `tests/test_channel_bot_adapters.py`。

任务渠道回复以协调助手持久化后的 `TEXT_MESSAGE_END` 状态为最终结果，忽略之前的引擎 `RUN_ERROR`，避免手动停止触发子进程退出后误发「处理失败」。`stopped/cancelled` 正常收尾为已停止，实际 `failed` 仍报告失败。测试见 `tests/test_channel_terminal_state.py` 与 `tests/test_channel_task_forwarder.py`。


群聊完成回复的发送人提醒由 `services/channels/wecom.py::_send_text` 和 `dingtalk.py::send` 持有，仅使用本条入站群消息的发送人及回复上下文；企业微信在最终正文追加 `<@userid>`，钉钉使用原始 sessionWebhook 的 `at.atUserIds`，流式卡片完成后单独提醒一次。广播群和私聊不自动提及。中止卡片由 `controls.py::begin` 展示助手消息 ID，`base.py::ChannelCard.message_id` 传递诊断标识，钉钉在卡片 tips 中保留 ID。行为、回退及慢网络健康检查见 `tests/test_channel_mentions.py`。


渠道运行卡片统一由 `controls.py::begin` 按项目、任务／会话、助手消息 ID 及渠道会话去重，接收入口与 `task_forwarder.py::_deliver` 共用，发起群也必须确保运行卡片存在；`finish` 幂等收尾。确认卡片优先取同条回复的正文摘要，所有企业微信按钮卡片由 `wecom.py::send_card` 显示助手消息 ID，超长说明分开发送后卡片仍保留 ID。中止按钮的通用 `ChannelButton.danger` 由操作类型决定，企业微信映射到[官方红色样式 3](https://developer.work.weixin.qq.com/document/path/101032)，钉钉映射为模板 `color=red`，确认／取消保持原色。入口隔离、去重、实际中止、卡片正文与 ID、颜色及慢发送健康检查见 `tests/test_channel_origin_stop.py`。


任务渠道正文由 `services/channels/task_forwarder.py::_deliver` 按任务终态事件顺序发送：`succeeded` 与 `completed` 不追加「已完成」，`stopped`／`cancelled` 有正文时同样不追加状态，无正文时仅反馈「已中止」，真实失败追加错误说明；人工审核的系统等待消息不作为 LLM 正文推送。`review_messages.py` 发布 `message_completed(status=completed)`，经 `engines/core/agui.py::to_agui_events` 保留为 `TEXT_MESSAGE_END(status=completed)`；翻译后的执行／审核消息转发回归见 `tests/test_channel_task_forwarder.py::test_completed_status_from_real_message_translation_is_success`。

### 自动步骤的人工审核与提问

企业微信成功中止后的「已停止」由原回复流或任务转发器发送，按钮回调只确认卡片，不再另发同文消息；失败、已结束及失效结果仍通过回调提示。回归测试见 `tests/test_channel_controls.py::test_wecom_stop_callback_keeps_one_terminal_reply_without_active_duplicate`。

`ChannelTaskControls` 单独订阅 `workstep.review_result/review_status`、`workstep.interaction_request/response` 与阶段问题事件，也订阅协调回复的 `workstep.async_question`，将 WorkStep 发起的任务问题转发给当前绑定群；选项按消息、问题、分页及渠道会话去重，来源入口与群转发不会重复发送，跨群回答只接受一次。复用 `ChannelControls` 而不创建停止按钮。人工审核等待时发送「通过／不通过」卡片；通过继续下游，不通过复用原审核服务的反馈重跑逻辑。卡片没有原生自由文本输入框，需要填写意见的用户仍在 WorkStep 审核表单提交。枚举、布尔问题和工具权限请求转换为按钮，复杂表单提示回 WorkStep。

自动群卡片通过机器人 ID、群 ID 和当前任务绑定验证来源，允许该群成员点击；用户消息触发的卡片继续限定原发起者。审核决定和消息作者使用实际点击者身份，昵称缺失时显示用户 ID；卡片操作记录另保存 `clicked_by`。审核按钮每次点击检查项目数据库中的当前轮次、归档状态和已有决定，跨群并发点击仅接受一个决定；持久化人工审核按钮可以跨重启操作，临时引擎问题仍受活跃会话约束。测试及慢 SQL 健康检查见 `tests/test_channel_task_controls.py`。

渠道审核卡片由 `task_controls.py` 在 `task_forwarder.py::wait_for_completed` 的终态事件栅栏后发送，确保阶段正文先发送；栅栏不等待仍在运行的 LLM，跨任务保持异步。`taskReviewRules.ts::reviewActorLabel` 对渠道审核人名称中已带的来源去重（如「企业微信 · 用户」不再次拼接企业微信）。顺序、人工审核通知过滤、慢审核查询健康检查和标签回归见 `test_channel_task_forwarder.py`、`test_channel_task_controls.py`、`taskReviewRules.test.ts`。
