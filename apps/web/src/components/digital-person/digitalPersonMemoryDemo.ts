// Explicitly fictional content; kept in memory only and never sent to the daemon.
export type MemoryLayer = 'recent' | 'current' | 'long'
export interface MemoryNode {
  id: string; layer: MemoryLayer; title: string; source: string; quote: string
  scope: string; reason: string; loaded: boolean; related: string[]; disabled?: boolean
}
export const memoryDemoNodes: MemoryNode[] = [
{id:'episode',layer:'recent',title:'昨天的样片校验失败',source:'任务 T-12 的工具执行记录',quote:'首次校验发现模型文件不完整，重新下载后校验通过。',scope:'样片项目',reason:'保留一次真实经历，尚未自动认定为通用经验。',loaded:false,related:['check','watch']},
{id:'message',layer:'recent',title:'今天你调整了通知偏好',source:'陈禾 / 样片验收会话 / 16:40',quote:'过程中不用一直告诉我，有可用的样片，或者需要我处理时再叫我。',scope:'陈禾 / 样片项目',reason:'明确表达的偏好，可形成带范围的长期记忆。',loaded:false,related:['preference']},
{id:'tool',layer:'recent',title:'查询下载任务进度',source:'任务 D-01 状态查询',quote:'已下载 31.06 / 34.37 GB。校验与生成样片尚未完成。',scope:'样片项目',reason:'本轮读取的实际状态；只是当前观察，不是长期知识。',loaded:true,related:['watch']},
{id:'chat',layer:'recent',title:'用户询问可以了吗',source:'陈禾 / 样片验收会话',quote:'可以了吗？',scope:'陈禾 / 样片项目',reason:'把这次询问关联到已有待办，不重复创建任务。',loaded:false,related:['watch']},
{id:'watch',layer:'current',title:'等待可交付的样片',source:'工作事项 W-01 / 关联任务 D-01、V-01',quote:'完成条件：下载结束，样片生成并通过播放校验。',scope:'样片项目',reason:'本轮进度未满足完成条件，继续跟进。',loaded:true,related:['tool','check','notify']},
{id:'notify',layer:'current',title:'结果可用后通知陈禾',source:'工作事项 W-01 / 来源会话',quote:'产物可用时回复原会话；当前没有必要发送新的进度提醒。',scope:'陈禾 / 样片项目',reason:'提醒是结构化待办，不依赖从长期摘要中重新猜测。',loaded:false,related:['watch','preference']},
{id:'check',layer:'long',title:'样片可播放才算完成',source:'任务验收条件 / 今天 15:20',quote:'下载模型后生成样片，确认可播放后才算完成。',scope:'样片项目',reason:'本轮加载 v1，作为完成条件的证据。',loaded:true,related:['watch','episode']},
{id:'preference',layer:'long',title:'陈禾偏好只通知最终结果',source:'明确约定 / 今天 16:40',quote:'仅在结果可用或需要我处理问题时通知我。',scope:'陈禾 / 样片项目',reason:'本轮加载 v1，用于判断是否需要通知。',loaded:true,related:['message','notify']}
]
export const learnedMemory: MemoryNode = {
 id: 'learned', layer: 'long', title: '校验失败先核对文件完整性',
 source: '近期经历 / 本次演示确认', quote: '首次校验发现文件不完整，重新下载后通过。',
 scope: '样片项目', reason: '从一次已核实经历提炼的有限范围建议，仍需后续结果验证。',
 loaded: false, related: ['episode', 'watch'],
}
