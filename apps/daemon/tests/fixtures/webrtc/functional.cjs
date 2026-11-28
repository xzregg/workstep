async function runFunctional(page,cfg,screenshotDir,files) {
  const report={cases:[],networkErrors:[],resources:[]};
  const record=()=>{if(screenshotDir)fs.writeFileSync(path.join(screenshotDir,'functional-results.json'),JSON.stringify(report,null,2));};
  const check=async(name,operation)=>{
    const start=Date.now();
    try{const details=await operation();report.cases.push({name,status:'passed',ms:Date.now()-start,details});}
    catch(error){
      const diagnostic=await page.evaluate(()=>({url:location.href,body:document.body.innerText.slice(-3500),lostImage:window.rtcLostImage,uploadCalls:window.rtcUploadCalls,images:[...document.querySelectorAll('.chat-input-image img')].map(img=>({src:img.src,width:img.naturalWidth}))})).catch(()=>null);
      if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'failure-'+report.cases.length+'.png')}).catch(()=>{});
      report.cases.push({name,status:'failed',ms:Date.now()-start,error:String(error),diagnostic});
    }
    record();
  };
  const responseListener=res=>{
    const pathname=new URL(res.url()).pathname;
    if(pathname.includes('/__host/'))report.resources.push({path:pathname,status:res.status(),worker:res.fromServiceWorker()});
    if(res.status()>=400)report.networkErrors.push({path:pathname,status:res.status()});
  };
  page.on('response',responseListener);
  const navigate=async(route,params={})=>{
    await page.evaluate(({url,params})=>{history.pushState(null,'',url+'?'+new URLSearchParams(params));dispatchEvent(new PopStateEvent('popstate'));},
      {url:new URL(route,cfg.p2pUrl).href,params});
  };
  const request=async(route,method='GET',body)=>page.evaluate(async({route,method,body})=>{
    const response=await fetch('/api'+route,{method,headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok)throw new Error(method+' '+route+' HTTP '+response.status+' '+JSON.stringify(data));
    return data;
  },{route,method,body});
  const scope='?project_id='+encodeURIComponent(cfg.projectId);
  const upload=async(filename,bytes,mime='application/octet-stream')=>request('/fs/browser-upload','POST',{
    project_id:cfg.projectId,parent:'',filename,data_url:'data:'+mime+';base64,'+bytes.toString('base64')});
  const digest=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const download=async(filename,expected)=>{
    await navigate('file-preview',{project_id:cfg.projectId,path:filename});
    await page.waitForSelector('.artifact-download-button,.artifact-download-action',{timeout:10000});
    await page.evaluate(()=>{window.savedDownload=null;});
    await page.locator('.artifact-download-button,.artifact-download-action').first().click();
    await page.waitForFunction(()=>window.savedDownload!==null,null,{timeout:45000});
    const saved=await page.evaluate(()=>window.savedDownload);
    if(saved.size!==expected.length||saved.hash!==digest(expected))throw new Error('Downloaded file hash or size mismatch');
    return {bytes:saved.size,sha256:saved.hash};
  };
  await page.setViewportSize({width:1440,height:900});
  const raw=Buffer.alloc(5*1024*1024);for(let i=0;i<raw.length;i++)raw[i]=i%251;
  await check('普通文件 5 MiB 上传和下载哈希',async()=>{
    await upload('rtc-transfer.bin',raw);
    return download('rtc-transfer.bin',raw);
  });
  await check('真实 APK 上传和下载哈希',async()=>{
    if(!fs.existsSync(files.apk))return {skipped:'Local APK build unavailable; synthetic APK covered by base suite'};
    const apk=fs.readFileSync(files.apk);await upload('rtc-application.apk',apk);
    return {...await download('rtc-application.apk',apk),file:'Android debug APK'};
  });
  await check('超过预览上限的文件仍能下载',async()=>{
    const large=Buffer.alloc(21*1024*1024,0xa5);await upload('rtc-large.bin',large);
    await navigate('file-preview',{project_id:cfg.projectId,path:'rtc-large.bin'});
    await page.locator('.artifact-download-action').waitFor({timeout:10000});
    const result=await download('rtc-large.bin',large);
    return {...result,preview:'20 MiB limit rejected preview as expected'};
  });
  const wave=Buffer.alloc(44+16000);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);
  wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(8000,24);
  wave.writeUInt32LE(16000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(16000,40);
  const video=fs.readFileSync(files.video);
  for(const [filename,bytes,selector] of [['rtc-audio.wav',wave,'audio'],['rtc-audio.mp3',fs.readFileSync(files.mp3),'audio'],['rtc-audio.m4a',fs.readFileSync(files.m4a),'audio'],['rtc-video.webm',video,'video']]){
    await check(filename+' 加载、播放和下载',async()=>{
      await upload(filename,bytes);
      await navigate('file-preview',{project_id:cfg.projectId,path:filename});
      await page.waitForFunction(selector=>document.querySelector(selector)?.readyState>=2,selector,{timeout:10000});
      await page.locator(selector).evaluate(async element=>{element.muted=true;await element.play();});
      await page.waitForFunction(selector=>document.querySelector(selector)?.currentTime>0,selector,{timeout:5000});
      const played=await page.locator(selector).evaluate(element=>({duration:element.duration,src:element.src,paused:element.paused,currentTime:element.currentTime}));
      if(played.currentTime<=0||!played.src.startsWith('blob:'))throw new Error('Media did not play through the authenticated resource');
      if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,filename+'.png')});
      return {played,...await download(filename,bytes)};
    });
  }
  await check('HTML 相对 CSS、JS、图片、字体、子页面和音频',async()=>{
    const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S0AAAAASUVORK5CYII=','base64');
    const html=Buffer.from('<!doctype html><link rel="stylesheet" href="rtc-style.css"><button id="run">Run</button><img src="rtc-pixel.png"><audio src="rtc-audio.wav" controls></audio><iframe src="rtc-child.html"></iframe><script src="rtc-script.js"></script>');
    for(const [name,bytes] of [['rtc-pixel.png',pixel],['rtc-font.woff2',fs.readFileSync(files.font)],['rtc-style.css',Buffer.from('@font-face{font-family:RtcLinked;src:url("rtc-font.woff2")}button{color:rgb(1,2,3);font-family:RtcLinked}')],['rtc-script.js',Buffer.from('document.body.dataset.ready="yes";document.querySelector("button").onclick=()=>document.body.dataset.clicked="yes";')],['rtc-child.html',Buffer.from('<p>Child resource loaded</p>')],['rtc-preview.html',html]])await upload(name,bytes);
    await navigate('file-preview',{project_id:cfg.projectId,path:'rtc-preview.html'});
    const frame=page.frameLocator('.artifact-html-frame');
    await frame.locator('body[data-ready=yes]').waitFor({timeout:10000});
    await frame.getByRole('button',{name:'Run'}).click();
    const state=await frame.locator('body').evaluate(async body=>{await document.fonts.ready;return {clicked:body.dataset.clicked,color:getComputedStyle(body.querySelector('button')).color,width:body.querySelector('img').naturalWidth,media:body.querySelector('audio').readyState,font:document.fonts.check('16px RtcLinked')};});
    if(state.clicked!=='yes'||state.color!=='rgb(1, 2, 3)'||state.width!==1||!state.font)throw new Error('HTML linked resources failed '+JSON.stringify(state));
    await frame.frameLocator('iframe').getByText('Child resource loaded').waitFor();
    await frame.locator('audio').evaluate(async element=>{element.muted=true;await element.play();});
    if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'html-linked-resources.png')});
    return state;
  });
  await check('工作台页面和目录 API',async()=>{
    const paths=['/project/list','/workflow/list'+scope,'/task/list'+scope,'/chat-sessions'+scope,'/schedule/list'+scope,
      '/statistics/overview','/statistics/system','/fs/browse'+scope,'/fs/search'+scope+'&query=rtc',
      '/engine/list','/provider/list','/assistant/list','/system-settings','/digital-person','/skins','/git/repositories','/appearance/preferences'];
    for(const item of paths)await request(item);
    for(const route of ['tasks','chat','canvas','schedules','statistics','git','appearance']){
      await navigate(route,{project:cfg.projectName});await page.waitForTimeout(250);
      if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'page-'+route+'.png')});
    }
    return {interfaces:paths.length,pages:7};
  });
  await runBusinessChecks({page,cfg,screenshotDir,check,request,navigate,scope,upload,download,digest,report});
  await navigate('',{});
  await page.waitForSelector('[data-webrtc-connected="true"]');
  page.off('response',responseListener);record();
  const failures=report.cases.filter(item=>item.status==='failed');
  if(failures.length)throw new Error('Functional failures: '+JSON.stringify(failures));
}

