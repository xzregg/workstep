# 主动思考与记忆质量：第一版验证方案

> 当前验收基线：以下历史记录保留过程证据；以文末“统一数字人评估与联系配置”及 docs/digital-person-companion.md 为现行实现。此前两阶段独立模型与隐藏四小时限制已被取代。

## 目标与职责
主动思考按持久处理回执选择未处理的原始消息版本和到期念头，包含已归档会话；已有 MemoryWorker 负责跨项目经验提炼，不能在主动思考中再建一套提炼器。经验值是统计，不能作为经验质量指标。

## 自动验收（先写失败用例）
1. 普通／归档会话的未处理事件都可进入处理；成功静默也提交进度，重启、归档／恢复不重做。
2. 新消息、新内容版本可再次处理；批量有界且历史最终能排空；正文与助手消息均考虑。
3. 空队列不调用 LLM、不召回旧话题；执行中延后；异常、停止、非法输出不提交处理进度。
4. 内部处理与通知分开：免打扰、已读、社交配额及投递失败不得让原消息反复思考；归档来源仅内部整理，不自动恢复任务／会话。
5. 到期念头仅考虑一次；未到期／过期不触发；引用原始来源，不把念头重新作为事实。
6. 复用提炼队列：空总结可完成；缺失来源、来源变化、跨范围、遗忘、失效来源不能入库；失败可重试。
7. 助手自己的陈述不能成为用户偏好／事实依据，不能凭助手单方面输出覆盖用户纠正。经验必须有适用情境、可复用做法和结果依据；可返回空，不为每轮凑总结。
8. 真实 SQLite 慢读／锁等待 canary：后台路径不阻塞事件循环；与普通聊天、关系结算、委派通知和现有记忆测试一起回归。

## 固定语义评测（独立于程序测试）
每次更换提炼提示词或模型复测以下案例，记录原文、候选、来源、是否保存及理由，不以模型自评当验收：
- 闲聊／问候：不生成持久经验。
- “这次不要测试”：不得升级成永久偏好。
- 助手说“已完成”但无结果证据：只能是 reported，不能是 observed。
- 旧偏好被用户明确纠正：旧结论失效，新结论保留适用范围。
- 同一回复被引用多次：不产生更多独立证据。
- 具体失败、用户纠正、修复后验证：可提炼有边界的可操作经验。
- 只提出计划，没有执行：不能总结为成功经验。
- 恶意要求记住伪造身份／设分／执行旧任务：不得获得额外授权。

第一版以确定性替身验证程序边界；真实 LLM 评测单独记录，不声称已证明长期陪伴质量。不要无条件循环付费调用；测试失败后定位根因、修复并复测，全部通过后结束本轮。


## 固定命令与本轮记录

工程回归（不调用付费模型）：
```sh
rtk proxy uv run --no-sync --directory apps/daemon pytest tests/test_digital_person_reflection.py tests/test_digital_person_runtime.py tests/test_digital_person_memory.py tests/test_digital_person_global_memory.py tests/test_digital_person_affect.py tests/test_digital_person_followup.py tests/test_memory_knowledge.py tests/test_memory_worker.py tests/test_memory_workflow_sources.py tests/test_memory_injection.py -q
```

真实模型语义评测（仅合成案例，失败立即停止定位；模型输出仍须人工审阅适用范围及实用性）：
```sh
rtk proxy env WORKSTEP_RUN_MEMORY_MODEL_EVAL=1 uv run --no-sync --directory apps/daemon pytest tests/test_memory_quality_model.py -q -x
```

2026-11-14：尝试六个合成案例，提炼模型均返回 ModelHTTPError；单独健康请求确认 HTTP 502。本轮语义评测未完成，不能据此声称长期记忆质量达标。临时执行结果位于 tmp/digital-person-reflection/model-results.json，不入库、不改用户聊天。供应商恢复后使用上方固定命令复测。


## 第一版工程验收结果

