'use strict';
// A design-only manifest: no commands, credentials, or deployment executors.
const workbenchBundle = {
 id:'admin-workbench', version:'1.0.0', name:'后台应用工作台',
 workflows:[
  {id:'initialize',name:'初始化应用',steps:['生成代码底座','安装依赖','初始化测试库','启动预览']},
  {id:'develop',name:'开发验证',steps:['需求分析','修改代码','预览与测试','代码审核']},
  {id:'version',name:'创建版本',steps:['固定代码','Docker 构建','镜像验证','保存不可变版本']},
  {id:'publish',name:'发布上线',steps:['选择版本与环境','风险评估','备份与迁移','部署与健康检查','确认切换入口']},
  {id:'switch',name:'切换／回退版本',steps:['选择已有版本','检查数据库兼容性','启动与验证','确认切换入口']},
  {id:'data',name:'准备测试数据',steps:['选择来源','容量评估','复制与恢复','脱敏与迁移校验']}
 ],
 projectButtons:[
  {id:'initialize',label:'初始化应用',target:'initialize'},
  {id:'develop',label:'开发验证',target:'develop'},
  {id:'version',label:'创建版本',target:'version'},
  {id:'publish',label:'发布上线',target:'publish'},
  {id:'switch',label:'切换版本',target:'switch'},
  {id:'data',label:'准备测试数据',target:'data'}
 ],
 chatButtons:[
  {id:'requirements',label:'梳理需求',kind:'prompt',prompt:'请先梳理当前应用的需求、页面和验收标准，形成方案后再修改。'},
  {id:'implement',label:'继续实现',kind:'prompt',prompt:'请根据已确认的需求继续实现当前应用，并说明修改范围与验证方式。'},
  {id:'review',label:'检查本次修改',kind:'prompt',prompt:'请检查当前代码变更，重点说明测试情况、数据库迁移风险和发布注意事项。'},
  {id:'preview',label:'启动预览',kind:'action',target:'preview'},
  {id:'test',label:'运行测试',kind:'action',target:'test'}
 ]
};
function bundleCounts(){return `${state.bundleInstalled?'已生成':'将生成'} ${workbenchBundle.workflows.length} 条流程 · ${workbenchBundle.projectButtons.length} 个项目按钮 · ${workbenchBundle.chatButtons.length} 个对话按钮`;}
function bundlePanel(){return `<section class="panel" id="template-package"><div class="panel-title"><h2>工作台模板包</h2>${badge(state.bundleInstalled?'已应用 v1.0.0':'待应用',state.bundleInstalled?'green':'blue')}</div><p class="caption">代码底座、运行配置、默认流程、项目快捷按钮、对话快捷按钮一起交付。${state.source==='template'?'空项目主动选择后生成，保持空项目则不创建流程。':'导入项目只补运行配置与流程按钮，不覆盖原代码。'}</p><div class="bundle-summary"><strong>${bundleCounts()}</strong>${action('inspect-bundle','查看流程与按钮配置')}</div><div class="table-scroll"><table><thead><tr><th>默认流程</th><th>步骤预览</th><th>项目按钮</th></tr></thead><tbody>${workbenchBundle.workflows.map((flow,i)=>`<tr><td>${flow.name}</td><td>${flow.steps.join(' → ')}</td><td>${badge(workbenchBundle.projectButtons[i].label,'blue')}</td></tr>`).join('')}</tbody></table></div><div class="bundle-chat-preview"><label>消息对话快捷按钮</label><div class="actions">${workbenchBundle.chatButtons.map(b=>badge(b.label,b.kind==='prompt'?'violet':'blue')).join('')}</div><p class="caption">提示词按钮默认填入输入框，确认后发送；动作按钮复用已有验证与发布门禁。</p></div><div class="actions">${action('apply-bundle',state.bundleInstalled?'检查并补齐模板内容':'应用工作台模板','primary',busy())}${!state.bundleInstalled&&state.scenario==='empty'?action('keep-empty','保持空项目'):''}</div><p class="caption section-gap">应用只生成配置与流程，不自动执行。重复应用按模板引用补齐缺失项，不覆盖用户修改。</p></section>`;}
function projectQuickButtons(){if(!state.bundleInstalled)return '';return `<section class="project-quick-bar" aria-label="模板项目快捷按钮"><div><label>项目快捷操作</label><small>来自「${workbenchBundle.name}」模板</small></div><div class="actions">${workbenchBundle.projectButtons.map(b=>action('bundle-project-'+b.id,b.label,'',busy())).join('')}${action('inspect-bundle','配置')}</div></section>`;}
function chatQuickButtons(){if(!state.bundleInstalled)return '';return `<div class="chat-quick-bar" aria-label="模板对话快捷按钮">${workbenchBundle.chatButtons.map(b=>action('bundle-chat-'+b.id,b.label,'',busy())).join('')}</div>`;}
function installBundle(){
 if(busy())return toast('请等待当前环境操作完成。');
 const already=state.bundleInstalled;
 state.bundleInstalled=true;
 for(const flow of workbenchBundle.workflows){if(!state.bundleFlows.some(f=>f.id===flow.id))state.bundleFlows.push({...flow,steps:[...flow.steps]});}
 state.bundleProjectButtons=[...new Set([...state.bundleProjectButtons,...workbenchBundle.projectButtons.map(b=>b.id)])];
 state.bundleChatButtons=[...new Set([...state.bundleChatButtons,...workbenchBundle.chatButtons.map(b=>b.id)])];
 render();toast(already?'已检查模板引用，没有重复创建或覆盖配置。':'模板配置已生成（模拟），尚未执行流程。');
}
function inspectBundle(){modal('工作台模板 · 流程与快捷按钮',`<p class="caption">${workbenchBundle.id}@${workbenchBundle.version} · ${bundleCounts()}。按钮通过模板内引用关联流程，应用后绑定项目自己的实例标识。</p><h3>项目按钮 → 对应流程</h3><div class="table-scroll"><table><tbody>${state.bundleFlows.map(flow=>`<tr><td>${esc(workbenchBundle.projectButtons.find(b=>b.target===flow.id)?.label||flow.name)}</td><td><input data-flow-name="${flow.id}" aria-label="${esc(flow.name)}流程名称" value="${esc(flow.name)}"><small>${flow.steps.map(esc).join(' → ')}</small></td></tr>`).join('')||'<tr><td>应用模板后生成项目流程。</td></tr>'}</tbody></table></div><h3 class="section-gap">对话按钮的触发方式</h3><div class="table-scroll"><table><tbody>${workbenchBundle.chatButtons.map(b=>`<tr><td>${b.label}</td><td>${b.kind==='prompt'?'填入提示词，不立即发送':b.target==='preview'?'检查代码与测试库后启动预览':'要求当前预览及测试数据就绪'}</td></tr>`).join('')}</tbody></table></div><div class="notice amber">发布与版本切换打开版本选择和风险检查；不会直接从聊天静默执行正式变更。模板不携带真实密钥或正式环境数据。</div>`,action('close-modal','关闭')+(state.bundleInstalled?action('save-bundle-names','保存流程名称','primary'):''));}
function bundleAction(a){
 if(a==='apply-bundle'){installBundle();return true;}
 if(a==='inspect-bundle'){inspectBundle();return true;}
 if(a==='save-bundle-names'){
  const inputs=[...document.querySelectorAll('[data-flow-name]')];
  if(inputs.some(i=>!i.value.trim()||/\s/.test(i.value.trim()))){toast('流程名称不能为空且不能包含空白字符。');inputs.find(i=>!i.value.trim()||/\s/.test(i.value.trim())).focus();return true;}
  inputs.forEach(i=>state.bundleFlows.find(f=>f.id===i.dataset.flowName).name=i.value.trim());close();render();toast('已保存项目流程名称，重新应用模板会保留修改。');return true;
 }
 if(a==='keep-empty'){state.page='connect';state.source='directory';render();toast('已保持空项目，没有生成流程或快捷按钮。');return true;}
 if(a.startsWith('bundle-chat-')){
  const button=workbenchBundle.chatButtons.find(b=>b.id===a.slice(12));if(!button||busy())return true;
  if(button.kind==='prompt'){const input=$('#chat-input');input.value=button.prompt;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();toast('提示词已填入，请确认后发送。');}
  else handle(button.target);
  return true;
 }
 if(a.startsWith('bundle-project-')){
  const id=a.slice(15);if(busy())return true;
  if(id==='initialize'){modal('初始化应用流程',`<p>${workbenchBundle.workflows[0].steps.join(' → ')}</p><div class="notice">本原型只展示流程配置，不生成或安装真实程序。</div>`);}
  if(id==='develop'){navigate('develop');handle('bundle-chat-requirements');}
  if(id==='version')createVersion();
  if(id==='publish'){navigate('versions');if(state.version)publishCheck();else toast('先完成测试并创建版本，再执行发布流程。');}
  if(id==='switch'){navigate('versions');toast('在历史版本中选择目标版本，随后检查数据库兼容性。');}
  if(id==='data')navigate('data');
  return true;
 }
 return false;
}
