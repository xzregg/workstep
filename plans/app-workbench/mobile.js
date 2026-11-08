(() => {
 const $=s=>document.querySelector(s);
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const nav=$('#mobile-navigation'), panel=$('#action-panel');
 let returnFocus=null, editing=false, dirty=false;
 const scenario=new URLSearchParams(location.search).get('scenario');
 const empty=scenario==='empty';
 let config={enabled:!empty&&scenario!=='import',directory:'.',template:empty?'admin':'existing',database:'SQLite',frontend:'React',framework:'node'};
 const labels={admin:'后台管理应用',blank:'空白应用',existing:'接入已有应用'};
 function navClose(){nav.hidden=true;nav.setAttribute('aria-hidden','true');document.body.classList.remove('navigation-open');returnFocus?.focus();}
 function summary(){const template=$('#app-template').value,db=$('#app-database').value;
  $('#template-summary').textContent=template==='existing'?'分析 Git 仓库、启动脚本和 CI/CD；保留现有框架与数据库配置。':`Node.js + Fastify + ${db}，前端 ${$('#app-frontend').value}。${template==='admin'?'包含登录、角色权限与管理列表。':'仅生成可运行的前后端骨架。'}`;
  $('#stack-options').hidden=template==='existing';
  const dir=$('#app-directory').value.trim();
  $('[data-action="save-app"]').disabled=!dir||dir.startsWith('/')||dir.split('/').includes('..');
  $('#directory-error').textContent=dir&&!dir.startsWith('/')&&!dir.split('/').includes('..')?'':'填写项目内的目录，例如 . 或 apps/customer';
 }
 function settings(){editing=false;dirty=false;panel.hidden=false;panel.innerHTML='<div class="settings-heading"><h3>配置</h3><button data-action="close">关闭</button></div><div class="settings-tab">常规</div><p>当前项目：客户管理</p><p class="muted">应用模板和框架在添加项目或初始化项目时选择。</p>'; }
 function addProject(){editing=false;dirty=false;panel.hidden=false;panel.innerHTML='<div class="settings-heading"><h3>添加项目</h3><button data-action="close">关闭</button></div><p>选择项目来源</p><div class="project-paths"><button data-action="new-app-project"><strong>新建应用项目</strong><small>空目录 → 选择应用模板</small></button><button data-action="existing-app-project"><strong>导入已有项目</strong><small>本地目录 / Git 仓库 → 分析接入</small></button><button data-action="plain-project">普通项目，暂不启用应用</button></div>';}
 function initialize(){editing=true;dirty=false;panel.hidden=false;
  panel.innerHTML=`<div class="settings-heading"><h3>初始化应用</h3><button data-action="close">关闭</button></div><p class="muted">项目的可选能力，可稍后再配置。</p><div class="settings-scroll"><h3>应用</h3><p class="muted">${config.enabled?'已配置，可调整目录和接入方式。':'选择一个目录作为应用。'}</p><details class="app-advanced"><summary>高级设置</summary><label>应用目录<input id="app-directory" value="${esc(config.directory)}" placeholder=". 或 apps/customer"></label><small id="directory-error"></small></details><label>应用用途<select id="app-template"><option value="admin">后台管理应用</option><option value="blank">空白应用</option><option value="existing">接入已有应用</option></select></label><details class="app-advanced"><summary>框架、数据库与基础组件</summary><div id="stack-options"><label>应用框架<select id="app-framework"><option value="node">Node.js + TypeScript / Fastify</option></select></label><label>数据库<select id="app-database"><option>SQLite</option><option>PostgreSQL</option></select></label><label>前端<select id="app-frontend"><option>React</option><option>Vue</option></select></label></div><p id="template-summary"></p><small>运行环境优先复用 WorkStep 已检测到的 Python / Node；缺少所需版本时提示安装。应用依赖单独隔离。</small><fieldset class="app-components"><legend>基础组件</legend><label><input id="component-auth" type="checkbox" checked> 用户登录</label><label><input id="component-rbac" type="checkbox" checked> 角色与权限（RBAC）</label><label><input id="component-stats" type="checkbox"> 统计看板</label><small>新应用生成标准组件；已有应用先分析接口，生成适配方案后再接入。</small></fieldset></details><details><summary>初始化会建立什么？</summary><p>应用配置与草稿环境配置，以及预览与测试、创建版本、发布、回滚和测试数据流程及快捷按钮。</p><p>草稿库与正式库分离；初始化后从草稿开始，不自动发布。重复初始化补齐缺失项，保留已修改的流程。</p></details><p class="muted">已有代码请选择“接入已有应用”。模板写入非空目录前需要检查冲突。</p></div><div class="panel-actions"><button class="primary" data-action="save-app">${config.enabled?'保存配置':'初始化应用'}（模拟）</button></div>`;
  $('#app-template').value=config.template;$('#app-database').value=config.database;$('#app-frontend').value=config.frontend;$('#app-framework').value=config.framework;if(config.components){$('#component-auth').checked=config.components.auth;$('#component-rbac').checked=config.components.rbac;$('#component-stats').checked=config.components.stats;}summary();$('#app-template').focus();
 }
 document.addEventListener('click',e=>{
  const action=e.target.closest('[data-action]')?.dataset.action;if(!action)return;
  if(action==='nav-open'){e.stopImmediatePropagation();returnFocus=e.target;nav.hidden=false;nav.setAttribute('aria-hidden','false');document.body.classList.add('navigation-open');nav.querySelector('[data-action="nav-close"]').focus();return;}
  if(action==='nav-close'){e.stopImmediatePropagation();navClose();return;}
  if(!nav.hidden&&['open','setup','session-main','session-other','session-third'].includes(action)){navClose();}
  if(action==='add-project'){e.stopImmediatePropagation();addProject();return;}
  if(action==='new-app-project'||action==='existing-app-project'){e.stopImmediatePropagation();config.enabled=false;config.template=action==='new-app-project'?'admin':'existing';initialize();return;}
  if(action==='plain-project'){e.stopImmediatePropagation();panel.hidden=true;$('#notice').textContent='已模拟添加普通项目；以后可从项目菜单选择“初始化应用”。';return;}
  if(action==='initialize-app'){e.stopImmediatePropagation();if(!nav.hidden)navClose();initialize();return;}
  if(action==='setup'){e.stopImmediatePropagation();settings();return;}
  if(action==='save-app'){
   e.stopImmediatePropagation();if($('[data-action="save-app"]').disabled)return;
   const fresh=!config.enabled;
   config={enabled:true,directory:$('#app-directory').value.trim(),template:$('#app-template').value,database:$('#app-database').value,frontend:$('#app-frontend').value,framework:$('#app-framework').value,components:{auth:$('#component-auth').checked,rbac:$('#component-rbac').checked,stats:$('#component-stats').checked}};
   editing=false;dirty=false;panel.hidden=true;
   document.dispatchEvent(new CustomEvent('app-configured',{detail:config}));
   $('#notice').textContent=`已模拟${fresh?'初始化应用':'保存应用配置'}：${config.directory} / ${labels[config.template]}。${fresh?'已准备 5 条默认流程，尚未启动或发布。':'正式环境保持原版本。'}`;
   document.body.classList.remove('using-app');document.body.classList.add('workbench-closed');return;
  }
  if(action==='discard-settings'){e.stopImmediatePropagation();editing=false;dirty=false;panel.hidden=true;return;}
  if(action==='keep-settings'){e.stopImmediatePropagation();$('#settings-guard')?.remove();return;}
  if(action==='close'&&editing){e.stopImmediatePropagation();if(dirty){if(!$('#settings-guard'))panel.insertAdjacentHTML('beforeend','<div id="settings-guard" role="alert"><p>配置尚未保存。</p><button data-action="keep-settings">继续编辑</button><button data-action="discard-settings">放弃修改</button></div>');}else{panel.hidden=true;editing=false;}return;}
 },true);
 for(const event of ['input','change'])panel.addEventListener(event,e=>{if(editing&&e.target.matches('input,select')){dirty=true;summary();}});
 document.addEventListener('keydown',e=>{
  if(!nav.hidden){if(e.key==='Escape'){e.stopImmediatePropagation();navClose();}if(e.key==='Tab'){const buttons=[...nav.querySelectorAll('aside button')];if(e.shiftKey&&document.activeElement===buttons[0]){e.preventDefault();buttons.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===buttons.at(-1)){e.preventDefault();buttons[0].focus();}}}
  else if(e.key==='Escape'&&editing){e.stopImmediatePropagation();panel.querySelector('[data-action="close"]').click();}
 },true);

 if(empty||scenario==='import')initialize();
})();