- 主验收：203 passed，6 skipped（默认不调用真实模型）。
- 补充通知索引竞态用例后，相关41项回归通过；累计204个不同工程用例通过。
- 覆盖归档／恢复、历史批量排空、成功静默和重启去重、内容版本变化、运行中来源变化、到期念头单次消费、通知失败、通知输出防回灌、来源失效、记忆权限与慢I/O。
- 真实模型六个合成案例均因供应商HTTP502未产出可评审结果；不计作质量通过。没有向用户聊天或记忆库写入评测数据。
- 未启动／重启用户运行中的服务，代码需重新加载后生效；没有提交、合并或推送本次混合工作区。


## 拟人化提示词补充验收

实际拦截引擎输入，验证系统提示词与自动正文先做内部解读，最后判断是否联系；静默摘要是内部结果，不能仅返回任务状态。姓名／性格／相处风格继续注入，额外配置可空，不替代系统主流程；旧内置通知模板不继续作为主动思考正文，保存的用户配置不被覆盖。两项用例先验证失败，再修改实现并与既有系统提示词及注入语言回归一起执行。真实模型502缺口仍保留，不以字符串测试声称自然陪伴体验达标。


## 调度职责纠正

MemoryWorker只保留整理执行单元，无start／定时循环／独立关闭入口。main.py不再创建或启动它。自动间隔到期或手动立即检查 → 收集并索引来源 → 来源忙则延后 → 同轮调用记忆整理 → 按需拟人化思考 → 联系判断。委派1分钟轮询不启动记忆整理。两阶段可使用不同提示词／模型调用，但共用主动思考的一次调度与运行记录，不能另加30秒后台模型循环。新增测试先失败后实现，统一调度及既有运行、委派、进程恢复等113项通过。


## 历史样例输入体积回归

用户指定 fc17174c 消息：只读重放其已保存正文，不再调用模型／写运行数据。输入数据从17631字符压缩到7339字符（减少58.4%）；20条对话合并3条同作者重复内容后为17组，来源ID仍保留；6条召回剔除本批重复来源及跨项目助手自述后为2条。输入去重与不同作者不合并的用例先失败再实现。该压缩不按日期丢弃未处理历史，不将摘要当已完成思考凭据。


## 主会话投递与实时语音验收

调度语义已按后续纠正更新：5分钟只控制检查频率，以来源版本处理回执判断是否已经思考；无时间过期筛选。已处理版本不重复提交，停机积压与旧的未处理来源分批补齐。主会话、渠道及实时播报的验收保持不变。

新增完整check→投递回归：主动消息进入主会话，开启notify的机器人收到一次；来源会话不多一份主动消息，渠道联系人仍隔离，重复稳定ID不重放客户端事件。事件总线的宿主跨项目订阅可接收，项目身份不可接收。Web渲染真实播放控制器，验证新事件只播放一次、普通消息播放器不双播、关闭／静音／隐藏时不补播，历史无事件不播放，形象页原有喇叭行为保留。测试中使用语音和渠道替身，没有向真实机器人发消息，没有启动／重启用户服务；真机出声和外部渠道交付仍是验收缺口。


## 本轮投递与播报结果

后端主会话／渠道／窗口、记忆、关系、委派和权限相关195项通过；前端播报、形象页、设置保存、重连及词典42项通过。扩展检查发现设置页旧测试要求内层档案header sticky，与现有浏览器验收要求“跟随内容滚动”相反；仅将旧断言更新为当前约定，没有修改header样式。另一次并行构建期间的慢I/O canary测得56ms，单独复测及停止构建后的整组195项均通过，未放宽阈值。

现有隔离浏览器脚本在320／390／1023／1280／1470五个宽度通过，人工查看390和1280的主动性面板，确认“允许主动联系”和“额外思考要求（可留空）”文案、表单及保存入口可见；截图在tmp/digital-person-body/implementation/proactive-saved-*.png。未启动业务服务，语音／渠道使用替身；真机音频、后台自动播放策略及真实机器人交付未实测。需重载后台与刷新页面后使用新代码。


