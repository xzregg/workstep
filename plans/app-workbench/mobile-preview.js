document.addEventListener('click',e=>{
 const size=e.target.closest('[data-width]');
 if(size?.tagName==='BUTTON'){
  document.querySelector('.phone').dataset.width=size.dataset.width;
  document.querySelectorAll('button[data-width]').forEach(b=>b.setAttribute('aria-pressed',String(b===size)));
  document.querySelector('#phone-content').title=`${size.dataset.width} 像素手机应用原型`;
 }
 const route=e.target.closest('[data-scenario]');
 if(route)document.querySelector('#phone-content').src=`integrated.html?scenario=${route.dataset.scenario}`;
});
