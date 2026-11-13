const robot = '<svg class="avatar" viewBox="0 0 160 180" aria-label="二维机器人形象" role="img"><defs><linearGradient id="shell" x2="1" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#cbdcf2"/></linearGradient></defs><ellipse cx="80" cy="166" rx="38" ry="6" fill="#b5cbe6" opacity=".2"/><path d="M53 111Q80 94 107 111L119 148Q80 176 41 148Z" fill="url(#shell)" stroke="#b4cae4"/><path d="M56 122L45 149M104 122L115 149" stroke="#a8c3e2" stroke-width="4" stroke-linecap="round"/><rect x="22" y="25" width="116" height="89" rx="39" fill="url(#shell)" stroke="#b4cae4"/><rect x="35" y="43" width="90" height="52" rx="22" fill="#173652"/><ellipse class="eye" cx="59" cy="66" rx="6" ry="10" fill="#80d8ff"/><ellipse class="eye" cx="101" cy="66" rx="6" ry="10" fill="#80d8ff"/><path class="brow" d="M51 49l15 -2M94 47l15 2" stroke="transparent" stroke-linecap="round"/><rect class="mouth" x="73" y="81" width="14" height="3" rx="2" fill="#93e0ff"/><ellipse class="cheek" cx="44" cy="82" rx="7" ry="3" fill="#f7aac6"/><ellipse class="cheek" cx="116" cy="82" rx="7" ry="3" fill="#f7aac6"/><path d="M80 25V15" stroke="#83a9d5" stroke-width="4"/><circle cx="80" cy="11" r="5" fill="#74b7ef"/><circle cx="80" cy="132" r="7" fill="#8dbbea"/><path d="M57 153l-4 10M103 153l4 10" stroke="#a4bddb" stroke-width="7" stroke-linecap="round"/></svg>'
document.getElementById('avatar').innerHTML=robot
window.avatar.onState(state=>{
 document.getElementById('name').textContent=state.name
 document.getElementById('role').textContent=state.role
 document.getElementById('open').textContent='与'+state.name+'对话'
 document.getElementById('avatar').className=(state.speaking?'speaking ':'')+state.expression
})
document.getElementById('open').onclick=()=>window.avatar.open()
document.getElementById('hide').onclick=()=>window.avatar.hide()