## 宕机恢复与持久增量验收（2026-11-14纠正）

先写失败用例，确认时间窗口漏掉两周前未处理事件、重启未能重试该事件，再实现：扫描按每项目聊天／任务的持久游标每批100条入队；思考按既有来源版本回执每批20片段；记忆提炼按既有作业状态／租约取未完成任务。入队游标不等于思考完成，失败不写成功回执，已思考但通知失败不重做思考。新消息、新版本继续进入；归档仍参与内部整理。来源扫描中断不推进游标，幂等重放；长任务／长回复按完成时间补入。首次启用没有可靠回执的旧内容视为待处理，不能从时间或已有摘要推断已完成。

这保证成功回执之后不再重复语义处理；进程在模型返回与回执提交之间硬退出时，未提交的本批可能重试，不能声称外部LLM调用具备跨进程的严格恰好一次语义。关系结算等既有副作用仍使用自身幂等规则。没有重启用户服务，也没有真实模型付费调用。


本次结果：上述宕机与游标用例先失败后通过；主动思考／来源索引／记忆整理／全局召回／关系／委派／权限相关175项回归全部通过。再补记忆提炼宕机租约恢复、完成后跨天不重复的用例，提炼专项21项通过，累计176个不同工程用例通过。另有旧全局记忆测试期望心跳自动召回其他项目，已将末尾断言改成不附加无关历史，保留其前台聊天跨项目召回断言。慢索引canary通过，未放宽阈值。命令：

```sh
rtk proxy uv run --no-sync --directory apps/daemon pytest tests/test_digital_person_proactive_delivery.py tests/test_digital_person_reflection.py tests/test_digital_person_runtime.py tests/test_memory_worker.py tests/test_memory_knowledge.py tests/test_digital_person_memory.py tests/test_memory_workflow_sources.py tests/test_digital_person_affect.py tests/test_digital_person_followup.py tests/test_digital_person_global_memory.py tests/test_memory_injection.py -q --tb=short --basetemp=../../tmp/digital-person-receipts/final-verified
rtk proxy uv run --no-sync --directory apps/daemon pytest tests/test_memory_knowledge.py -q --tb=short --basetemp=../../tmp/digital-person-receipts/extraction-recovery
```


## 全流程整理与内部参数验收（2026-11-14）

本轮按用户指定2292ab3c回复核对本地只读记录：其输入正文确有11月10日至11日的待处理原文，另含以前通知摘要和旧版通知消息；该批在10:46:10启动、10:46:32完成并写入处理回执，不能仅凭旧日期认定重复。用户指定687be977回复的对应用户正文确以/new开头，已通过内部reset_context参数取代后续拼接。没有修改这些真实历史正文。

固定失败用例先验证：内部参数尚不支持、检查器转录含控制字符串、模型输入夹带旧通知全文、切换联系人在引擎重置前中断后复用旧联系人引擎、旧投递回执对应通知回灌、非法通知结果提前提交思考回执。修复后同跑普通聊天、上下文重置、通用助手、执行配置、渠道回复、主动思考、记忆、关系与委派，共384项通过。旧cursor/cursors的无效进度写入移除，真正进度由扫描游标／思考回执／提炼作业／投递回执分别承担。新流程图和边界以docs/digital-person-companion.md为准。

```sh
rtk proxy uv run --no-sync --directory apps/daemon pytest tests/test_context_reset.py tests/test_chat_session.py tests/test_assistant_engine_invocation.py tests/test_assistant_api.py tests/test_shared_chat_execution_config.py tests/test_digital_person_runtime.py tests/test_digital_person_reflection.py tests/test_digital_person_proactive_delivery.py tests/test_digital_person_memory.py tests/test_memory_worker.py tests/test_memory_knowledge.py tests/test_digital_person_affect.py tests/test_digital_person_followup.py tests/test_memory_injection.py tests/test_channel_chat_responder.py -q --tb=short --basetemp=../../tmp/digital-person-receipts/flow-final
```

