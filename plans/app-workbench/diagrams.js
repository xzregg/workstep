'use strict';
const node=(id,x,y,title,sub,kind,detail,items=[])=>({id,x,y,title,sub,kind,detail,items});
const edge=(from,to,label='',via=null)=>({from,to,label,via});
const architecture={
 system:{title:'整体架构',summary:'项目是统一入口。复用聊天、引擎和流程，增加应用配置、环境、版本与发布管理；执行任务与应用服务分开。',height:650,nodes:[
 node('user',365,25,'创建者／开发者','网关或本机身份','existing','使用现有项目入口开展开发与发布。',['管理权限与应用用户权限分开','发布权限按目标环境检查']),
 node('project',365,145,'WorkStep 项目','模板含流程与两类快捷按钮','existing','保留普通项目；空项目主动选择模板后，生成流程、项目快捷按钮与对话快捷按钮。',['不选模板不创建流程','重复应用不覆盖定制','导入仓库可只补流程和按钮']),
 node('chat',65,275,'聊天 · Git · 工作流','复用现有基础','existing','开发聊天修改当前程序；复用统一引擎和事件，避免另造一套助手。',['流程模板主动选择','测试与构建作为可查询任务']),
 node('control',365,275,'应用生命周期控制','配置／环境／版本／发布','new','管理应用运行契约、不可变版本、环境状态和持久化操作。',['记录镜像摘要与配置引用','发布、回退和恢复互斥','连接日志与状态订阅']),
 node('runtime',665,275,'统一模型服务入口','应用受限服务身份','new','程序运行时的模型调用与开发聊天分开授权。',['应用级模型和工具范围','额度／并发控制','不传递创建者原始凭据']),
 node('executor',365,415,'执行与部署适配器','本机／远程 Docker','new','控制面提交带操作标识的任务，执行端报告真实状态。',['本机及远程主机统一执行协议','SSH 指纹与凭据管理','断连查询，不重复执行迁移']),
 node('tools',65,535,'数据与迁移适配器','备份／快照／风险／校验','risk','SQLite 和 PostgreSQL 分别提供一致性复制及迁移检查。',['无证据时标记未知风险','正式库只作为测试数据源','处理脱敏、外部副作用']),
 node('containers',365,535,'应用容器与域名入口','预览／正式环境隔离','runtime','运行固定镜像；健康检查后切换路由。',['多服务 Compose','持久化卷独立于镜像','预览需授权，正式业务由应用登录']),
 node('storage',665,535,'应用业务数据库与文件','SQLite／PostgreSQL','runtime','应用拥有独立业务库，不与 WorkStep 项目编排 SQLite 混用。',['数据库按环境绑定','代码更新不替换业务数据','测试数据不会回写正式环境'])],edges:[edge('user','project'),edge('project','chat'),edge('project','control'),edge('control','runtime'),edge('chat','executor'),edge('control','executor'),edge('executor','tools'),edge('executor','containers'),edge('containers','storage'),edge('runtime','storage','业务数据访问由应用授权',[[755,386],[870,386],[870,573]])]},
 deployment:{title:'部署与身份',summary:'网关负责工作台创建者身份。业务应用拥有自己的登录与 RBAC；预览、正式容器与数据库分开，服务密钥不进入浏览器或镜像。',height:650,nodes:[
 node('creator',65,30,'工作台创建者','Gateway 账号','existing','项目管理、开发和发布操作者。',['已有网关认证与项目授权','应用目标环境另行检查发布权限']),
 node('gateway',365,30,'Gateway → WorkStep','受控项目访问','existing','复用网关项目访问及管理身份；不能将网关 Cookie 当作应用业务登录。',['项目分享≠部署应用','预览入口受工作台权限保护']),
 node('consumer',665,30,'应用使用者','浏览器访问正式域名','runtime','使用者无需进入 WorkStep，也不需要拥有程序创建权限。',['应用账号独立','可通过应用自己的 IM 身份源登录']),
 node('host',365,165,'部署执行层','本机或远程主机','new','第一版建议本机 Docker 和 SSH 远程 Docker，非 Kubernetes 前置。',['镜像分发及架构校验','环境配置与凭据安全注入']),
 node('route',665,165,'域名 · TLS · 反向代理','每环境独立路由','new','DNS、证书和路由分别校验，不能仅保存域名就显示已上线。',['健康检查后切换目标','正式域名保留应用自身认证']),
 node('preview',65,315,'预览服务组','开发代码／测试配置','runtime','可热更新或按仓库能力重建，显示实际预览代码版本。',['多服务预览','不挂载正式凭据','旧代码预览标记过期']),
 node('production',365,315,'正式服务组','已验证的不可变镜像','runtime','发布同一份已验证镜像，数据卷独立于容器。',['就绪后切流','不兼容迁移采用维护窗口','失败后的恢复依据真实数据库状态']),
 node('auth',665,315,'应用身份与 RBAC','独立用户／角色／IM 同步','risk','新建后台模板内置，导入程序保留原实现。',['不自动复制网关用户','权限在应用后端执行','业务聊天与开发聊天隔离']),
 node('testdb',65,495,'测试库与测试文件卷','复用／迁移／隔离副本','runtime','按需求准备而非每个版本重复创建。',['种子、快照或业务子集','脱敏与关闭外部写入']),
 node('proddb',365,495,'正式库与业务文件卷','持续存在的生产资源','runtime','应用版本更新和回退默认保留业务数据。',['一致性备份','数据恢复单独确认','DB 与文件恢复需一致性策略']),
 node('secrets',665,495,'环境配置与服务凭据','发布配置修订引用','risk','同一镜像在不同环境注入不同配置。',['应用模型服务范围受限','凭据不写入 Git 或镜像'])],edges:[edge('creator','gateway'),edge('gateway','host'),edge('consumer','route'),edge('route','production'),edge('host','preview'),edge('host','production'),edge('production','auth'),edge('preview','testdb'),edge('production','proddb'),edge('auth','secrets'),edge('proddb','testdb','仅正式 → 测试的一致性副本')]},
 versions:{title:'版本与数据库',summary:'代码版本不等于数据库实例。版本声明结构兼容关系，环境绑定实际实例，数据快照和迁移记录单独管理。',height:660,nodes:[
 node('draft',65,30,'开发草稿','聊天持续修改','existing','工作区可以反复修改，不影响已创建版本。',['测试证据随代码／结构／数据变化失效','预览显示当前代码标识']),
 node('version',365,30,'不可变应用版本','代码＋镜像＋配置契约','new','版本记录源代码快照、各服务镜像摘要、迁移清单及测试证据。',['创建后固定','发布不重建源码','多服务记录一组镜像']),
 node('schema',665,30,'结构要求与兼容性','迁移集／校验和／证据','risk','兼容性不能仅比较 s12、s13 数字，需要应用声明与验证。',['支持的结构范围','DDL 风险和演练证据','未知不视为兼容']),
 node('testenv',65,210,'测试环境','绑定测试实例','new','调试可复用兼容数据库；需要并行旧版或风险验证时创建隔离副本。',['同库迁移需互斥','无表变更优先复用']),
 node('deployment',365,210,'发布／回退记录','版本＋环境＋配置修订','new','一次发布或回退是一条可审计操作，而不是修改版本。',['记录状态与切换时间','引用原正式部署与恢复点','断连可查询恢复']),
 node('prodenv',665,210,'正式环境','绑定正式实例','new','多个兼容代码版本先后运行在同一正式数据库上。',['发布仅执行需要的迁移','回退默认保留当前数据']),
 node('testinstance',65,390,'测试数据库实例','引擎＋当前结构＋数据集','runtime','可为空库、已有库或从快照恢复。',['SQLite／PostgreSQL 分别适配','迁移后再次验证测试结果']),
 node('snapshots',365,390,'数据快照／备份','来源＋时点＋结构＋抽取规则','runtime','独立于代码版本，复用兼容快照减少等待。',['显示新鲜度与空间需求','大规模复制提示与子集','半成品不得标记可用']),
 node('prodinstance',665,390,'正式数据库实例','业务数据持续增长','runtime','数据库实例不随应用每版重建。',['变更前风险评估与一致性备份','迁移记录不丢失','副作用后失败需恢复判断']),
 node('restore',365,555,'不兼容回退 → 独立恢复方案','暂停写入／备份／校验／切换','risk','旧代码不兼容时阻止直接回退；数据恢复需明确损失范围并再次确认。',['优先修复前进','恢复到隔离目标验证','不能只切旧镜像就报告成功'])],edges:[edge('draft','version'),edge('version','schema'),edge('draft','testenv'),edge('version','deployment'),edge('schema','prodenv'),edge('testenv','testinstance'),edge('deployment','prodenv'),edge('prodenv','prodinstance'),edge('prodinstance','snapshots','一致性备份'),edge('snapshots','testinstance','恢复／抽取'),edge('deployment','restore','不兼容时',[[455,325],[590,325],[590,593],[545,593]])]}
};
const flows={
 onboarding:{title:'创建与接入',summary:'两个入口，一套应用运行契约。工作台模板打包底座、默认流程及项目／对话快捷按钮；导入项目可只应用流程与按钮。',height:620,nodes:[
 node('template',65,35,'选择工作台模板','底座／流程／两类快捷按钮','new','空项目主动选择模板，一并生成底座配置、默认流程、项目快捷按钮和对话快捷按钮。',['初始化、开发、创建版本、发布、切换、测试数据六条流程','按钮自动关联项目流程实例','只创建配置，不自动执行']),
 node('import',665,35,'导入已有程序','本地目录／Git 仓库','existing','在现有项目开启应用能力，不要求迁移框架。',['Git 分支和子目录可配置','仓库脚本先查看再执行']),
 node('config',365,180,'确认运行与部署配置','AI 建议＋用户核对','new','准备、启动、测试、端口、健康检查、Docker 与迁移能力形成统一契约。',['支持多服务 Compose','凭据只保存引用']),
 node('check',365,330,'检查配置是否完整','命令／依赖／端口／权限','risk','不完整可保存草案，但不能标为可运行或可部署。',['缺失项固定区域提示','不伪造未配置测试结果']),
 node('fix',65,470,'补齐接入配置','保留已有项目与用户文件','existing','逐项修复缺失，不覆盖用户代码。'),
 node('ready',665,470,'生成流程与快捷按钮','项目操作区＋对话输入区','runtime','确认模板后同时生成默认流程和两类快捷按钮；已有仓库可只补流程与按钮。',['提示词默认填入，不立即发送','动作遵守版本与风险门禁','允许修改，重复应用不覆盖'])],edges:[edge('template','config'),edge('import','config'),edge('config','check'),edge('check','fix','不完整'),edge('check','ready','通过'),edge('fix','config','重新检查',[[40,508],[40,218]])]},
 development:{title:'开发与版本',summary:'聊天满意之后，先验证当前草稿，再固定代码构建镜像。版本验证通过，才成为可发布版本。',height:650,nodes:[
 node('chat',65,30,'聊天修改程序','产生新的开发草稿','existing','开发聊天只改开发代码，原正式版本继续运行。'),
 node('data',365,30,'检查测试数据库','兼容则复用，不兼容则准备','risk','数据未就绪不能运行依赖它的预览与测试。',['可迁移当前测试库或创建副本','不每次重新导入数据']),
 node('preview',665,30,'预览当前程序','标记实际代码版本','runtime','启动开发预览，人工操作检查。旧预览明确提示过期。'),
 node('test',665,200,'运行测试／人工验收','关联代码＋结构＋数据快照','new','失败回到开发，未配置测试时明确标记并应用验证策略。'),
 node('snapshot',365,200,'创建应用版本','填写版本号与说明','new','固定源代码、迁移集与接入配置，不使用可变分支作为唯一来源。'),
 node('build',65,200,'Docker 构建与验证','从固定源构建','new','构建镜像后隔离启动验证，记录镜像摘要与主机架构。'),
 node('fail',65,390,'验证失败','保存日志与失败记录','risk','不可发布。修复后形成新的构建记录，不改变历史证据。'),
 node('release',365,390,'可发布版本','镜像固定，可选择部署','runtime','后续正式发布使用同一已验证镜像。'),
 node('next',665,390,'继续聊天开发下一版','旧版本保持不变','existing','代码继续变化时当前草稿测试证据过期，但已创建版本仍可发布。'),
 node('publish',365,550,'选择环境进入发布检查','比较目标数据库及配置','new','数据库结构和环境状态变化时重新预检。')],edges:[edge('chat','data'),edge('data','preview'),edge('preview','test'),edge('test','snapshot','通过'),edge('snapshot','build'),edge('build','fail','失败'),edge('build','release','通过'),edge('release','next'),edge('release','publish'),edge('fail','chat','修复',[[30,428],[30,68]]),edge('test','chat','未通过',[[875,238],[875,135],[155,135]])]},
 data:{title:'测试数据准备',summary:'数据准备是独立任务，不随每次代码修改重复执行。先看兼容性与新鲜度，再权衡全量、子集和仅结构。',height:665,nodes:[
 node('need',65,30,'检查调试需求','代码是否改变结构？','risk','无表变更默认复用兼容测试库；旧版并行运行时按隔离要求选择实例。'),
 node('reuse',365,30,'复用现有测试库','显示结构和数据时点','runtime','陈旧提示不强制刷新；用户可按测试目的主动准备新数据。'),
 node('source',65,205,'选择数据来源与目标','种子／快照／正式副本','new','目标必须是测试环境。正式库只作源。',['空库验证初始化','复制后迁移验证升级']),
 node('assess',365,205,'评估规模与资源','容量／新鲜度／预计耗时','risk','未知估时显示未知；1 GiB／5 分钟为可配置初始提示阈值。',['空间不足为硬阻塞','不把过期快照当作最新数据']),
 node('subset',665,205,'大数据量选择','全量／关联子集／仅结构','new','按业务实体及关联关系抽取；不能逐表任意截断。'),
 node('prepare',365,390,'复制 → 恢复 → 处理','一致性快照／脱敏／关闭副作用','new','进度按实际适配能力报告，失败半成品不能供测试使用。',['凭据不复制','真实通知与定时任务关闭','只在支持时声明断点续传']),
 node('migration',665,390,'迁移并校验结构','升级测试或隔离实例','risk','应用目标迁移集并验证完整性，记录快照与迁移版本。'),
 node('ready',665,555,'数据就绪 → 预览测试','旧测试证据失效','runtime','新数据和结构就绪后才能验证当前代码。'),
 node('failed',65,390,'失败／取消','清理或隔离临时实例','risk','保留原因，明确重新开始范围；原正式库不受影响。')],edges:[edge('need','reuse','兼容'),edge('need','source','需准备'),edge('source','assess'),edge('assess','subset','超阈值／空间不足'),edge('assess','prepare','条件满足'),edge('subset','prepare','调整后重新核验'),edge('prepare','migration'),edge('migration','ready'),edge('prepare','failed','失败／取消'),edge('reuse','ready','继续使用',[[455,145],[890,145],[890,593],[845,593]])]},
 publish:{title:'版本发布',summary:'先评估风险再执行。无结构变更可保留旧服务；高风险迁移必须定义维护窗口与数据库恢复方案。',height:800,nodes:[
 node('version',65,25,'选择版本与目标环境','不可变镜像／配置修订','new','核对镜像架构、主机连通、域名及操作权限。'),
 node('risk',365,25,'目标数据库风险预检','规模／锁／重写／空间／兼容','risk','基于实际目标、工具规则和演练证据。目标变化后重新评估。'),
 node('blocked',665,25,'存在硬阻塞或未知方案','补齐检查与恢复能力','risk','空间不足、迁移不一致或缺必要恢复方案时不能强行忽略。'),
 node('plan',365,190,'确认发布方案','平滑切换或维护窗口','new','高风险需要明确接受写入暂停及恢复方案。'),
 node('backup',365,350,'创建并验证备份','记录可恢复时点','new','环境操作互斥；备份失败终止后续迁移。'),
 node('migrate',665,350,'迁移或跳过无变更','记录实际数据库状态','risk','不能把迁移当作总能自动回滚的事务；副作用失败单独判断。'),
 node('start',665,510,'启动镜像与健康检查','不从源码重新构建','runtime','确认服务就绪与结构兼容后才切流。'),
 node('switch',365,510,'切换域名并验证','更新正式版本指针','runtime','验证正式入口，保存部署记录与之前的部署引用。'),
 node('recover',65,510,'失败后的恢复判断','迁移是否改变数据库？','risk','无不兼容变更可保留旧服务；已改库时可能需要维护及恢复，不能虚报旧版可用。'),
 node('done',365,690,'发布成功','继续开发或回退','runtime','日志、镜像、配置和迁移结果可追溯。')],edges:[edge('version','risk'),edge('risk','blocked','阻塞'),edge('risk','plan','可执行'),edge('plan','backup'),edge('backup','migrate'),edge('migrate','start'),edge('start','switch','健康'),edge('switch','done'),edge('switch','recover','入口异常'),edge('migrate','recover','失败',[[755,465],[155,465]]),edge('start','recover','不健康',[[755,635],[155,635],[155,586]])]},
 rollback:{title:'版本回退',summary:'回退默认保留业务数据；旧代码与当前结构不兼容时，数据恢复必须单独制定、确认和执行。',height:750,nodes:[
 node('select',365,25,'选择历史版本','检查镜像与配置是否保留','new','回退新增部署记录，原版本和原部署历史不变。'),
 node('compat',365,175,'检查当前结构兼容性','声明＋迁移记录＋验证证据','risk','未知与不兼容都不能显示为可直接回退。'),
 node('code',65,335,'仅回退程序','保留当前业务数据','runtime','启动历史镜像，健康检查通过再切换入口。'),
 node('block',665,175,'禁止直接回退','修复前进／验证恢复方案','risk','先解释旧程序为什么不能使用当前数据库。'),
 node('restore',665,335,'独立确认数据恢复','显示备份时点与损失范围','risk','与程序回退分开确认，明确备份之后的新增数据可能丢失。'),
 node('recovery',665,500,'暂停写入并隔离恢复','先备份当前库，再恢复校验','new','仅经确认的恢复流程才能改变业务数据，需有维护权限。',['先在隔离实例校验','数据与文件一致性处理','失败保留维护状态']),
 node('health',365,500,'程序与数据健康检查','验证目标版本实际可用','new','恢复失败不能报告回退成功，也不能直接清理原实例。'),
 node('done',365,640,'切换入口并记审计','完成回退／恢复部署','runtime','记录版本、结构、配置、恢复点与操作者。')],edges:[edge('select','compat'),edge('compat','code','兼容'),edge('compat','block','未知／不兼容'),edge('block','restore','选择恢复方案'),edge('restore','recovery','再次确认'),edge('recovery','health'),edge('code','health'),edge('health','done','通过')]}
};
const isArchitecture=document.body.dataset.diagram==='architecture',views=isArchitecture?architecture:flows;
let current=new URLSearchParams(location.search).get('view');if(!views[current])current=Object.keys(views)[0];let selected='',zoom=1;
const colors={existing:['#f4f5f8','#dce0e6'],new:['#edf5ff','#bdd8f7'],runtime:['#eef7f1','#c5e3ce'],risk:['#fff5e5','#ecd7b5']};
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function detail(n){selected=n.id;document.querySelectorAll('.diagram-node').forEach(g=>g.classList.toggle('selected',g.dataset.id===n.id));document.getElementById('node-detail').innerHTML=`<label>节点说明</label><h2>${xml(n.title)}</h2><span class="badge ${n.kind==='risk'?'amber':n.kind==='new'?'blue':n.kind==='runtime'?'green':''}">${xml(n.sub)}</span><p class="section-gap">${xml(n.detail)}</p>${n.items.length?`<ul>${n.items.map(i=>`<li>${xml(i)}</li>`).join('')}</ul>`:''}<div class="diagram-related"><a href="index.html">在交互原型中体验 ↗</a></div>`;}
function wrapLabel(text,limit){const lines=[''];let used=0;for(const c of text){const size=/[\u0000-\u00ff]/.test(c)?.55:1;if(used+size>limit){lines.push('');used=0;}lines[lines.length-1]+=c;used+=size;}return lines;}
function nodeText(n){const lines=wrapLabel(n.title,12).slice(0,2);const sub=wrapLabel(n.sub,14);return `<text x="${n.x+15}" y="${n.y+(lines.length>1?22:29)}" fill="#233247" font-size="12" font-weight="600">${lines.map((line,i)=>`<tspan x="${n.x+15}" dy="${i?17:0}">${xml(line)}</tspan>`).join('')}</text><text x="${n.x+15}" y="${n.y+(lines.length>1?60:52)}" fill="#647185" font-size="11">${xml(sub[0]+(sub.length>1?'…':''))}</text>`;}
function render(){const v=views[current],w=180,h=76;document.getElementById('diagram-tabs').innerHTML=Object.entries(views).map(([id,x])=>`<button role="tab" aria-controls="diagram-board" aria-selected="${id===current}" class="${id===current?'active':''}" data-view="${id}">${xml(x.title)}</button>`).join('');document.getElementById('diagram-summary').textContent=v.summary;
const paths=v.edges.map((e,i)=>{const a=v.nodes.find(n=>n.id===e.from),b=v.nodes.find(n=>n.id===e.to);let p;
 if(e.via){const first=e.via[0],last=e.via[e.via.length-1];const anchor=(n,q)=>Math.abs(q[0]-(n.x+w/2))>Math.abs(q[1]-(n.y+h/2))?[q[0]<n.x+w/2?n.x:n.x+w,n.y+h/2]:[n.x+w/2,q[1]<n.y+h/2?n.y:n.y+h];p=[anchor(a,first),...e.via,anchor(b,last)];}
 else if(a.y===b.y){p=a.x<b.x?[[a.x+w,a.y+h/2],[b.x,b.y+h/2]]:[[a.x,a.y+h/2],[b.x+w,b.y+h/2]];}
 else {const down=b.y>a.y;const sy=down?a.y+h:a.y,ey=down?b.y:b.y+h;const mid=(sy+ey)/2;p=[[a.x+w/2,sy],[a.x+w/2,mid],[b.x+w/2,mid],[b.x+w/2,ey]];}
 const d=p.map((q,j)=>(j?'L':'M')+q.join(',')).join(' ');const middle=p[Math.floor((p.length-1)/2)],next=p[Math.min(Math.floor((p.length-1)/2)+1,p.length-1)];const labelHalf=(e.label.length*11.2+10)/2;const tx=Math.max(labelHalf+8,Math.min(930-labelHalf-8,(middle[0]+next[0])/2)),ty=(middle[1]+next[1])/2-7;
 return `<path d="${d}" fill="none" stroke="#a1aebd" stroke-width="1.4" marker-end="url(#arrow)"/>${e.label?`<g><rect x="${tx-e.label.length*5.6-5}" y="${ty-11}" width="${e.label.length*11.2+10}" height="18" rx="4" fill="#fff"/><text x="${tx}" y="${ty+2}" text-anchor="middle" fill="#667487" font-size="11">${xml(e.label)}</text></g>`:''}`;
}).join('');
document.getElementById('diagram-board').innerHTML=`<svg viewBox="0 0 930 ${v.height}" role="img" aria-label="${xml(v.title)}，可选择节点查看说明"><title>${xml(v.title)}</title><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a1aebd"/></marker></defs>${paths}${v.nodes.map(n=>`<g class="diagram-node ${selected===n.id?'selected':''}" data-id="${n.id}" tabindex="0" role="button" aria-label="${xml(n.title)}"><rect x="${n.x}" y="${n.y}" width="${w}" height="${h}" rx="10" fill="${colors[n.kind][0]}" stroke="${colors[n.kind][1]}"/>${nodeText(n)}</g>`).join('')}</svg>`;
 document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{current=b.dataset.view;selected='';zoom=1;history.replaceState(null,'','?view='+current);render();}));document.querySelectorAll('.diagram-node').forEach(g=>{const choose=()=>detail(v.nodes.find(n=>n.id===g.dataset.id));g.addEventListener('click',choose);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}});});detail(v.nodes.find(n=>n.id===selected)||v.nodes[0]);applyZoom();}
function applyZoom(){const svg=document.querySelector('#diagram-board svg');svg.style.width=zoom*100+'%';document.getElementById('zoom-label').textContent=Math.round(zoom*100)+'%';document.getElementById('zoom-out').disabled=zoom<=.75;document.getElementById('zoom-in').disabled=zoom>=1.75;}
document.getElementById('zoom-in').onclick=()=>{zoom=Math.min(1.75,zoom+.25);applyZoom();};document.getElementById('zoom-out').onclick=()=>{zoom=Math.max(.75,zoom-.25);applyZoom();};document.getElementById('zoom-reset').onclick=()=>{zoom=1;applyZoom();};render();
