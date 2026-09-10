// Run against an already running Vite server. All API writes are intercepted.
// Optional PLAYWRIGHT_MODULE selects an existing Playwright installation.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');
const assert=require('node:assert/strict');
const path=require('path');
const output=process.env.MOBILE_QA_DIR || path.join(require('os').tmpdir(),'workstep-mobile-qa');
const baseURL=process.env.WORKSTEP_WEB_URL || 'http://localhost:5173';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const steps=JSON.parse(fs.readFileSync(path.join(__dirname, '../../daemon/data/templates/data-analysis.json'))).steps;
 const project={id:'mobile-qa',name:'移动端验收',path:'/tmp/mobile-qa',steps,workflows:[{id:'qa-flow',name:'数据分析',is_default:true,nodeCount:5}]};
 const task={id:'qa-task',title:'检查移动端任务执行进度与审批',description:'验证手机浏览器中的完整任务流程。',cwd:'/tmp/mobile-qa',workflow_id:'qa-flow',status:'ready',engine:'codex',created_at:'2026-09-08T09:00:00',updated_at:'2026-09-08T10:00:00',steps:[]};
 const errors=[];const requests=[];const writes=[];let wsCount=0;let reviews=[];
 await context.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;if(!path.startsWith('/api/'))return route.continue();requests.push(path);if(route.request().method()!=='GET')writes.push({path,body:route.request().postData()});
  let data={};
  if(path==='/api/project/list')data={projects:[project]};
  else if(path==='/api/system-settings')data={user_name:'验收',open_mode:false};
  else if(path==='/api/task/list')data={tasks:[task]};
  else if(path==='/api/task/qa-task')data=task;
  else if(path.endsWith('/coordinator-config'))data={engine:'codex',model:'',fast_model:'',thinking_effort:'',defaults:{engine:'codex',model:''},engines:[],configured:{engine:'codex',model:''},resolved:{engine:'codex',model:''},available_engines:[]};
  else if(path.endsWith('/reviews'))data={reviews};
  else if(path.endsWith('/history'))data={messages:[]};
  else if(path.endsWith('/artifacts'))data={artifacts:[]};
  else if(path==='/api/chat-sessions')data={sessions:[]};
  else if(path.includes('workflow/qa-flow'))data={...project.workflows[0],steps};
  else if(path.includes('engine'))data={engines:[],models:[],config:{}};
  else if(path.includes('provider'))data={providers:[]};
  else if(path.includes('schedule'))data={schedules:[]};
  else if(path.includes('template'))data={templates:[]};
  else if(path.includes('openers'))data={openers:[]};
  else if(path.includes('quick-buttons'))data={buttons:[]};
  await route.fulfill({json:data});
 });
 await context.routeWebSocket('**/ws', ws=>{wsCount++});
 const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE_ERROR',e.stack)});
 await page.goto(baseURL+'/tasks?project='+encodeURIComponent(project.name));
 await page.waitForTimeout(600);
 await page.evaluate(async project=>{const {useProjectStore}=await import('/src/stores/projectStore.ts');useProjectStore.getState().setActiveProject(project);},project);
 await page.waitForTimeout(400);
 fs.mkdirSync(output,{recursive:true});
 const results=[];
 const wsBefore=wsCount;for(const width of [360,390,430,768,1280]){
  await page.setViewportSize({width,height:844});await page.waitForTimeout(150);
  results.push({width,...await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,nav:document.querySelectorAll('aside#workstep-navigation').length,body:document.body.innerText.slice(0,100)}))});
  await page.screenshot({path:path.join(output,`list-${width}.png`)});
 }
 await page.setViewportSize({width:390,height:844});
 results.push({wsBefore,wsAfter:wsCount});await page.getByRole('button',{name:'打开导航',exact:true}).click();await page.waitForTimeout(240);await page.screenshot({path:path.join(output,'drawer.png')});
 await page.locator('#workstep-navigation').getByText('对话',{exact:true}).click();
 const addButtons=page.locator('.sidebar-add-button');
 assert.equal(await addButtons.count(),2,'workflow and chat use compact add buttons');
 for(const button of await addButtons.all()){
  const size=await button.evaluate(el=>{const box=el.getBoundingClientRect();const frame=getComputedStyle(el,'::before');return {width:box.width,height:box.height,frameWidth:frame.width,frameHeight:frame.height,border:getComputedStyle(el).borderTopWidth};});
  assert.ok(size.width>=44 && size.height>=44,'touch target remains at least 44px');
  assert.equal(size.frameWidth,'20px');assert.equal(size.frameHeight,'20px');
  assert.equal(size.border,'0px','outer touch target has no visible border');
 }
 await page.goBack(); await page.waitForTimeout(150);
 results.push({drawerBackClosed:await page.getByRole('button',{name:'打开导航',exact:true}).getAttribute('aria-expanded')});
 await page.locator('.mobile-task-row').first().click();await page.waitForTimeout(400);await page.screenshot({path:path.join(output,'detail.png')});
 results.push({detail:await page.locator('.task-detail-window').boundingBox()});
 await page.locator('.task-detail-window .chat-input-pill[data-open]').click(); await page.waitForTimeout(200);
 results.push({modelSheet:await page.locator('.mobile-sheet').count()});await page.screenshot({path:path.join(output,'model-sheet.png')});
 await page.goBack();await page.waitForTimeout(150);
 await page.goBack();await page.waitForTimeout(150);
 await page.locator('.mobile-task-toolbar').getByRole('button',{name:'新建',exact:false}).click();await page.waitForTimeout(150);
 await page.locator('#new-task-title').fill('保留手机草稿');
 await page.getByRole('button',{name:'审核配置',exact:true}).click();
 await page.getByRole('button',{name:'任务内容',exact:true}).click();
 results.push({draft:await page.locator('#new-task-title').inputValue()});
 await page.screenshot({path:path.join(output,'create.png')});
 await page.goBack(); await page.waitForTimeout(200);
 results.push({dirtyConfirmation:await page.getByRole('dialog').filter({hasText:'放弃'}).count()});
 await page.getByRole('button',{name:'放弃',exact:true}).click();await page.waitForTimeout(300);
 reviews=[{id:'qa-review',step_key:'data_collection',mode:'manual',status:'pending',workflow_run_id:'run',step_run_id:'step',report:null}];
 task.steps=[{step_key:'data_collection',status:'awaiting_review',round:1}];
 await page.locator('.mobile-task-row').first().click();await page.waitForTimeout(200);
 await page.locator('.mobile-review-entry').click();await page.waitForTimeout(100);
 await page.getByRole('button',{name:'通过并进入下一阶段',exact:true}).first().click();await page.waitForTimeout(150);
 results.push({approvalWrites:writes.filter(w=>w.path.includes('review'))});
 await page.goBack();await page.waitForTimeout(150);
 await page.locator('.mobile-task-toolbar').getByRole('button',{name:'筛选与操作'}).click();
 await page.locator('.mobile-sheet').getByRole('button',{name:'阶段编辑'}).click();await page.waitForTimeout(300);
 results.push({canvasReadOnly:await page.getByText('手机端支持查看流程；请在桌面端编辑。').isVisible(),saveButtons:await page.getByRole('button',{name:'保存',exact:true}).count()});
 await page.locator('.react-flow__node').first().click();await page.waitForTimeout(150);
 results.push({nodeSheet:await page.locator('.mobile-sheet').count()});await page.screenshot({path:path.join(output,'canvas-node.png')});
 assert.deepEqual(errors, [], 'browser must not report runtime errors');
 for(const result of results){
   if('overflow' in result)assert.equal(result.overflow,false,`page overflows at ${result.width}px`);
   if('nav' in result)assert.equal(result.nav,1);
   if('wsBefore' in result)assert.equal(result.wsBefore,result.wsAfter,'resize must not reconnect');
   if('drawerBackClosed' in result)assert.equal(result.drawerBackClosed,'false');
   if('detail' in result)assert.deepEqual(result.detail,{x:0,y:0,width:390,height:844});
   if('draft' in result)assert.equal(result.draft,'保留手机草稿');
   if('modelSheet' in result)assert.equal(result.modelSheet,1);
   if('dirtyConfirmation' in result)assert.equal(result.dirtyConfirmation,1);
   if('approvalWrites' in result)assert.equal(result.approvalWrites.length,1);
   if('canvasReadOnly' in result){assert.equal(result.canvasReadOnly,true);assert.equal(result.saveButtons,0);}
   if('nodeSheet' in result)assert.equal(result.nodeSheet,1);
 }
 const report=JSON.stringify({results,errors,requests:[...new Set(requests)]},null,2);
 fs.writeFileSync(path.join(output,'results.json'),report);
 console.log(report);
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