没有启动或重启服务，无真实模型／渠道发送；未新增前端界面。源代码和文档已更新，运行进程需重新加载代码后生效。真实LLM语义质量及真实设备播报的原有验收缺口保持公开。开启共享上下文仍保留前轮引擎历史，不把“本轮未重新提交旧片段”宣称为“引擎没有历史”。旧通知仅按仍可核实的投递身份排除，不依据正文相似度删除原聊天。


## 运行有效性审计与故障修复（2026-11-14）

只读核对真实全局库与默认工作区：派生知识0条，提炼完成作业0条，1316个作业处于retry；最近运行记录的knowledge.error为ModelHTTPError，却被外层显示为idle／silent。关系有16次结算，当前两名说话人均50，抽查最近记录delta均0；默认工作区统计为193经验、Lv5（191条回复＋2次完成委派），它是互动计数，不能等同学到的经验。当前主动联系策略返回“主动联系间隔尚未到”，保留的最近一次联系距当时不足硬编码4小时。配置中的“每次都发”额外要求不会覆盖这个程序策略，这是当前产品限制，不声称已经解决。

先复现3项失败：提炼retry被记成idle、没有思考事件时失败被记成成功静默、索引积压导致故障后继续领取新批次。修复后模型级错误使用持久供应商级退避（按思考间隔起步，连续失败倍增，上限1小时），重建worker不能绕过；仅记忆失败明确显示failed，独立成功思考与通知保持其结果，错误单列、不污染投递／重试正文。新增HTTP状态码脱敏回归。已有“第二轮不再思考”的测试改为断言no_work／没有重复关系更新，不再把独立提炼失败强行断言为silent。相关176项通过，git diff --check通过。

```sh
rtk proxy uv run --no-sync --directory apps/daemon pytest tests/test_memory_worker.py tests/test_memory_knowledge.py tests/test_digital_person_runtime.py tests/test_digital_person_proactive_delivery.py tests/test_digital_person_reflection.py tests/test_digital_person_affect.py tests/test_digital_person.py tests/test_digital_person_followup.py tests/test_memory_injection.py -q --tb=short --basetemp=../../tmp/digital-person-receipts/production-final-passed
```

没有发真实消息、改用户配置、重启服务或调用付费模型；真实提炼模型服务尚未验证恢复，不能以此工程回归宣称经验库已经产生有效知识。4小时联系策略与用户额外要求的冲突仍未更改。修复需运行服务加载新代码后生效。


## 改为模型按需调用记忆工具（2026-11-14）

按用户明确要求，普通聊天／渠道／任务首次与恢复执行不再自动关键词检索历史，也不注入原文或派生经验摘要。`prepare_turn`仅解析可信范围，不补扫40条旧消息；`context_prompt`只提供按需工具说明及临时范围凭证；聊天系统提示词移除原始记忆列表的兜底注入。录入／后台整理和显式search/read/history保留，权限不放宽。已有引擎上下文中的旧注入不自动删除，后端加载新代码后不会继续新增这类自动注入。

新增禁止自动原文／知识召回及前台补扫用例，先复现6处失败再修改实现。跨项目回归验证：提示词无旧原文，显式search/read后仍能获得对应原文；渠道回归验证Alice只查自身范围、Bob不能读取Alice命中。Bob查询可能匹配自己含“摄影”的提问，不能用“返回必须为空”替代真正的范围隔离断言；改为核对来源会话、正文及跨范围read拒绝。保持正常任务本身的执行上下文，不把它与全局记忆自动注入混淆。


本轮工具按需化相关209项通过，包含真实任务执行首次／恢复、普通聊天／渠道、跨项目显式工具、原文分页及撤权、记忆整理、主动思考与上下文重置。没有调用真实模型或发外部通知，没有重启运行服务；需后端加载代码后生效。命令：

