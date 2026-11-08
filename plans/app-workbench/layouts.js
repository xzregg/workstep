(() => {
 const $=s=>document.querySelector(s), esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const integrated=document.body.dataset.layout==='integrated';
 let exportEnabled=false,ownerEnabled=false;
 let environment=document.body.classList.contains('using-app')?'production':'draft';
 let running=true,workbenchDir='.',sharedVersion=null;
 let changed=false, production='v1.2.0', preview='draft', current='main';
 const versions=[{tag:'v1.2.0',filter:false,commit:'ac72e91'},{tag:'v1.1.0',filter:false,commit:'70bf291'}];
 const sessions={main:{draft:'给客户列表加状态筛选',messages:[['你','客户管理页面已经能用了，接下来完善一下。'],['助手','可以继续描述修改需求，右侧查看应用。']]},other:{draft:'',messages:[['助手','这里保留需求讨论；修改仍作用于同一个项目应用。']]}};
 if(integrated){
  sessions.main={draft:'给客户列表加状态筛选',messages:[['你','先做 A 功能：客户筛选。'],['助手','在这个对话里继续修改客户筛选，右侧预览项目应用。']]};
  sessions.other={draft:'增加客户导出按钮',messages:[['你','这个对话负责 B 功能：客户导出。']]};
  sessions.third={draft:'给客户增加负责人列',messages:[['你','这个对话负责 C 功能：分配负责人。']]};
 }
 const sessionNames={main:'A 客户筛选',other:'B 客户导出',third:'C 分配负责人'};
 const notice=t=>$('#notice').textContent=t;
 const open=()=>{document.body.classList.remove('workbench-closed');document.body.classList.add('preview-open');document.body.classList.remove('preview-hidden');};
 function renderChat(){ $('#messages').innerHTML=sessions[current].messages.map(([who,text])=>`<div class="message ${who==='你'?'user':''}"><strong>${who}</strong>${esc(text)}</div>`).join(''); $('#message').value=sessions[current].draft; $('#session-name').textContent=integrated?sessionNames[current]:(current==='main'?'客户列表改进':'整理需求'); document.querySelectorAll('.session').forEach(b=>b.classList.toggle('active',b.dataset.action===`session-${current}`)); }
 function renderPreview(){
  const effectivePreview=integrated&&environment==='production'?production:preview;
  const activeRunning=integrated&&environment==='production'?true:running;
  $('#production').textContent=`正式 ${production}`;
  $('#version').innerHTML=`<option value="draft">当前草稿${changed||exportEnabled||ownerEnabled?'（有修改）':''}</option>`+versions.map(v=>`<option value="${v.tag}">${v.tag}${v.tag===production?'（正式版本）':''}</option>`).join(''); $('#version').value=effectivePreview;
  if(integrated){$('#version').disabled=environment==='production';$('[data-action="environment-draft"]').setAttribute('aria-pressed',String(environment==='draft'));$('[data-action="environment-production"]').setAttribute('aria-pressed',String(environment==='production'));}
  if(integrated){$('[data-action="share"]').disabled=!activeRunning;$('[data-action="start"]').textContent=activeRunning?'重新启动':'启动应用';$('[data-action="start"]').disabled=environment==='production';}
  const shownVersion=versions.find(v=>v.tag===effectivePreview);
  const showExport=effectivePreview==='draft'?exportEnabled:shownVersion?.exportEnabled;
  const showOwner=effectivePreview==='draft'?ownerEnabled:shownVersion?.ownerEnabled;
  const filter=effectivePreview==='draft'?changed:shownVersion.filter;
  $('#preview-state').textContent=preview==='draft'?`开发预览 / ${changed||exportEnabled||ownerEnabled?'未发布修改':'与 v1.2.0 一致'} / 测试数据`:`版本预览 ${preview} / 隔离测试数据 / 不切换正式版本`;
  const appMarkup=`<div class="app-nav"><strong>客户管理系统</strong><span>客户</span><span>概览</span></div><div class="app-content"><div class="app-title"><h3>客户列表</h3>${showExport?'<button data-action="export-demo">导出客户</button>':'<small>演示账号</small>'}</div><div class="metrics"><div><small>客户总数</small><strong>128</strong></div><div><small>本月新增</small><strong>16</strong></div><div><small>合作客户</small><strong>42</strong></div></div>${filter?'<select class="filter" aria-label="客户状态"><option>全部状态</option><option>合作中</option><option>待跟进</option></select>':''}<table><thead><tr><th>客户名称</th><th>联系人</th><th>状态</th>${showOwner?'<th>负责人</th>':''}</tr></thead><tbody><tr data-status="合作中"><td>星河商贸</td><td>演示联系人 A</td><td>合作中</td>${showOwner?'<td>演示负责人</td>':''}</tr><tr data-status="待跟进"><td>青禾设计</td><td>演示联系人 B</td><td>待跟进</td>${showOwner?'<td>待分配</td>':''}</tr><tr data-status="合作中"><td>远山科技</td><td>演示联系人 C</td><td>合作中</td>${showOwner?'<td>演示负责人</td>':''}</tr></tbody></table></div>`;
  if(integrated){
   $('#preview-state').textContent=environment==='production'?'运行中 / 正式数据库':(activeRunning?'运行中 / 测试数据库':'尚未启动');
   const frame=$('#workbench-frame');
   frame.srcdoc=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
   :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;color:#20242c;background:#fff;font:14px system-ui,sans-serif}.app-nav{display:flex;gap:24px;padding:22px 30px;border-bottom:1px solid #e3e5e9}.app-content{padding:30px}.app-title{display:flex;justify-content:space-between;align-items:center}h3{font-size:20px}small{color:#697180;font-size:12px}.metrics{display:flex;gap:70px;margin:25px 0 35px}.metrics strong{display:block;font-size:20px;margin-top:10px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:16px 8px;text-align:left;border-bottom:1px solid #e3e5e9}th{color:#697180;font-weight:400}select,button{font:inherit;padding:8px 12px;background:#fff;border:1px solid #e3e5e9;border-radius:6px}.filter{margin-bottom:16px}@media(max-width:600px){.app-content{padding:14px}.metrics{gap:25px}td,th{padding:12px 4px;font-size:12px}}
   </style><body>${activeRunning?appMarkup:''}<script>
   document.querySelector('.filter')?.addEventListener('change',e=>document.querySelectorAll('[data-status]').forEach(row=>row.hidden=e.target.value!=='全部状态'&&row.dataset.status!==e.target.value));
   document.querySelector('[data-action="export-demo"]')?.addEventListener('click',e=>{e.target.textContent='已模拟导出 3 条';});
   <\/script></body></html>`;
   return;
  }
  $('#preview').innerHTML=appMarkup;
  $('.filter')?.addEventListener('change',e=>document.querySelectorAll('[data-status]').forEach(row=>row.hidden=e.target.value!=='全部状态'&&row.dataset.status!==e.target.value));
 }
 function panel(title,body,action,label){$('#action-panel').hidden=false;$('#action-panel').innerHTML=`<h3>${title}</h3>${body}<div class="panel-actions">${action?`<button class="primary" data-action="${action}">${label}</button>`:''}<button data-action="close">关闭</button></div>`;}
 $('#message').addEventListener('input',e=>sessions[current].draft=e.target.value);
 $('#version').addEventListener('change',e=>{preview=e.target.value;if(integrated)running=false;renderPreview();});
 document.addEventListener('click',e=>{
  const action=e.target.closest('[data-action]')?.dataset.action;if(!action)return;
  if(action.startsWith('session-')){document.body.classList.remove('using-app');sessions[current].draft=$('#message').value;current=action.slice(8);renderChat();return;}
  switch(action){
   case 'close-chat':document.body.classList.add('using-app');if(!document.body.classList.contains('has-changes')){environment='production';renderPreview();}break;
   case 'send':{const text=$('#message').value.trim();if(!text)return;let result='客户列表已增加状态筛选';
    if(integrated&&current==='other'){exportEnabled=true;result='已增加客户导出按钮';}
    else if(integrated&&current==='third'){ownerEnabled=true;result='已增加负责人列';}
    else changed=true;
    document.body.classList.add('has-changes');environment='draft';sessions[current].messages.push(['你',text],['助手',`模拟修改完成：${result}。项目草稿包含其他对话已完成的修改。`]);sessions[current].draft='';preview='draft';renderChat();renderPreview();open();notice(integrated?'已模拟当前对话的功能修改；各对话共用项目草稿，未调用模型。':'演示固定模拟“新增客户状态筛选”，未调用模型。');break;}
   case 'environment-draft':environment='draft';renderPreview();break;
   case 'environment-production':environment='production';renderPreview();break;
   case 'start':running=true;renderPreview();notice(`已模拟启动 ${preview==='draft'?'当前草稿':preview}，使用测试数据库。`);break;
   case 'share':if(environment==='draft'&&!running)break;const sharing=environment==='production'?production:preview;panel('分享应用',`<p>运行版本：${esc(sharing==='draft'?'当前开发草稿（后续修改会变化）':sharing)}</p><p>访问权限：网关认证，仅已授权成员可访问</p><small>共享当前运行实例；停止实例后链接不可访问。</small><label>模拟访问地址<input readonly value="https://gateway.example.test/w/customer/${sharing==='draft'?'dev':esc(sharing)}"></label>`,'confirm-share','启用分享（模拟）');break;
   case 'confirm-share':sharedVersion=environment==='production'?production:preview;$('#action-panel').hidden=true;notice(`已模拟开启 ${sharedVersion==='draft'?'开发草稿':sharedVersion} 的网关认证分享，未创建真实公网链接。`);break;
   case 'save-workbench':{const dir=$('#workbench-dir').value.trim();if(!dir||dir.split('/').includes('..')||dir.startsWith('/'))return;workbenchDir=dir;running=false;$('#action-panel').hidden=true;renderPreview();notice('应用目录已保存（模拟）；真实接入须验证该目录为 Git 仓库根目录并识别启动命令。');break;}
   case 'toggle-workbench':document.body.classList.toggle('workbench-closed');break;
   case 'export-demo':notice('模拟导出完成：3 条测试客户记录。');break;
   case 'open':case 'show-preview':open();break;
   case 'show-chat':document.body.classList.remove('preview-open');$('#message').focus();break;
   case 'refresh':renderPreview();notice('已刷新模拟预览');break;
   case 'close':$('#action-panel').hidden=true;break;
   case 'test':panel('预览与测试','<p>检查当前草稿，使用现有测试数据库。</p><p>模拟结果：页面可打开，客户筛选通过；没有表结构变更。</p>',null);break;
   case 'create':panel('创建新版本','<p>将项目当前草稿保存为固定版本，包含所有对话已完成的修改。</p><label>版本标签<input id="tag" value="v1.3.0" autocomplete="off"></label><small id="tag-error">Git 提交 → 固定 Tag → 构建 Docker 镜像 → 保存版本</small>','confirm-create','创建版本（模拟）');validateTag();break;
   case 'confirm-create':{const tag=$('#tag').value.trim();if(!validTag(tag))return;versions.unshift({tag,filter:changed,exportEnabled,ownerEnabled,commit:'d81c42a'});$('#action-panel').hidden=true;renderPreview();notice(`已模拟创建 ${tag}：Git Tag、提交及 Docker 镜像已关联，尚未部署。`);break;}
   case 'deploy':panel('部署版本',`<label>部署版本<select id="deploy-tag">${versions.map(v=>`<option>${v.tag}</option>`).join('')}</select></label><p>目标：正式环境<br>域名：crm.example.test<br>数据库：沿用正式库，本例无结构变更</p><small>使用该版本已构建的镜像。健康检查通过后切换流量。</small>`,'confirm-deploy','部署（模拟）');break;
   case 'confirm-deploy':production=$('#deploy-tag').value;$('#action-panel').hidden=true;renderPreview();notice(`模拟部署完成：${production}，镜像启动、健康检查、流量切换通过。`);break;
   case 'rollback':{const others=versions.filter(v=>v.tag!==production);panel('回滚版本',`<label>回滚到<select id="rollback-tag">${others.map(v=>`<option>${v.tag}</option>`).join('')}</select></label><p>本例数据库结构兼容，可切回旧镜像。保留当前正式数据。</p><small>若结构不兼容，阻止直接回滚并展示修复方案。</small>`,'confirm-rollback','回滚（模拟）');break;}
   case 'confirm-rollback':production=$('#rollback-tag').value;$('#action-panel').hidden=true;renderPreview();notice(`模拟回滚完成：${production}，正式数据保留。`);break;
   case 'history':panel('版本记录',versions.map(v=>`<div class="record"><strong>${v.tag}</strong> ${v.tag===production?'正式运行':''}<small>Git Tag ${v.tag} / 提交 ${v.commit}</small><small>对应固定镜像，数据库结构 s1</small><button data-action="version-${v.tag}">预览这个版本</button></div>`).join(''),null);break;
   case 'setup':if(integrated){panel('项目的应用配置',`<p>应用是当前项目的可选属性。</p><label>应用目录（相对项目根目录）<input id="workbench-dir" value="${esc(workbenchDir)}" placeholder=". 或 apps/customer"></label><small>“.” 使用项目根目录；也可指定子目录中的独立 Git 仓库。版本 Tag 从此仓库读取。</small><p>启动方式：从该目录分析并配置<br>共享入口：网关认证<br>测试数据库：复用兼容测试库</p><details><summary>模板流程</summary><p>预览与测试、创建版本、部署上线、回滚版本。每个项目对话均可触发。</p></details>`,'save-workbench','保存配置');break;}panel('应用设置','<p>已启用：后台管理模板</p><p>已建立流程：预览与测试、创建版本、部署上线、回滚版本。</p><details><summary>启动、部署与数据库</summary><p>启动方式：从项目自动识别<br>部署方式：Docker<br>业务数据库：PostgreSQL<br>测试数据：复用现有测试库</p><a href="onboarding.html">查看高级接入原型 ↗</a></details><p><small>空项目选择模板后一起建立；已有项目先分析再补齐缺失配置。</small></p>',null);break;
   default:if(action.startsWith('version-')){preview=action.slice(8);if(integrated)running=false;renderPreview();open();$('#action-panel').hidden=true;}
  }
 });
 function validTag(tag){return /^v\d+\.\d+\.\d+$/.test(tag)&&!versions.some(v=>v.tag===tag);}
 function validateTag(){const ok=validTag($('#tag').value.trim());$('[data-action="confirm-create"]').disabled=!ok;$('#tag-error').textContent=ok?'Git 提交 → 固定 Tag → 构建 Docker 镜像 → 保存版本':'请输入未使用的版本号，例如 v1.3.0';}
 document.addEventListener('input',e=>{if(e.target.id==='tag')validateTag();if(e.target.id==='workbench-dir'){const dir=e.target.value.trim();$('[data-action="save-workbench"]').disabled=!dir||dir.startsWith('/')||dir.split('/').includes('..');}});
 document.addEventListener('keydown',e=>{if(e.key==='Escape')$('#action-panel').hidden=true;});
 document.addEventListener('app-configured',e=>{workbenchDir=e.detail.directory;running=false;renderPreview();});
 renderChat();renderPreview();
})();
