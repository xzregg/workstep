(() => {
 const $=s=>document.querySelector(s),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let scenario=new URLSearchParams(location.search).get('scenario')||'empty',step=0,added=false,asApp=true,ready=false,name='我的应用',root='projects/my-app',appPath='.',framework='Node.js + TypeScript',database='SQLite',components=['用户登录','角色权限'];
 if(!['empty','git','app'].includes(scenario))scenario='empty';
 const button=(action,label,primary=false)=>`<button data-do="${action}" class="${primary?'primary':''}">${label}</button>`;
 function trail(){const labels=['添加项目','项目设置 / 应用分析','应用初始化','欢迎页与对话'];$('#step-trail').innerHTML=labels.map((s,i)=>`<span class="${i===step?'current':''}">${i+1} ${s}</span>`).join('<span>›</span>');}
 function reset(){step=0;added=false;ready=false;name='我的应用';appPath='.';$('#project-item').textContent='尚未添加项目';$('#project-details').innerHTML='';render();}
 function render(){trail();$('#screen').classList.toggle('ready',step===3);
 if(step===0){$('#screen').innerHTML=`<section class="setup-panel"><h2>添加项目</h2><label>项目名称<input id="project-name" value="${esc(name)}"></label><label>项目目录<input id="project-root" value="${esc(root)}"></label><label class="check-row"><input id="as-app" type="checkbox" checked> 将这个项目作为应用</label><p class="hint">添加完成后，在项目设置中继续分析与初始化应用。</p><div class="form-actions">${button('add','添加并初始化项目',true)}</div></section>`;return;}
 if(step===1){$('#screen').innerHTML=`<section class="setup-panel"><div class="breadcrumb">项目设置 / 应用</div><h2>项目已初始化</h2><p>${esc(name)} <span class="hint">${esc(root)}</span></p><div class="analysis-row"><strong>下一步：识别这个项目</strong><p>读取应用配置、目录、Git、依赖与启动脚本，判断是否需要创建应用。</p></div><div class="form-actions">${button('analyze','查看模拟分析结果',true)}${button('later','稍后再做')}</div><small>正式实现会自动分析；此按钮仅用于逐屏查看原型。</small></section>`;return;}
 if(step===2){configuration();return;}
 welcome();
 }
 function analyze(){step=1;trail();let content;
 if(scenario==='empty')content='<h2>这是一个空目录</h2><div class="analysis-row">项目初始化已完成；尚无应用文件。</div><div class="analysis-row">接下来选择应用目录、框架和基础组件。</div>';
 else if(scenario==='git')content='<h2>识别到已有 Git 项目</h2><div class="analysis-row"><strong>.git</strong><span>已存在仓库，保留提交和 Tag</span></div><div class="analysis-row"><strong>package.json → scripts.dev</strong><span>可启动 Web 应用，命令：npm run dev</span></div><div class="analysis-row"><strong>.github/workflows/ci.yml</strong><span>检测到 CI，保持原流程</span></div><div class="analysis-row">尚未发现应用配置，需要确认应用目录与测试环境。仅有 Git 仓库不代表已接入应用。</div>';
 else content='<h2>检测到应用配置</h2><div class="analysis-row"><strong>应用目录：apps/customer</strong><span>已登记独立仓库、启动脚本和草稿数据库</span></div><div class="analysis-row"><strong>已有版本 v1.2.0</strong><span>恢复版本记录；正式运行状态仍需健康检查</span></div><div class="analysis-row">沿用已有文件和组件，不生成新骨架。</div>';
 $('#screen').innerHTML=`<section class="setup-panel"><div class="breadcrumb">项目设置 / 应用分析</div>${content}<div class="form-actions">${button('continue',scenario==='app'?'恢复应用配置':'继续初始化',true)}${button('later','稍后再做')}</div><small>检测证据为模拟示例，未扫描真实目录。</small></section>`;
 }
 function configuration(){
 const empty=scenario==='empty',existing=scenario==='app';
 $('#screen').innerHTML=`<section class="setup-panel"><div class="breadcrumb">项目设置 / 应用初始化</div><h2>${empty?'创建应用的起点':existing?'沿用已有应用':'确认已有应用的接入方式'}</h2><label>应用目录<select id="directory-mode"><option value="root">使用项目根目录</option><option value="child">使用项目内子目录</option></select><input id="app-path" value="${existing?'apps/customer':esc(appPath)}" placeholder=". 或 apps/my-app"></label><small>此目录作为应用 Git 仓库根目录；已有父仓库时先确认边界，不静默创建嵌套仓库。</small>${empty?`<label>应用框架<select id="app-framework"><option>Node.js + TypeScript</option></select></label><fieldset><legend>基础组件</legend><label class="check-row"><input type="checkbox" data-component="用户登录" checked> 用户登录</label><label class="check-row"><input type="checkbox" data-component="角色权限" checked> 角色权限</label><label class="check-row"><input type="checkbox" data-component="统计看板"> 统计看板</label></fieldset><details><summary>更多配置</summary><label>数据库<select id="database"><option>SQLite</option><option>PostgreSQL</option></select></label><p>前端 React，后端 Fastify；应用依赖独立安装。</p></details>`:`<div class="analysis-row"><strong>沿用现有框架与组件</strong><span>不会生成模板覆盖原应用。</span></div><label>启动命令<input id="startup" value="npm run dev"></label><label>预览地址<input id="preview-url" value="http://127.0.0.1:3000"></label><div class="analysis-row">草稿环境使用独立测试库；未确认隔离前不能执行启动。</div><label class="check-row"><input id="isolated" type="checkbox" checked> 本例已确认草稿与正式配置隔离（模拟）</label>`}<div id="field-error" role="status"></div><div class="form-actions">${button('generate',empty?'生成初始应用（模拟）':'验证并接入（模拟）',true)}${button('back','返回分析')}</div></section>`;
 $('#directory-mode').value=existing||appPath!=='.'?'child':'root';validate();
 }
 function validate(){const path=$('#app-path')?.value.trim();if(path===undefined)return;const command=$('#startup');const url=$('#preview-url');let ok=!!path&&!path.startsWith('/')&&!path.split('/').includes('..');if(command)ok=ok&&!!command.value.trim()&&/^https?:\/\//.test(url.value.trim())&&$('#isolated').checked;$('[data-do="generate"]').disabled=!ok;$('#field-error').textContent=ok?'':'请补齐有效目录、启动配置，并确认草稿隔离。';}
 function welcome(){ready=true;$('#project-details').innerHTML='<small>流程</small><p>预览与测试</p><p>创建版本与发布</p><small>对话</small><button data-do="chat">创建我的应用</button>';
 const title=scenario==='empty'?'欢迎使用你的应用':'原应用已接入';
 $('#screen').innerHTML=`<section class="journey-chat"><h3>创建我的应用</h3><div id="journey-messages"><p class="assistant-label">助手</p><p>${scenario==='empty'?'基础应用已准备好。你想用它解决什么问题？':'已沿用原应用。你希望先改进哪个功能？'}</p><small>修改发生在草稿环境，正式环境保持原版本。</small></div><div class="journey-composer"><label for="chat-message">描述你想创建的功能</label><textarea id="chat-message" placeholder="例如：帮我做一个客户跟进管理应用"></textarea><div class="form-actions">${button('send','发送',true)}</div></div></section><section class="journey-app"><header><strong>应用窗口栏</strong><small>草稿预览 / 尚未发布</small></header><iframe title="应用初始页面" sandbox="" id="welcome-frame"></iframe></section>`;
 $('#welcome-frame').srcdoc=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:16px system-ui;color:#20242c;margin:0}nav{padding:22px;border-bottom:1px solid #e3e5e9}main{max-width:620px;margin:70px auto;padding:30px}h1{font-size:28px}p{line-height:1.8;color:#697180}.modules{display:flex;gap:12px;flex-wrap:wrap}.modules span{padding:12px;border:1px solid #e3e5e9;border-radius:6px}</style><nav>${esc(name)}</nav><main><h1>${title}</h1><p>${scenario==='empty'?'从左侧对话描述你的需求，让这个应用逐步变成你想要的样子。':'这里显示原应用页面，保留已有功能。此页面仅为接入后的占位示意。'}</p><div class="modules">${components.map(c=>`<span>${esc(c)} 已就绪</span>`).join('')}</div><p>模拟生成完成：初始页面、独立依赖、草稿配置与默认流程。未执行真实安装或启动。</p></main></html>`;
 }
 document.addEventListener('click',e=>{const a=e.target.closest('[data-do]')?.dataset.do;if(!a)return;
 if(a.startsWith('scenario-')){scenario=a.slice(9);reset();return;}
 if(a==='reset'){reset();return;}
 if(a==='add'){name=$('#project-name').value.trim();root=$('#project-root').value.trim();if(!name||/\s/.test(name)||!root)return;asApp=$('#as-app').checked;added=true;$('#project-item').textContent=name;if(asApp){step=1;render();}else ordinary();return;}
 if(a==='project-settings'){if(!added){reset();return;}ordinary();return;}
 if(a==='enable'){step=1;render();return;}
 if(a==='analyze'||a==='back'){analyze();return;}
 if(a==='continue'){step=2;render();return;}
 if(a==='later'){ordinary();return;}
 if(a==='generate'){if(e.target.disabled)return;appPath=$('#app-path').value.trim();if(scenario==='empty'){framework=$('#app-framework').value;database=$('#database').value;components=[...document.querySelectorAll('[data-component]:checked')].map(i=>i.dataset.component);}step=3;render();return;}
 if(a==='chat'&&ready){$('#chat-message').focus();return;}
 if(a==='send'){const t=$('#chat-message').value.trim();if(!t)return;$('#journey-messages').insertAdjacentHTML('beforeend',`<p><strong>你</strong><br>${esc(t)}</p><p>已记录需求（模拟）。下一步在草稿中实现并预览，不更新正式环境。</p>`);$('#chat-message').value='';}
 });
 function ordinary(){step=1;trail();$('#screen').classList.remove('ready');$('#screen').innerHTML=`<section class="setup-panel"><div class="breadcrumb">项目设置</div><h2>${ready?'应用已配置':'普通项目已就绪'}</h2><p>项目已经添加，可正常聊天和使用流程。</p><div class="analysis-row"><strong>应用（可选）</strong><p>${ready?'已完成接入，不需要重复初始化。':'稍后启用时，从这里继续同一套分析与初始化流程。'}</p>${button(ready?'finish':'enable',ready?'打开应用':'初始化为应用',true)}</div></section>`;if(ready)$('[data-do="finish"]').onclick=()=>{step=3;render();};}
 document.addEventListener('input',e=>{if(step===0){const n=$('#project-name').value.trim();$('[data-do="add"]').disabled=!n||/\s/.test(n)||!$('#project-root').value.trim();}else validate();});
 document.addEventListener('change',e=>{if(e.target.id==='directory-mode')$('#app-path').value=e.target.value==='root'?'.':'apps/my-app';validate();});
 render();
})();