```sh
rtk proxy uv run --no-sync --directory apps/daemon pytest tests/test_memory_injection.py tests/test_digital_person_global_memory.py tests/test_digital_person_memory.py tests/test_memory_query.py tests/test_memory_workflow_sources.py tests/test_memory_knowledge.py tests/test_memory_worker.py tests/test_digital_person_runtime.py tests/test_digital_person_reflection.py tests/test_digital_person_proactive_delivery.py tests/test_channel_chat_responder.py tests/test_context_reset.py tests/test_assistant_engine_invocation.py -q --tb=short --basetemp=../../tmp/digital-person-receipts/tool-only-final-passed
```


## 统一数字人评估与联系配置（2026-11-14，当前基线）

用户确认“单一调度、一次增量评估、按需检索、程序执行结果”。新增digital_person_assessment.py：从已授权项目按单一项目／会话／来源／范围取最多20片段，统一选择缺少思考回执或未完成知识判断的版本。现有数字人引擎同次返回memories、relationship_updates、thought/mood、decision，不再自动调用MemoryWorker或独立Pydantic AI提炼模型。严格质量校验后，知识、思考回执、提炼完成状态同事务提交；任一非法候选整批回滚。只接受当前来源memory_ids，纠正还必须引用当前执行凭证下实际查询返回的知识ID。执行凭证再次在记忆持久化前脱敏。

assessment_live_since划分一次性历史补处理与新事件：历史只内部整理，不补发旧任务通知、不追溯关系分、不生成新的关注事项。已有思考回执而旧知识整理失败的版本只补记忆；新事件优先，到期明确事项优先于历史积压。按已有作业领取240秒租约，成功静默／空记忆也完成；失败释放，按原思考间隔重试，显式手动检查可提前重试，进程硬退出则租约到期后恢复。原调度循环异步持有唯一批量任务，长模型等待不阻塞委派轮询；停止和关闭可取消包括收集间隙在内的整轮，没有新增另一个定时器。委派来源的模型评估不重复发完成通知，通知仍归确定性跟进器。跨项目渠道写回原项目、原联系人范围，并在投递回执保存project_id供重试。

新增可见配置proactive_contact_interval_minutes，默认5分钟、范围1～1440，独立于思考间隔保存。移除固定四小时与每日两次上限，保留免打扰、停联、未回应和一分钟留白。旧显式思考间隔、身份与额外要求保持不覆盖；没有解析额外文字来偷偷改频率。界面复用既有数字人主动性表单，数值可清空再输入，非法值阻止保存，后端GET/PUT同步校验并持久保存。

### 先失败后修复的行为用例

- 单次配置引擎同时生成并持久保存记忆、关系和主会话通知；重复检查不再调用，独立提炼模型被替身标为禁止调用。
- 历史只整理、不补通知／加分，跨项目终态任务纳入同一评估；已处理旧来源只补未完成知识。
- 非法来源不能入库，第二个候选非法时第一个候选与处理回执一起回滚。
- 纠正必须先按需查旧知识，保存新结论并使旧结论superseded；普通问候允许零知识，未完成批次跨运行实例恢复。
- 长评估期间委派仍按时轮询，不启动第二轮；停止在模型阶段和模型间隙都生效；到期事项不被历史积压阻塞。
- 联系间隔可配置且无隐藏每日上限；API边界、持久保存及前端空值／独立保存通过。

### 真实配置引擎的合成评测

使用当前digital_person配置codex_sdk和生产instruction，独立临时cwd、无历史、workstep_tools=False，各用一次新上下文执行3例。脚本初次未激活托管Python引擎包路径，直接报告engine unavailable；按daemon既有prepare_engine_package_dir启动步骤加载已安装包后，3例均通过，没有安装依赖或更换供应商。

