const test = require('node:test');
const assert = require('node:assert/strict');
const {derivePlan, canVerify, applyPlan} = require('./onboarding.js');
test('已有项目沿用CI，不生成重复正式部署入口',()=>{
 const p=derivePlan({kind:'existing',ci:'preserve',existingFlows:['开发验证']});
 assert.equal(p.codeChanges,0);assert.equal(p.ciChanges,0);
 assert.equal(p.flows.find(f=>f.key==='develop').name,'开发验证（工作台）');
 assert.equal(p.flows.find(f=>f.key==='publish').enabled,false);
});
test('空项目模板主动选择后才生成',()=>{
 assert.equal(derivePlan({kind:'empty',template:false}).flows.length,0);
 assert.equal(derivePlan({kind:'empty',template:true}).flows.length,6);
});
test('验证必须限于测试环境并显式选择执行',()=>{
 assert.equal(canVerify({source:'local',testDb:true,executionApproved:true,target:'test'}),true);
 assert.equal(canVerify({source:'remote',testDb:true,executionApproved:true,target:'test'}),false);
 assert.equal(canVerify({source:'local',testDb:true,executionApproved:true,target:'production'}),false);
 assert.equal(canVerify({source:'local',testDb:false,executionApproved:true,target:'test'}),false);
});
test('未验证方案不能声称预览可用，重复应用保留项目修改',()=>{
 const plan=derivePlan({kind:'existing',ci:'preserve'});
 const first=applyPlan(plan,null,false);
 assert.equal(first.previewReady,false);
 first.flows[0].name='自定义准备';
 const second=applyPlan(plan,first,true);
 assert.equal(second.flows.length,6);assert.equal(second.flows[0].name,'自定义准备');
 assert.equal(second.previewReady,true);
});

async function withPrototype(run){
 const fs=require('node:fs');
 const path=require('node:path');
 const {pathToFileURL}=require('node:url');
 const {Window}=await import(pathToFileURL(require.resolve('happy-dom',{paths:[path.resolve('apps/web')]})).href);
 const w=new Window({url:'https://prototype.invalid/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
 const interval=w.setInterval.bind(w);w.setInterval=fn=>interval(fn,1);
 w.document.write(fs.readFileSync(path.join(__dirname,'onboarding.html'),'utf8'));
 w.eval(fs.readFileSync(path.join(__dirname,'onboarding.js'),'utf8'));
 const d=w.document;
 const click=a=>{const el=d.querySelector('[data-onboard="'+a+'"]');assert.ok(el,'missing '+a);assert.equal(el.disabled,false,'disabled '+a);el.click();};
 const change=(id,value)=>{const el=d.getElementById(id);assert.ok(el,id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}assert.fail('state did not become ready');};
 try{await run({w,d,click,change,wait});}finally{await w.happyDOM.abort();w.close();}
}
test('现有界面入口走通：分析→补配置→验证→生成，发布保持禁用',async()=>withPrototype(async({d,click,change,wait})=>{
 click('add');click('choose-project');click('analyze');
 await wait(()=>d.querySelector('[data-onboard=next]')?.disabled===false);
 click('next');assert.match(d.getElementById('wizard-body').textContent,/release.yml/);
 click('next');assert.equal(d.querySelector('[data-onboard=run-verify]').disabled,true);
 click('back');click('bind-db');click('next');change('approve-execution',true);click('run-verify');
 await wait(()=>d.querySelector('[data-onboard=next]')?.disabled===false);
 click('next');click('apply');
 assert.equal(d.querySelectorAll('.native-flow').length,6);
 assert.match(d.getElementById('native-chat-area').textContent,/测试环境验证通过/);
 assert.equal(d.querySelector('[data-onboard=quick-publish]').disabled,true);
 assert.equal(d.querySelectorAll('#native-chat-shortcuts button').length,5);
 click('prompt-0');assert.ok(d.getElementById('native-message').value);
 assert.equal(d.querySelectorAll('.native-user-message').length,0);
}));
test('端口失败不冒充就绪，修复重试后再应用',async()=>withPrototype(async({d,click,change,wait})=>{
 change('demo-case','failure');click('choose-project');click('analyze');await wait(()=>d.querySelector('[data-onboard=next]')?.disabled===false);
 click('next');click('bind-db');click('next');change('approve-execution',true);click('run-verify');
 await wait(()=>!!d.querySelector('[data-onboard=fix-port]'));
 assert.equal(d.querySelector('[data-onboard=next]').disabled,true);
 click('fix-port');await wait(()=>d.querySelector('[data-onboard=next]')?.disabled===false);
 click('next');click('apply');assert.match(d.getElementById('native-chat-area').textContent,/验证通过/);
}));
test('空目录可以保持普通项目，已有项目保留同名流程，草稿可继续',async()=>withPrototype(async({d,click,change,wait})=>{
 change('demo-case','empty');click('analyze');await wait(()=>d.querySelector('[data-onboard=next]')?.disabled===false);
 click('next');change('use-template',false);click('next');assert.equal(d.querySelectorAll('.native-flow').length,0);
 change('demo-case','settings');click('existing-analyze');await wait(()=>d.querySelector('[data-onboard=next]')?.disabled===false);
 click('next');assert.match(d.getElementById('wizard-body').textContent,/开发验证（工作台）/);
 click('close');assert.equal(d.getElementById('guard-dialog').open,true);click('keep-draft');click('workbench');
 assert.match(d.getElementById('wizard-body').textContent,/确认启动方式/);
 click('next');click('save-unverified');click('apply');
 assert.match(d.getElementById('native-chat-area').textContent,/尚未完成启动验证/);
 assert.equal(d.querySelector('[data-onboard=quick-preview]').disabled,true);
}));
