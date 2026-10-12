
const labels={overview:'总览',user:'用户',device:'设备',project:'项目',model:'模型',provider:'供应商',events:'调用',billing:'账单'};
const names={user:['演示用户 A','演示用户 B','演示用户 C','演示用户 D'],device:['研发工作站','测试工作站','设计工作站','移动工作台'],project:['工作台演示','接口演示','自动化演示','文档演示'],model:['Claude Sonnet','GPT','DeepSeek','其他模型'],provider:['供应商 A','供应商 B','供应商 C','其他供应商']};
let tab='overview',factor=1,filters=[],search='';
let start='2026-09-13',end='2026-10-12';
const weights=[.54,.29,.13,.04],calls=[72,38,17,6];
const compact=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1000?(n/1000).toFixed(2)+'K':n.toLocaleString('zh-CN');
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const safe=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(text){const element=$('.toast');element.textContent=text;element.style.display='block';clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>element.style.display='none',2200)}
function updateMetrics(){
 const token=12091814*factor;
 $$('[data-metric]').forEach(element=>{
  const key=element.dataset.metric;
  element.innerHTML=key==='token'?`${(token/1e6).toFixed(2)} <small>M</small>`:key==='cache'?compact(11778304*factor):key==='calls'?`${Math.round(133*factor)} <small>次</small>`:compact((key==='input'?12056026:35788)*factor);
 });
 $$('.donut-center strong').forEach(e=>e.textContent=compact(token));
}
function rows(kind){
 const source=names[kind]??names.user;
 return source.map((name,i)=>({name,model:names.model[i%3],tokens:Math.round(12091814*weights[i]*factor),input:Math.round(12056026*weights[i]*factor),output:Math.round(35788*weights[i]*factor),cache:Math.round(11778304*weights[i]*factor),calls:Math.round(calls[i]*factor),status:i===0?'2 次待计量':'已计量'}));
}
function renderTables(){
 const kind=tab==='overview'?'user':tab;
 const data=rows(kind).filter(row=>row.name.includes(search)||row.model.toLowerCase().includes(search.toLowerCase()));
 $$('[data-table-title]').forEach(e=>e.textContent=tab==='events'?'调用明细':tab==='billing'?'供应商账单核对':labels[kind]+'用量排行');
 $$('[data-table-subtitle]').forEach(e=>e.textContent=tab==='events'?'当前筛选范围内的调用 · 点击查看事件':tab==='billing'?'原型演示 · 缺失账单保持待核对状态':'按总 Token 排序 · 名称优先展示');
 $$('[data-first-column]').forEach(e=>e.textContent=labels[kind]??'用户');
 $$('[data-rows]').forEach(body=>body.innerHTML=data.map((row,i)=>`<tr><td><div class="row-name"><span class="row-avatar">${safe(row.name.slice(-1))}</span><div><strong>${safe(row.name)}</strong><small>${safe(tab==='events'?row.model:kind==='project'?'研发工作站':'演示工作空间')}</small></div></div></td><td>${row.calls}</td><td>${compact(row.input)}</td><td>${compact(row.output)}</td><td>${compact(row.cache)}</td><td><strong>${compact(row.tokens)}</strong><div class="tinybar"><i style="width:${weights[i]*100}%"></i></div></td><td><span class="pill ${i===0?'warning':'good'}">${tab==='billing'?'等待账单':row.status}</span></td><td><button class="table-btn" data-detail="${safe(row.name)}">查看明细 ↗</button></td></tr>`).join('')||'<tr><td colspan="8">没有匹配的演示记录</td></tr>');
 $$('[data-row-total]').forEach(e=>e.textContent=`共 ${data.length} 项 · 名称优先展示，ID 在明细中查看`);
 $$('[data-search]').forEach(e=>{e.value=search;e.oninput=()=>{search=e.value;renderTables()}});
 $$('[data-detail]').forEach(e=>e.onclick=()=>detail(e.dataset.detail));
}
function renderRankings(){
 $$('[data-ranking]').forEach(element=>element.innerHTML=rows(element.dataset.ranking).map((row,i)=>`<div class="rank-row"><span class="rank-index">0${i+1}</span><div><div class="rank-meta"><button class="table-btn" data-detail="${safe(row.name)}">${safe(row.name)}</button></div><div class="rank-track"><div class="rank-fill" style="width:${weights[i]/weights[0]*100}%"></div></div></div><span class="rank-number">${compact(row.tokens)}</span></div>`).join(''));
 $$('[data-detail]').forEach(e=>e.onclick=()=>detail(e.dataset.detail));
}
function charts(){
 const days=Math.max(1,Math.min(31,Math.round((Date.parse(end)-Date.parse(start))/86400000)+1));
 const raw=Array.from({length:days},(_,i)=>360+((i*109+Math.floor(i/3)*70)%600));
 const sum=raw.reduce((a,b)=>a+b,0);
 const series=raw.map(value=>value/sum*12056026*factor/1000);
 const outputRatio=35788/12056026;
 $$('[data-chart]').forEach(svg=>{
  const height=Number(svg.getAttribute('viewBox').split(' ')[3]),bottom=height-28,top=18,left=43,right=635;
  const maximum=Math.max(...series,1)*1.22;
  const x=i=>days===1?(left+right)/2:left+i*(right-left)/(days-1),y=v=>bottom-v/maximum*(bottom-top);
  const line=series.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  const output=series.map((v,i)=>`${x(i)},${y(v*outputRatio)}`).join(' ');
  const area=`M ${left} ${bottom} L ${series.map((v,i)=>`${x(i)} ${y(v)}`).join(' L ')} L ${right} ${bottom} Z`;
  svg.innerHTML=`<defs><linearGradient id="wash-${height}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0071e3" stop-opacity=".09"/><stop offset="1" stop-color="#0071e3" stop-opacity="0"/></linearGradient></defs>`+
   [0,1,2,3].map(i=>`<line class="gridline" x1="${left}" x2="${right}" y1="${top+i*(bottom-top)/3}" y2="${top+i*(bottom-top)/3}"/><text x="0" y="${top+i*(bottom-top)/3+3}">${Math.round(maximum*(3-i)/3)}K</text>`).join('')+
   `<path d="${area}" fill="url(#wash-${height})"/><polyline class="curve" points="${line}"/><polyline class="output" points="${output}"/>`+
   series.map((v,i)=>`<rect class="hit" tabindex="0" data-day="${i}" x="${Math.max(left,x(i)-(right-left)/days/2)}" y="${top}" width="${(right-left)/days}" height="${bottom-top}" aria-label="第 ${i+1} 天：${Math.round(v)}K Token"><title>第 ${i+1} 天：${Math.round(v)}K Token</title></rect>`).join('')+
   `<text x="${left}" y="${height-4}">${start.slice(5).replace('-','/')}</text><text text-anchor="end" x="${right}" y="${height-4}">${end.slice(5).replace('-','/')}</text>`;
  svg.querySelectorAll('.hit').forEach(hit=>{
   const show=()=>{const tooltip=svg.parentElement.querySelector('.chart-tooltip');const day=Number(hit.dataset.day);tooltip.textContent=`第 ${day+1} 天 · 输入 ${Math.round(series[day])}K · 输出 ${(series[day]*outputRatio).toFixed(1)}K`;tooltip.style.display='block'};
   const hide=()=>svg.parentElement.querySelector('.chart-tooltip').style.display='none';
   hit.onpointerenter=show;hit.onfocus=show;hit.onclick=show;hit.onpointerleave=hide;hit.onblur=hide;
  });
 });
}
function selectTab(value){
 tab=value;search='';
 $$('[data-tab]').forEach(button=>{button.classList.toggle('active',button.dataset.tab===value);button.setAttribute('aria-selected',String(button.dataset.tab===value))});
 $('[data-overview]').style.display=value==='overview'?'block':'none';$('[data-dimension]').style.display=value==='overview'?'none':'block';
 renderTables();
}
function detail(name){
 $('#detail-name').textContent=name+' · 演示调用记录';
 $('#detail-content').innerHTML='<table><thead><tr><th>时间</th><th>模型</th><th>Token</th></tr></thead><tbody>'+[0,1,2].map((i)=>`<tr><td>10/12 ${10+i}:24</td><td>${names.model[i]}</td><td>${compact(13000+i*2850)}</td></tr>`).join('')+'</tbody></table><p class="muted" style="margin-top:16px">用户与项目的稳定 ID 在实际明细中保留。</p>';
 $('#detail-dialog').showModal();
}
function setPeriod(days){const endDate=new Date('2026-10-12T00:00:00Z'),startDate=new Date(endDate);startDate.setUTCDate(startDate.getUTCDate()-days+1);start=startDate.toISOString().slice(0,10);end=endDate.toISOString().slice(0,10);factor=days===7?.31:days===90?2.1:1;applyDate();$$('[data-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.period)===days))}
function applyDate(){
 $$('[data-date-label]').forEach(e=>e.textContent=start.replaceAll('-','.')+' — '+end.replaceAll('-','.'));
 $('#date-start').value=start;$('#date-end').value=end;
 updateMetrics();charts();renderTables();renderRankings();
}
$$('[data-period]').forEach(b=>b.onclick=()=>{setPeriod(Number(b.dataset.period));$('#date-dialog').close()});
$$('[data-tab]').forEach(b=>b.onclick=()=>selectTab(b.dataset.tab));
$$('[data-goto]').forEach(b=>b.onclick=()=>selectTab(b.dataset.goto));
$$('[data-date]').forEach(b=>b.onclick=()=>$('#date-dialog').showModal());
$$('[data-filter]').forEach(b=>b.onclick=()=>$('#filter-dialog').showModal());
$$('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$$('dialog').forEach(d=>d.onclick=e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}});
$('#apply-date').onclick=()=>{const a=$('#date-start').value,b=$('#date-end').value;if(!a||!b||a>b){toast('请选择有效日期范围');return}start=a;end=b;$$('[data-period]').forEach(b=>b.classList.remove('active'));applyDate();$('#date-dialog').close()};
$('#apply-filters').onclick=()=>{
 filters=['user','device','project','status'].map(key=>$('#filter-'+key).value).filter(Boolean);
 factor=filters.length?.54:1;
 $('[data-chips]').innerHTML=filters.map(value=>`<span class="chip">${safe(value)}</span>`).join(' ');
 $('[data-filter-count]').textContent=filters.length?' · '+filters.length:'';
 $('[data-chips]').style.marginBottom=filters.length?'18px':'0';
 updateMetrics();charts();renderTables();renderRankings();$('#filter-dialog').close();toast('已应用筛选 · 演示数据');
};
$('#clear-filters').onclick=()=>{['user','device','project','status'].forEach(key=>$('#filter-'+key).value='');$('#apply-filters').click()};
$('.source').onchange=()=>toast($('.source').value==='供应商账单'?'演示账单尚未导入，可进入账单对账查看':'正在查看设备回传演示数据');
$('[data-export]').onclick=()=>{const data=rows(tab==='overview'?'user':tab);const csv='\ufeff名称,调用次数,总Token\n'+data.map(r=>`${r.name},${r.calls},${r.tokens}`).join('\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='workstep-usage-demo.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出演示 CSV')};
applyDate();selectTab('overview');