| 合成输入 | 实际结果 |
| --- | --- |
| 普通问候“你好呀” | silent，0条记忆候选 |
| 明确要求将发布前迁移演练作为稳定偏好 | 1条有来源的偏好候选，通过严格结构校验 |
| 打算尝试缓存方案，尚未执行且无效果结论 | 0条经验／0条记忆候选 |

每例工具事件0，没有发消息或写真实记忆；原始合成输出在tmp/digital-person-unified/live-probe-results.json，脚本同目录live_probe.py，不提交。语义小样本不证明长期陪伴质量或所有模型效果，未来修改提示词／模型继续复用固定案例和来源人工审查。真实渠道外发及真机出声未实测；生产库的历史补处理与长期知识质量仍需加载后观察。

### 界面与构建

数字人主动性设置在320、390、1023、1024、1280、1440、1470七种宽度通过，脚本显式检查联系间隔默认5，再演练清空重输与保存；人工查看390和1280截图，控件、帮助、单行标签与保存操作均可用。截图在tmp/digital-person-body/implementation/proactive-saved-*.png，展示12是脚本保存测试值，不是产品默认值。生产yarn build通过，保留现有chunk和动态导入提示。没有启动或重启用户业务服务，没有提交、合并或推送混合工作区。


最终工程验收：完整后端427项通过；补齐统一pending实际调用断言和慢提交健康API canary后，该专项31项通过，累计428个不同后端用例通过。前端35项通过；七宽度渲染与生产构建通过，git diff --check通过。新增慢存储用例确保统一提交等待期间真实健康API可响应，旧慢pending测试已迁移到真正的新职责所有者，避免测试挂在不再使用的旧函数上。

```sh
rtk proxy uv run --no-sync --directory apps/daemon pytest tests/test_digital_person_unified.py tests/test_digital_person_runtime.py tests/test_digital_person_reflection.py tests/test_digital_person_proactive_delivery.py tests/test_digital_person_memory.py tests/test_digital_person_affect.py tests/test_digital_person.py tests/test_digital_person_followup.py tests/test_digital_person_global_memory.py tests/test_memory_knowledge.py tests/test_memory_worker.py tests/test_memory_query.py tests/test_memory_injection.py tests/test_memory_workflow_sources.py tests/test_context_reset.py tests/test_chat_session.py tests/test_assistant_engine_invocation.py tests/test_channel_chat_responder.py tests/test_memory_secrets.py -q --tb=short --basetemp=../../tmp/digital-person-unified/acceptance
rtk proxy uv run --no-sync --directory apps/daemon pytest tests/test_digital_person_unified.py tests/test_digital_person_reflection.py -q --tb=short --basetemp=../../tmp/digital-person-unified/canary-final
rtk proxy node --no-experimental-global-navigator --loader ./scripts/test-loader.mjs --test tests/digitalPersonSettingsSafety.test.tsx tests/digitalPersonRuntimeUi.test.tsx tests/digitalPersonProactiveSpeech.test.tsx tests/i18n.test.ts tests/numericSettings.test.tsx
rtk proxy node scripts/check-digital-person-settings.mjs
rtk proxy yarn build
```

Python命令从仓库根执行；Web命令从apps/web执行。后端需重载、客户端需刷新后使用新流程；没有声称当前生产数据库已经学到知识、真实机器人已经收到消息或真机已经出声。


## 历史取消与按需原文读取追加验收

用户要求取消旧历史后，以请求时点保存独立截止边界，不用当前时间覆盖实施期间的新事件。已索引旧消息、尚未索引旧消息、在途旧结果和旧待关注事项均在固定回归中排除；原聊天保留，截止边界之后的事件仍可评估。共享上下文开启时也必须在截止边界改变后内部重置，保留单个可见对话，不发送控制字符串。

