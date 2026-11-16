/* Preview-only bridge. No credentials, filesystem tools, or network adapter. */
(() => {
  const version = __WS_VERSION__;
  const token = document.currentScript?.nonce || null;
  const identities = new WeakMap();
  const nodes = new Map(), drafts = new Map();
  document.querySelectorAll('[data-ws-node]').forEach(element => {
    identities.set(element, element.getAttribute('data-ws-node'));
    nodes.set(element.getAttribute('data-ws-node'), element);
  });
  let mode = false, selected = null, hovered = null, editing = null, dragging = null;
  let suppressClick = false;
  const host = document.createElement('div');
  host.setAttribute('data-ws-editor-overlay', '');
  const shadow = host.attachShadow({mode: 'closed'});
  shadow.innerHTML = `<style>
    :host{all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important}
    .box{position:fixed;border:1px solid var(--ws-accent, Highlight);box-sizing:border-box;display:none;pointer-events:none}
    .hover{border-style:dashed;background:transparent}
    .label{position:absolute;bottom:100%;right:28px;background:Canvas;color:CanvasText;font:12px sans-serif;padding:3px 6px;white-space:nowrap;pointer-events:none}
    .move-handle{all:unset;box-sizing:border-box;position:absolute;right:0;top:-28px;width:24px;height:24px;display:grid;place-items:center;background:Canvas;color:CanvasText;border:1px solid #b8b8be;border-radius:4px;pointer-events:auto;cursor:grab;touch-action:none}
    .move-handle:active{cursor:grabbing}.move-handle:focus-visible{outline:2px solid CanvasText;outline-offset:2px}
    .snap-line{position:fixed;display:none;background:var(--ws-accent, Highlight);pointer-events:none}
    .snap-x{width:1px}.snap-y{height:1px}
    .handle{position:absolute;width:8px;height:8px;background:Canvas;border:1px solid var(--ws-accent, Highlight);pointer-events:auto}
    [data-corner="nw"]{left:-5px;top:-5px;cursor:nwse-resize}
    [data-corner="ne"]{right:-5px;top:-5px;cursor:nesw-resize}
    [data-corner="sw"]{left:-5px;bottom:-5px;cursor:nesw-resize}
    [data-corner="w"]{left:-5px;top:50%;transform:translateY(-50%);cursor:ew-resize}
    [data-corner="n"]{top:-5px;left:50%;transform:translateX(-50%);cursor:ns-resize}
    [data-corner="se"]{right:-5px;bottom:-5px;cursor:nwse-resize}
    [data-corner="e"]{right:-5px;top:50%;transform:translateY(-50%);cursor:ew-resize}
    [data-corner="s"]{bottom:-5px;left:50%;transform:translateX(-50%);cursor:ns-resize}
  </style><div class="snap-line snap-x"></div><div class="snap-line snap-y"></div><div class="box hover"></div><div class="box selected"><button type="button" class="move-handle" aria-label="Move" title="Move"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5 9-3 3 3 3m4-10 3-3 3 3m0 14-3 3-3-3m10-10 3 3-3 3M2 12h20M12 2v20"/></svg></button><span class="label"></span>${["n","ne","e","se","s","sw","w","nw"].map(corner=>`<i class="handle" data-corner="${corner}"></i>`).join("")}</div>`;
  document.documentElement.append(host);
  const hoverBox = shadow.querySelector('.hover'), selectionBox = shadow.querySelector('.selected');
  const send = (type, data = {}) => parent.postMessage({source:'workstep-prototype', type, version, token, ...data}, '*');
  const selectorFor = element => {
    const parts=[];
    for(let node=element;node&&node!==document.documentElement;node=node.parentElement){
      if(node.id){const id='#'+CSS.escape(node.id);if(document.querySelectorAll(id).length===1){parts.unshift(id);break}}
      const siblings=node.parentElement?Array.from(node.parentElement.children).filter(item=>item.tagName===node.tagName):[node];
      parts.unshift(node.tagName.toLowerCase()+Array.from(node.classList).slice(0,4).map(name=>'.'+CSS.escape(name)).join('')+(siblings.length>1?':nth-of-type('+(siblings.indexOf(node)+1)+')':''));
    }
    return parts.join(' > ');
  };
  const describe = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const properties = ['color','background-color','font-size','font-weight','border-radius','width','height','padding','margin','translate'];
    return {selector:selectorFor(element),node_id: identities.get(element) || null, tag:element.tagName.toLowerCase(),
      text:element.textContent.slice(0, 1000), id:element.id, classes: String(element.className).slice(0,500),
      rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      styles:Object.fromEntries(properties.map(key=>[key,style.getPropertyValue(key)])),
      ancestors: Array.from((function*(){let p=element.parentElement;while(p&&p!==document.documentElement){yield {node_id:identities.get(p)||null,tag:p.tagName.toLowerCase()};p=p.parentElement}})()).slice(0,8)};
  };
  const draw = (box, element) => {
    if (!mode || !element?.isConnected) {box.style.display='none';return}
    const rect=element.getBoundingClientRect();
    Object.assign(box.style,{display:'block',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
  };
  const refresh = () => {
    draw(hoverBox, hovered === selected ? null : hovered);draw(selectionBox,selected);
    if(selected){const r=selected.getBoundingClientRect();const handle=shadow.querySelector('.move-handle');handle.style.top=Math.max(-28,-r.top)+'px';handle.style.right=Math.max(0,r.right-innerWidth)+'px';shadow.querySelector('.label').textContent=`${selected.tagName.toLowerCase()} ${Math.round(r.width)} × ${Math.round(r.height)}`}
  };
  const resetDraft = nodeId => {
    const draft=drafts.get(nodeId), element=nodes.get(nodeId);
    if(!draft||!element)return;
    if(draft.style===null)element.removeAttribute('style');else element.setAttribute('style',draft.style);
    if(draft.textChanged)element.textContent=draft.text;
    drafts.delete(nodeId);refresh();
  };
  const previewDraft = data => {
    const element=nodes.get(data.node_id);
    if(!mode||editing||dragging||data.version!==version||!element?.isConnected||['HTML','BODY','HEAD','SCRIPT','STYLE'].includes(element.tagName))return;
    const values=data.values;
    if(!values||typeof values!=='object')return;
    if(data.operation==='style'){
      const allowed=['color','background-color','font-size','font-weight','border-radius','width','height','padding','margin','translate'];
      const entries=Object.entries(values);
      if(!entries.length||!entries.every(([key,value])=>allowed.includes(key)&&typeof value==='string'&&value.length<=100&&!/[;{}<>\\]|url\s*\(|expression\s*\(|!important/i.test(value)&&CSS.supports(key,value)))return;
    }else if(data.operation==='text'){
      if(typeof values.text!=='string'||[...element.childNodes].some(child=>child.nodeType!==Node.TEXT_NODE)||['AREA','BASE','BR','COL','EMBED','HR','IMG','INPUT','LINK','META','PARAM','SOURCE','TRACK','WBR'].includes(element.tagName))return;
    }else return;
    if(!drafts.has(data.node_id))drafts.set(data.node_id,{style:element.getAttribute('style'),text:element.textContent,textChanged:false});
    if(data.operation==='text'){element.textContent=values.text;drafts.get(data.node_id).textChanged=true}
    else Object.entries(values).forEach(([key,value])=>element.style.setProperty(key,value));
    refresh();
  };
  const choose = (element, comment=false) => {
    if (!element || element===host) return;
    selected=element;refresh();send('select',{selection:describe(element),comment});
    const css=getComputedStyle(element);
    const resizable=identities.has(element)&&!['HTML','BODY','HEAD','SCRIPT','STYLE'].includes(element.tagName)&&css.display!=='inline'&&css.transform==='none';
    shadow.querySelectorAll('.handle').forEach(handle=>handle.hidden=!resizable);
  };
  const snapAxis = (start,size,delta,edges,enabled) => {
    let distance=3,guide=null,adjustment=0;
    if(enabled)for(const edge of edges)for(const offset of [0,size]){
      const difference=edge-(start+delta+offset);
      if(Math.abs(difference)<distance){distance=Math.abs(difference);guide=edge;adjustment=difference}
    }
    return {delta:delta+adjustment,guide};
  };
  const startMove = event => {
    const element=selected;
    if(!mode||editing||dragging||event.button!==0||!element||!identities.has(element)||['HTML','BODY','HEAD','SCRIPT','STYLE'].includes(element.tagName))return;
    const css=getComputedStyle(element);
    if(css.display==='inline'||!CSS.supports('translate','1px 1px'))return;
    // Pointer deltas are viewport pixels; do not corrupt layouts with scaled/rotated axes.
    for(let ancestor=element.parentElement;ancestor;ancestor=ancestor.parentElement){
      const style=getComputedStyle(ancestor);
      if(style.transform!=='none'||(style.rotate&&style.rotate!=='none')||(style.scale&&style.scale!=='none')||(style.zoom&&!['normal','1','100%'].includes(style.zoom)))return;
    }
    resetDraft(identities.get(element));
    const rect=element.getBoundingClientRect(),parent=element.parentElement;
    if(!parent)return;
    const bounds=parent.getBoundingClientRect(),parentCss=getComputedStyle(parent);
    const edgesX=[bounds.left+parseFloat(parentCss.borderLeftWidth)+parseFloat(parentCss.paddingLeft),bounds.right-parseFloat(parentCss.borderRightWidth)-parseFloat(parentCss.paddingRight)];
    const edgesY=[bounds.top+parseFloat(parentCss.borderTopWidth)+parseFloat(parentCss.paddingTop),bounds.bottom-parseFloat(parentCss.borderBottomWidth)-parseFloat(parentCss.paddingBottom)];
    for(const sibling of parent.children){
      if(sibling===element||sibling===host||!identities.has(sibling))continue;
      const box=sibling.getBoundingClientRect();
      if(box.width&&box.height){edgesX.push(box.left,box.right);edgesY.push(box.top,box.bottom)}
    }
    const translate=css.translate==='none'?['0px','0px']:css.translate.split(/\s+/);
    if(translate.length>2)return;
    const pixels=(value,size)=>value?.endsWith('%')?parseFloat(value)*size/100:parseFloat(value||'0');
    const baseX=pixels(translate[0],element.offsetWidth||rect.width),baseY=pixels(translate[1],element.offsetHeight||rect.height);
    if(!Number.isFinite(baseX)||!Number.isFinite(baseY))return;
    const original=element.getAttribute('style'),startX=event.clientX,startY=event.clientY;
    const lineX=shadow.querySelector('.snap-x'),lineY=shadow.querySelector('.snap-y');
    let moved=false,done=false,values={};
    const restore=()=>{if(original===null)element.removeAttribute('style');else element.setAttribute('style',original)};
    const end=event=>{
      if(done)return;done=true;
      element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',end);element.removeEventListener('pointercancel',cancel);element.removeEventListener('lostpointercapture',cancel);
      dragging=null;lineX.style.display='none';lineY.style.display='none';restore();
      if(element.hasPointerCapture(event.pointerId))element.releasePointerCapture(event.pointerId);
      if(moved){
        if(event.type==='pointerup'){suppressClick=true;setTimeout(()=>{suppressClick=false},0)}
        send('drag-state',{active:false});
        if(event.type==='pointerup'){
          previewDraft({node_id:identities.get(element),version,operation:'style',values});
          send('select',{selection:describe(element)});
          send('edit',{node_id:identities.get(element),operation:'style',values});
        }
      }
      refresh();
    };
    const cancel=()=>end({type:'pointercancel',pointerId:event.pointerId});
    const move=pointer=>{
      const dx=pointer.clientX-startX,dy=pointer.clientY-startY;
      if(!moved&&Math.hypot(dx,dy)<4)return;
      if(!moved){moved=true;send('drag-state',{active:true})}
      pointer.preventDefault();window.getSelection()?.removeAllRanges();
      const x=snapAxis(rect.left,rect.width,dx,edgesX,!pointer.altKey),y=snapAxis(rect.top,rect.height,dy,edgesY,!pointer.altKey);
      values={translate:`${Math.round((baseX+x.delta)*100)/100}px ${Math.round((baseY+y.delta)*100)/100}px`};
      element.style.transition='none';element.style.translate=values.translate;
      Object.assign(lineX.style,{display:x.guide===null?'none':'block',left:x.guide+'px',top:bounds.top+'px',height:bounds.height+'px'});
      Object.assign(lineY.style,{display:y.guide===null?'none':'block',top:y.guide+'px',left:bounds.left+'px',width:bounds.width+'px'});
      refresh();
    };
    dragging={cancel:()=>{
      if(moved){
        suppressClick=true;
        document.addEventListener('pointerup',()=>setTimeout(()=>{suppressClick=false},0),{once:true,capture:true});
      }
      cancel();
    }};
    element.setPointerCapture(event.pointerId);
    element.addEventListener('pointermove',move);element.addEventListener('pointerup',end);element.addEventListener('pointercancel',cancel);element.addEventListener('lostpointercapture',cancel);
  };
  shadow.querySelector('.move-handle').addEventListener('pointerdown',startMove);
  document.addEventListener('pointermove', event => {
    if(!mode||editing||dragging||event.target===host)return;
    hovered=event.target instanceof Element?event.target:null;refresh();
    if(hovered)send('hover',{selection:describe(hovered)});
  },true);
  document.addEventListener('click', event => {
    if(!mode||editing||event.target===host)return;
    event.preventDefault();event.stopImmediatePropagation();if(suppressClick){suppressClick=false;return}choose(event.target);
  },true);
  document.addEventListener('contextmenu', event => {
    if(!mode||event.target===host)return;
    event.preventDefault();event.stopImmediatePropagation();choose(event.target,true);
  },true);
  const finishText = cancel => {
    if(!editing)return;
    const {element,text,attribute}=editing;editing=null;
    const next=element.textContent;
    if(attribute===null)element.removeAttribute('contenteditable');else element.setAttribute('contenteditable',attribute);
    element.textContent=text;
    if(!cancel&&next!==text)send('edit',{node_id:identities.get(element),operation:'text',values:{text:next}});
    refresh();
  };
  document.addEventListener('dblclick',event=>{
    if(!mode||!identities.has(event.target)||event.target.children.length||['INPUT','TEXTAREA','SCRIPT','STYLE'].includes(event.target.tagName))return;
    event.preventDefault();event.stopImmediatePropagation();
    const element=event.target;choose(element);
    editing={element,text:element.textContent,attribute:element.getAttribute('contenteditable')};
    element.setAttribute('contenteditable','plaintext-only');element.focus();
    element.addEventListener('blur',()=>finishText(false),{once:true});
  },true);
  document.addEventListener('keydown',event=>{
    if(!mode)return;
    if(event.key==='Escape'&&dragging?.cancel){event.preventDefault();dragging.cancel();return}
    if(event.key==='Escape'){event.preventDefault();if(editing)finishText(true);else{selected=null;refresh();send('clear')}}
    if(editing||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)||event.target.isContentEditable)return;
    if(!event.isComposing&&!event.repeat&&!event.shiftKey&&!event.altKey&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();if(!dragging)send('undo-request');return}
    if((event.key==='Delete'||event.key==='Backspace')&&selected){event.preventDefault();send('delete-request',{selection:describe(selected)})}
  },true);
  shadow.querySelectorAll('.handle').forEach(handle=>handle.addEventListener('pointerdown',event=>{
    if(!selected)return;event.preventDefault();event.stopPropagation();
    const element=selected, css=getComputedStyle(element), rect=element.getBoundingClientRect();
    const horizontal=css.boxSizing==='border-box'?0:parseFloat(css.paddingLeft)+parseFloat(css.paddingRight)+parseFloat(css.borderLeftWidth)+parseFloat(css.borderRightWidth);
    const vertical=css.boxSizing==='border-box'?0:parseFloat(css.paddingTop)+parseFloat(css.paddingBottom)+parseFloat(css.borderTopWidth)+parseFloat(css.borderBottomWidth);
    dragging={x:event.clientX,y:event.clientY,width:rect.width-horizontal,height:rect.height-vertical,style:element.getAttribute('style'),values:{}};
    handle.setPointerCapture(event.pointerId);
    const move=e=>{
      if(!dragging)return;
      const values={};
      if(/[ew]/.test(handle.dataset.corner))values.width=Math.max(1,Math.round(dragging.width+(e.clientX-dragging.x)*(handle.dataset.corner.includes('w')?-1:1)))+'px';
      if(/[ns]/.test(handle.dataset.corner))values.height=Math.max(1,Math.round(dragging.height+(e.clientY-dragging.y)*(handle.dataset.corner.includes('n')?-1:1)))+'px';
      Object.entries(values).forEach(([key,value])=>element.style.setProperty(key,value));dragging.values=values;refresh();
    };
    const end=e=>{
      if(!dragging)return;
      const saved=dragging;dragging=null;
      if(saved.style===null)element.removeAttribute('style');else element.setAttribute('style',saved.style);
      handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);
      if(e.type==='pointerup'&&Object.keys(saved.values).length)send('edit',{node_id:identities.get(element),operation:'style',values:saved.values});refresh();
    };
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  }));
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.data?.source!=='workstep-prototype-host'||event.data.route?.length)return;
    const data=event.data;
    if(data.type==='mode'){if(typeof data.moveLabel==='string'){const handle=shadow.querySelector('.move-handle');handle.title=data.moveLabel;handle.setAttribute('aria-label',data.moveLabel)}if(!data.enabled)dragging?.cancel?.();mode=Boolean(data.enabled);if(!mode)[...drafts.keys()].forEach(resetDraft);if(typeof data.accent==='string')host.style.setProperty('--ws-accent',data.accent);refresh()}
    if(data.type==='preview-draft')previewDraft(data);
    if(data.type==='preview-reset'&&data.version===version)resetDraft(data.node_id);
    if(data.type==='report-selection'&&selected)send('selection-position',{selection:describe(selected)});
    if(data.type==='clear-selection'){dragging?.cancel?.();selected=null;hovered=null;refresh()}
    if(data.type==='parent'&&selected?.parentElement)choose(selected.parentElement);
  });
  const reportPosition=()=>{refresh();if(selected)send('selection-position',{selection:describe(selected)})};
  window.addEventListener('scroll',reportPosition,true);window.addEventListener('resize',reportPosition);
  new ResizeObserver(refresh).observe(document.documentElement);
  send('ready');
})();
