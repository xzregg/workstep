const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
async function app(){const {Window}=await import(require.resolve('happy-dom',{paths:[path.resolve('apps/web')]}));const w=new Window({settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});w.document.write(fs.readFileSync('plans/app-workbench/integrated.html','utf8'));for(const f of ['layouts.js','mobile.js'])w.eval(fs.readFileSync('plans/app-workbench/'+f,'utf8'));return w;}
test('手机项目抽屉打开应用、返回对话；配置常规初始化应用',async()=>{
 const w=await app();try{const d=w.document,click=a=>d.querySelector(`[data-action="${a}"]`).click();
 click('nav-open');assert.equal(d.querySelector('#mobile-navigation').getAttribute('aria-hidden'),'false');
 d.querySelector('#mobile-navigation [data-action="open"]').click();assert.equal(d.querySelector('#mobile-navigation').getAttribute('aria-hidden'),'true');
 click('toggle-workbench');assert.ok(d.body.classList.contains('workbench-closed'));
 click('setup');assert.equal(d.querySelector('#app-framework'),null);click('close');click('initialize-app');
 d.querySelector('#app-template').value='admin';d.querySelector('#app-template').dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.match(d.querySelector('#template-summary').textContent,/Node.js.*Fastify.*SQLite/);
 d.querySelector('#app-directory').value='apps/customer';d.querySelector('#app-directory').dispatchEvent(new w.Event('input',{bubbles:true}));
 click('save-app');assert.match(d.querySelector('#notice').textContent,/apps\/customer/);
 click('initialize-app');assert.equal(d.querySelector('#app-directory').value,'apps/customer');
 }finally{w.happyDOM.abort();}
});
test('聊天修改只改变草稿，正式内容在明确发布后变化',async()=>{
 const w=await app();try{const d=w.document,click=a=>d.querySelector(`[data-action="${a}"]`).click();
 click('send');click('environment-production');
 assert.doesNotMatch(d.querySelector('#workbench-frame').srcdoc,/<option>全部状态<\/option>/);
 assert.match(d.querySelector('#preview-state').textContent,/正式数据库/);
 click('environment-draft');assert.match(d.querySelector('#workbench-frame').srcdoc,/<option>全部状态<\/option>/);
 click('create');click('confirm-create');click('environment-production');
 assert.doesNotMatch(d.querySelector('#workbench-frame').srcdoc,/<option>全部状态<\/option>/);
 click('deploy');click('confirm-deploy');assert.match(d.querySelector('#workbench-frame').srcdoc,/<option>全部状态<\/option>/);
 }finally{w.happyDOM.abort();}
});

test('添加项目到应用配置：新模板或已有代码，两条路径可达',async()=>{
 const w=await app();try{const d=w.document,click=a=>d.querySelector(`[data-action="${a}"]`).click();
 click('add-project');click('new-app-project');
 assert.equal(d.querySelector('#app-template').value,'admin');
 assert.equal(d.querySelector('#app-framework').value,'node');
 assert.ok(d.querySelector('#component-auth'));
 click('close');click('add-project');click('existing-app-project');
 assert.equal(d.querySelector('#app-template').value,'existing');
 assert.match(d.querySelector('#template-summary').textContent,/保留现有/);
 }finally{w.happyDOM.abort();}
});

test('默认使用正式应用，打开对话进入三栏，关闭对话保留未发布变更',async()=>{
 const w=await app();try{const d=w.document,click=a=>d.querySelector(`[data-action="${a}"]`).click();
 assert.ok(d.body.classList.contains('using-app'));
 assert.match(d.querySelector('#preview-state').textContent,/正式数据库/);
 click('session-main');assert.ok(!d.body.classList.contains('using-app'));
 click('close-chat');assert.ok(d.body.classList.contains('using-app'));
 click('session-main');click('send');click('close-chat');
 assert.ok(d.body.classList.contains('has-changes'));
 assert.match(d.querySelector('#preview-state').textContent,/测试数据库/);
 }finally{w.happyDOM.abort();}
});