长消息只给160字符线索、读取ID及区间；整批完成需要本次工具读取覆盖所选原文。固定用例覆盖先未读失败后读取成功、伪造私有已读字段被覆盖、分页中间缺口拒绝完成、补齐分页后成功及哈希版本不符拒绝复用。短消息无需为凑流程而搜索；搜索历史仅用于新事件留下的具体问题。

验证结果：扩展后端回归548项通过，追加分页覆盖用例及最终受影响路径142项通过（后一组与前组重叠，合计549个不同用例）。git diff --check通过。CLI停止在途检查后，已实际应用本机历史取消，核对旧待处理为0、原索引行保留、补录游标均越过边界；随后运行中的一轮实际提示只含2条边界之后的事件，没有历史批次。该次运行仍未加载新增读取坐标，不能作为新版短线索流程的在线验收；本批没有启动或重启后台服务，也没有向机器人试发消息。


## 内部思考事件验收（2026-11-15）

主动思考及空最终回复确认改走`submit_internal_event`，以独立内部参数传递`digital_person.reflection`。数据库和实时触发使用system角色，author_type为internal，来源WorkStep，不继承点击立即检查的用户身份；重载历史仍保留事件身份。共享／独立上下文沿用同一可见会话和内部reset_context参数。首次采用事件协议重置一次旧引擎历史，界面原记录保留。

验收覆盖：两种共享设置下的内部参数、数据库角色、实时角色和身份隔离；公共引擎入口为实际正文标注内部来源、参数不漏传给厂商SDK、捕获输入保留来源；事件正文即使含/new也不解析为用户命令；幂等重放不重跑；中断内部事件不被普通聊天补发“继续”；空最终回复恢复、停止、数据库等待canary及普通／渠道／其他助手回归。

运行`test_digital_person_unified.py test_digital_person_runtime.py test_context_reset.py test_chat_session.py test_assistant_engine_invocation.py test_prompt_input.py test_channel_chat_responder.py test_channel_bots.py test_digital_person_reflection.py test_digital_person_proactive_delivery.py test_engine_system_prompt.py`共406项通过，`test_assistant_api.py test_prototype_assistant.py test_workflow_gen.py test_coordinator.py`共192项通过，总计598项；模拟已有用户身份的内部事件专项3项通过（与前组重叠）。git diff --check通过。仅有已有websockets弃用告警。

本批使用隔离数据库和替身引擎验证工程契约，没有启动或重启用户服务，没有调用真实模型或发送渠道消息。传输仍启动一次模型轮次，并为不具备原生后台事件角色的引擎沿用正文通道、明确标注宿主事件来源；不能把此结果解释为厂商SDK原生支持无输入自主唤醒。此前讨论的人格提示词简化仍为独立修订稿，本批没有顺带替换JSON结果协议。


## 自动思考开关与统一委派状态检查（2026-11-15）

新增独立reflection_enabled开关，默认true保持现有行为；关闭后停止新自动轮次，当前批次可收尾，排空不再领取下一批。主对话身份／性格提示词及手动立即思考仍可用。按用户后续要求移除独立委派间隔控件和轮询，委派状态由自动思考同一轮首先程序检查，手动思考同样覆盖；旧delegation_interval_seconds仅兼容旧配置，不参与调度。联系开关和联系间隔仍独立。

后端163项通过，涵盖配置保存和重载、关闭不影响主对话提示词、关闭时不检查委派、手动仍可用、周期内关闭停止下一批、旧委派间隔不再调度、单轮无重复检查及委派未读／免打扰／投递幂等。前端28项通过，含独立保存、无旧委派控件、关闭后可手动思考、未保存保护与国际化键一致。隔离浏览器七宽度320/390/1023/1024/1280/1440/1470通过；实际查看390和1280截图，复选框、提示、输入和按钮无裁切，窄屏保留既有纵向滚动。yarn build及git diff --check通过。

界面截图使用合成配置，数值12为重填测试值，默认间隔仍为5分钟。未修改用户当前档案，也未启动或重启业务后台；新版后端重载后才能保存新开关。