async function runBusinessChecks(context){
  const {page,cfg,check,request,navigate,scope}=context;
  let workflow;
  await check('流程和文件增删改',async()=>{
    await request('/workflow/create'+scope,'POST',{name:'rtc-keeper'});
    workflow=await request('/workflow/create'+scope,'POST',{name:'rtc-business'});
    await request('/workflow/'+workflow.id+scope,'PUT',{name:'rtc-business-renamed'});
    const file=await request('/fs/entry','POST',{project_id:cfg.projectId,parent:'',name:'rtc-edit.txt',kind:'file'});
    await request('/fs/content','PUT',{project_id:cfg.projectId,path:file.path,content:'verified edit',expected_content:''});
    const renamed=await request('/fs/entry','PATCH',{project_id:cfg.projectId,path:file.path,name:'rtc-renamed.txt'});
    const read=await request('/fs/preview'+scope+'&path=rtc-renamed.txt');
    if(read.content!=='verified edit')throw new Error('Edit did not persist');
    await request('/fs/entry','DELETE',{project_id:cfg.projectId,path:renamed.path});
    return {workflow:workflow.id};
  });
  let session;
  await check('聊天 UI 发送、流式事件、落库署名和历史',async()=>{
    session=await request('/chat-sessions'+scope,'POST',{project_id:cfg.projectId,title:'RTC functional chat',engine:'claude'});
    await navigate('chat',{project:cfg.projectName,session:session.id});
    await page.locator('.assistant-chat-header-title').filter({hasText:'RTC functional chat'}).waitFor();
    const input=page.locator('textarea.chat-input-text-segment').first();
    await input.fill('rtc-functional-chat');
    // Lose the successful upload response and close the actual peer: the retry
    // must recover without duplicating the uploaded file or losing its bytes.
    const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S0AAAAASUVORK5CYII=','base64');
    await page.evaluate(()=>{
      const original=window.fetch;window.rtcLostImage=null;window.rtcUploadCalls=[];
      window.fetch=async(...args)=>{
        const response=await original(...args);
        const url=typeof args[0]==='string'?args[0]:args[0].url;window.rtcUploadCalls.push(url);
        if(url.includes('/api/fs/upload/image')&&response.ok){
          window.rtcLostImage=await response.clone().json();
          window.__workstepDirect.handle.peerConnection.close();
          throw new TypeError('WebRTC DataChannel closed');
        }
        return response;
      };
    });
    await page.locator('input[type=file][accept="image/*"]').setInputFiles({name:'rtc-chat.png',mimeType:'image/png',buffer:pixel});
    await page.waitForFunction(()=>document.querySelector('.chat-input-image img')?.naturalWidth===1,null,{timeout:25000});
    await page.locator('.chat-input-image').first().click();
    await page.evaluate(()=>{window.savedDownload=null;});
    await page.locator('.image-preview').getByRole('button',{name:/下载图片|Download image/i}).click();
    await page.waitForFunction(()=>window.savedDownload!==null,null,{timeout:15000});
    const imageDownload=await page.evaluate(()=>window.savedDownload);
    if(imageDownload.hash!==context.digest(pixel))throw new Error('Image native download corrupted after reconnect');
    await page.locator('.image-preview-close').click();
    await page.locator('button.chat-input-send').first().click();
    await page.getByText('直连流式第一段。直连流式第二段。',{exact:true}).first().waitFor({timeout:15000});
    const detail=await request('/chat-sessions/'+session.id+scope);
    const author=detail.messages.find(item=>item.role==='user');
    if(author.author_name!=='Operator')throw new Error('Wrong local message author '+author.author_name);
    const reply=detail.messages.find(item=>item.role==='assistant');
    const events=await request('/chat-sessions/'+session.id+'/messages/'+reply.id+'/events'+scope);
    return {messages:detail.messages.length,author:author.author_name,events:events.events?.length,imageDownload,retriedLostUpload:await page.evaluate(()=>!!window.rtcLostImage)};
  });
  await check('会话重命名、归档、恢复和停止',async()=>{
    if(!session)throw new Error('Session creation failed');
    await request('/chat-sessions/'+session.id+scope,'PATCH',{project_id:cfg.projectId,title:'RTC renamed'});
    await request('/chat-sessions/'+session.id+'/archive'+scope,'PATCH',{project_id:cfg.projectId,archived:true});
    await request('/chat-sessions/'+session.id+'/archive'+scope,'PATCH',{project_id:cfg.projectId,archived:false});
    await request('/chat-sessions/'+session.id+'/chat'+scope,'POST',{project_id:cfg.projectId,content:'rtc-stop-test'});
    await page.waitForTimeout(400);
    await request('/chat-sessions/'+session.id+'/stop'+scope,'POST');
    let detail;
    for(let attempt=0;attempt<50;attempt++){
      detail=await request('/chat-sessions/'+session.id+scope);
      if(detail.messages.at(-1)?.status!=='running')break;
      await page.waitForTimeout(100);
    }
    if(detail.messages.at(-1)?.status==='running')throw new Error('Stopped turn remained running');
    return {title:detail.title,lastStatus:detail.messages.at(-1)?.status};
  });
  let task;
  await check('任务创建、修改、归档、恢复和执行报告',async()=>{
    task=await request('/task/create'+scope,'POST',{title:'RTC task',description:'isolated regression',workflow_id:workflow?.id,auto_start:false,engine:'claude'});
    await request('/task/'+task.id+scope,'PATCH',{title:'RTC task renamed'});
    await request('/task/'+task.id+'/execution-report'+scope);
    await request('/task/archive'+scope,'POST',{task_id:task.id,notify:false});
    await request('/task/unarchive'+scope,'POST',{task_id:task.id});
    return {id:task.id,creator:task.creator_name};
  });
  await check('定时任务创建、修改、暂停、恢复和删除',async()=>{
    const item=await request('/schedule/create'+scope,'POST',{name:'RTC schedule',workflow_id:workflow.id,task_template:{title:'RTC future task'},rule:{kind:'daily',time:'23:59',timezone:'UTC'},execution_mode:'manual',overlap_policy:'queue'});
    await request('/schedule/'+item.id+scope,'PATCH',{name:'RTC renamed schedule'});
    await request('/schedule/'+item.id+'/pause'+scope,'POST');
    await request('/schedule/'+item.id+'/resume'+scope,'POST');
    await request('/schedule/'+item.id+scope,'DELETE');
    return {id:item.id};
  });
  await check('供应商设置增删改和本机名称设置',async()=>{
    const saved=await request('/provider','POST',{name:'RTC audit',protocol:'openai_chat_completions',base_url:'https://provider.invalid/v1',api_key:'',enabled:false});
    const providers=await request('/provider/list');
    const provider=providers.providers.find(item=>item.name==='RTC audit');
    if(!provider)throw new Error('Saved provider not listed');
    await request('/provider','POST',{id:provider.id,name:'RTC audit renamed',protocol:'openai_chat_completions',base_url:'https://provider.invalid/v1',enabled:false});
    await request('/provider/'+provider.id,'DELETE');
    await request('/system-settings','PUT',{user_name:'RTC changed user'});
    const profile=await request('/system-settings');
    if(profile.user_name!=='RTC changed user')throw new Error('System name did not persist');
    await request('/system-settings','PUT',{user_name:'Operator'});
    return {saved:!!saved};
  });
  await check('真实通道关闭后原位重连和文件读取',async()=>{
    await page.evaluate(()=>window.__workstepDirect.handle.peerConnection.close());
    await page.waitForFunction(()=>window.__workstepDirect?.handle.transport.isOpen,null,{timeout:20000});
    await request('/project/list');
    const file=await request('/fs/preview'+scope+'&path=rtc-preview.html');
    if(!file.content.includes('rtc-script.js'))throw new Error('File read after reconnect failed');
    return {connected:true};
  });
}
