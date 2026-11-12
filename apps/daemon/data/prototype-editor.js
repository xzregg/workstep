/* Preview-only bridge. No credentials, filesystem tools, or network adapter. */
(() => {
  const version = __WS_VERSION__;
  const identities = new WeakMap();
  document.querySelectorAll('[data-ws-node]').forEach(element => {
    identities.set(element, element.getAttribute('data-ws-node'));
  });
  let mode = false, selected = null, hovered = null, editing = null, dragging = null;
  const host = document.createElement('div');
  host.setAttribute('data-ws-editor-overlay', '');
  const shadow = host.attachShadow({mode: 'closed'});
  shadow.innerHTML = `<style>
    :host{all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important}
    .box{position:fixed;border:1px solid var(--ws-accent, Highlight);box-sizing:border-box;display:none;pointer-events:none}
    .hover{border-style:dashed;background:transparent}
    .label{position:absolute;bottom:100%;left:0;background:var(--ws-accent, Highlight);color:HighlightText;font:12px sans-serif;padding:3px 6px;white-space:nowrap}
    .handle{position:absolute;width:8px;height:8px;background:Canvas;border:1px solid var(--ws-accent, Highlight);pointer-events:auto}
    [data-corner="nw"]{left:-5px;top:-5px;cursor:nwse-resize}
    [data-corner="ne"]{right:-5px;top:-5px;cursor:nesw-resize}
    [data-corner="sw"]{left:-5px;bottom:-5px;cursor:nesw-resize}
    [data-corner="w"]{left:-5px;top:50%;transform:translateY(-50%);cursor:ew-resize}
    [data-corner="n"]{top:-5px;left:50%;transform:translateX(-50%);cursor:ns-resize}
    [data-corner="se"]{right:-5px;bottom:-5px;cursor:nwse-resize}
    [data-corner="e"]{right:-5px;top:50%;transform:translateY(-50%);cursor:ew-resize}
    [data-corner="s"]{bottom:-5px;left:50%;transform:translateX(-50%);cursor:ns-resize}
  </style><div class="box hover"></div><div class="box selected"><span class="label"></span>${["n","ne","e","se","s","sw","w","nw"].map(corner=>`<i class="handle" data-corner="${corner}"></i>`).join("")}</div>`;
  document.documentElement.append(host);
  const hoverBox = shadow.querySelector('.hover'), selectionBox = shadow.querySelector('.selected');
  const send = (type, data = {}) => parent.postMessage({source:'workstep-prototype', type, version, ...data}, '*');
  const describe = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const properties = ['color','background-color','font-size','font-weight','border-radius','width','height','padding','margin'];
    return {node_id: identities.get(element) || null, tag:element.tagName.toLowerCase(),
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
    if(selected){const r=selected.getBoundingClientRect();shadow.querySelector('.label').textContent=`${selected.tagName.toLowerCase()} ${Math.round(r.width)} × ${Math.round(r.height)}`}
  };
  const choose = (element, comment=false) => {
    if (!element || element===host) return;
    selected=element;refresh();send('select',{selection:describe(element),comment});
    const css=getComputedStyle(element);
    const resizable=identities.has(element)&&!['HTML','BODY','HEAD','SCRIPT','STYLE'].includes(element.tagName)&&css.display!=='inline'&&css.transform==='none';
    shadow.querySelectorAll('.handle').forEach(handle=>handle.hidden=!resizable);
  };
  document.addEventListener('pointermove', event => {
    if(!mode||editing||dragging||event.target===host)return;
    hovered=event.target instanceof Element?event.target:null;refresh();
    if(hovered)send('hover',{selection:describe(hovered)});
  },true);
  document.addEventListener('click', event => {
    if(!mode||editing||event.target===host)return;
    event.preventDefault();event.stopImmediatePropagation();choose(event.target);
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
    if(event.key==='Escape'){event.preventDefault();if(editing)finishText(true);else{selected=null;refresh();send('clear')}}
    if(editing||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)||event.target.isContentEditable)return;
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
    if(event.source!==parent||event.data?.source!=='workstep-prototype-host')return;
    const data=event.data;
    if(data.type==='mode'){mode=Boolean(data.enabled);if(typeof data.accent==='string')host.style.setProperty('--ws-accent',data.accent);refresh()}
    if(data.type==='parent'&&selected?.parentElement)choose(selected.parentElement);
  });
  window.addEventListener('scroll',refresh,true);window.addEventListener('resize',refresh);
  new ResizeObserver(refresh).observe(document.documentElement);
  send('ready');
})();
