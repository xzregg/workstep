/* Trusted frame router. Prototype scripts are paused whenever editing is enabled. */
(() => {
  const config=__WS_FRAME_CONFIG__;
  const frames=()=>Array.from(document.querySelectorAll('iframe'));
  const children=new Map();
  let snapshots=[],modeMessage=null;
  let base=new URL('.',location.href);
  for(let index=1;index<config.path.split('/').length;index++)base=new URL('../',base);
  const local=url=>url.origin===base.origin&&url.pathname.startsWith(base.pathname)&&/\.html?$/i.test(url.pathname);
  const frameInfo=frame=>{
    const parts=[];
    for(let node=frame;node&&node!==document.documentElement;node=node.parentElement){
      if(node.id){const id='#'+CSS.escape(node.id);if(document.querySelectorAll(id).length===1){parts.unshift(node.tagName.toLowerCase()+id);break}}
      const siblings=Array.from(node.parentElement?.children||[]).filter(item=>item.tagName===node.tagName);
      parts.unshift(node.tagName.toLowerCase()+(siblings.length>1?':nth-of-type('+(siblings.indexOf(node)+1)+')':''));
    }
    return {file:config.path,selector:parts.join(' > ')};
  };
  const post=data=>parent.postMessage({source:'workstep-prototype-frames',token:config.token,...data},'*');
  const restore=()=>{
    frames().forEach((frame,index)=>{
      if(frame.hasAttribute('srcdoc'))return;
      const direct=snapshots.find(item=>item.route.length===1&&item.route[0]===index);
      if(direct&&children.get(frame.contentWindow)?.path!==direct.path){
        const url=new URL(direct.path,base);
        const old=new URL(frame.getAttribute('src')||'',location.href);
        if(local(url)&&url.href!==old.href){frame.src=url.href;return}
      }
      frame.contentWindow?.postMessage({source:'workstep-prototype-host',type:'frame-state',snapshots:snapshots.filter(item=>item.route[0]===index&&item.route.length>1).map(item=>({...item,route:item.route.slice(1)}))},'*');
      if(modeMessage)frame.contentWindow?.postMessage(modeMessage,'*');
    });
  };
  const forward=(frame,data)=>{
    const index=frames().indexOf(frame);
    if(index<0)return;
    const message=data.message?{...data.message}:undefined;
    if(message?.selection?.rect){
      const box=frame.getBoundingClientRect(),r=message.selection.rect;
      const sx=box.width/(frame.offsetWidth||box.width||1),sy=box.height/(frame.offsetHeight||box.height||1);
      message.selection={...message.selection,rect:{x:box.left+(frame.clientLeft+r.x)*sx,y:box.top+(frame.clientTop+r.y)*sy,width:r.width*sx,height:r.height*sy}};
    }
    post({...data,token:config.token,route:[index,...(data.route||[])],frames:[frameInfo(frame),...(data.frames||[])],...(message?{message}:{})});
  };
  window.addEventListener('message',event=>{
    const data=event.data;
    if(event.source===parent&&data?.source==='workstep-prototype-host'){
      const route=data.route||[];
      if(route.length){
        if(route.length>8||!route.every(Number.isInteger))return;
        const frame=frames()[route[0]];
        if(!frame||frame.hasAttribute('srcdoc'))return;
        if(data.type==='refresh-frame'&&route.length===1){
          const url=new URL(data.path,base);
          if(local(url)){children.delete(frame.contentWindow);url.searchParams.set('ws_revision',Date.now());frame.src=url.href}
        }else frame.contentWindow?.postMessage({...data,route:route.slice(1)},'*');
        return;
      }
      if(data.type==='frame-state'){snapshots=Array.isArray(data.snapshots)?data.snapshots.filter(item=>Array.isArray(item.route)&&item.route.length<=8&&typeof item.path==='string'):[];restore()}
      if(data.type==='report-selection')frames().forEach(frame=>frame.contentWindow?.postMessage(data,'*'));
      if(data.type==='mode'){modeMessage={...data,route:[]};restore()}
      return;
    }
    const frame=frames().find(item=>item.contentWindow===event.source);
    if(!frame||frame.hasAttribute('srcdoc'))return;
    if(data?.source==='workstep-prototype-frames'&&data.token===config.token){
      if(data.kind==='hello'){
        children.set(event.source,data);
        forward(frame,{kind:'loaded',path:data.path,document:data.document});restore();
      }else if(children.has(event.source)&&['loaded','event'].includes(data.kind))forward(frame,data);
    }else if(data?.source==='workstep-prototype'&&config.editing){
      const child=children.get(event.source);
      if(child&&data.token===config.token&&data.version===child.document.version)forward(frame,{kind:'event',path:child.path,version:data.version,message:data});
    }
  });
  const reportPositions=()=>frames().forEach(frame=>frame.contentWindow?.postMessage({source:'workstep-prototype-host',type:'report-selection'},'*'));
  window.addEventListener('scroll',reportPositions,true);window.addEventListener('resize',reportPositions);
  post({kind:'hello',path:config.path,document:config.document});
})();
