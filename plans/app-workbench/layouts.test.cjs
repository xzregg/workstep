const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('三个布局走通草稿、版本预览、部署与回滚，切会话保留输入',async()=>{
 const {Window}=await import(require.resolve('happy-dom',{paths:[path.resolve('apps/web')]}));
 for(const layout of ['a','b','c']) {
  const w=new Window(); w.document.write(fs.readFileSync(`plans/app-workbench/layout-${layout}.html`,'utf8'));
  w.eval(fs.readFileSync('plans/app-workbench/layouts.js','utf8'));
  const d=w.document,click=a=>d.querySelector(`[data-action="${a}"]`).click();
  d.querySelector('textarea').value='给客户列表加状态筛选'; click('send');
  assert.match(d.querySelector('#preview').textContent,/全部状态/);
  click('create'); click('confirm-create');
  assert.match(d.querySelector('#notice').textContent,/v1.3.0/);
  click('deploy'); click('confirm-deploy');
  assert.match(d.querySelector('#production').textContent,/v1.3.0/);
  click('rollback'); click('confirm-rollback');
  assert.match(d.querySelector('#production').textContent,/v1.2.0/);
  const s=d.querySelector('#version'); s.value='v1.1.0'; s.dispatchEvent(new w.Event('change'));
  assert.match(d.querySelector('#preview-state').textContent,/测试数据/);
  assert.doesNotMatch(d.querySelector('#preview').textContent,/全部状态/);
  d.querySelector('textarea').value='未发送内容'; click('session-other'); click('session-main');
  assert.equal(d.querySelector('textarea').value,'未发送内容');
  w.happyDOM.abort();
 }
});
