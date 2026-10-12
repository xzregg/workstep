const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require(require.resolve('jsdom', { paths: [`${__dirname}/../../../apps/gateway-web`] }));
function page(name) {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/${name}.html`, 'utf8'), {
    runScripts: 'dangerously', url: `https://prototype.example/${name}.html`,
    beforeParse(window) {
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true };
      window.HTMLDialogElement.prototype.close = function () { this.open = false };
    },
  });
  return dom;
}
for (const name of ['device-management', 'device-ownership']) {
  test(`${name}: standalone HTML and valid JavaScript`, () => {
    const html = fs.readFileSync(`${__dirname}/${name}.html`, 'utf8');
    assert.match(html, /lang="zh-CN"/);
    assert.match(html, /<meta name="viewport"/);
    assert.doesNotMatch(html, /<script[^>]+src=/);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  });
}
test('combined owner, IP and device searches', () => {
  const html = fs.readFileSync(`${__dirname}/device-management.html`, 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const logic = script.slice(0, script.indexOf('// UI'));
  const ctx = vm.createContext({});
  vm.runInContext(logic, ctx);
  assert.equal(vm.runInContext("filterDevices({owner:'林',ip:'192.168.52',name:''}).length",ctx),2);
  assert.equal(vm.runInContext("filterDevices({owner:'林',ip:'10.20',name:''}).length",ctx),0);
  assert.equal(vm.runInContext("filterDevices({owner:'',ip:'',name:'not-found'}).length",ctx),0);
});
test('membership is additive and department is exclusive', () => {
  const html = fs.readFileSync(`${__dirname}/device-ownership.html`, 'utf8');
  const logic = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1].split('// UI')[0];
  const ctx = vm.createContext({}); vm.runInContext(logic,ctx);
  vm.runInContext("applyChange(['d1'],'add','预发布'); applyChange(['d1'],'add','预发布')",ctx);
  assert.equal(vm.runInContext("devices[0].groups.filter(x=>x==='预发布').length",ctx),1);
  assert.equal(vm.runInContext("devices[0].groups.includes('研发工作站')",ctx),true);
  vm.runInContext("applyChange(['d1'],'department','产品部')",ctx);
  assert.equal(vm.runInContext("devices[0].department",ctx),'产品部');
  assert.equal(vm.runInContext("devices[0].owner",ctx),'林晓');
});
test('search form combines filters, handles empty results and resets', () => {
  const dom = page('device-management'); const w = dom.window; const $ = s => w.document.querySelector(s);
  try {
    $('#owner').value = '林'; $('#ip').value = '192.168.52';
    $('#search').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal($('#rows').children.length, 2);
    $('#ip').value = '10.20'; $('#search').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal($('#rows').children.length, 0); assert.equal($('#empty').classList.contains('hidden'), false);
    $('#reset').click(); assert.equal($('#rows').children.length, 6);
    $('[data-detail="d1"]').click(); assert.equal($('#dialog').open, true);
    assert.match($('#dialog').textContent, /林晓/);
  } finally { w.close() }
});
test('batch department edit requires confirmation and preserves groups', () => {
  const dom = page('device-ownership'); const w = dom.window; const $ = s => w.document.querySelector(s);
  try {
    $('#select-all').click(); assert.equal($('#selected-count').textContent, '已选择 3 台设备');
    $('#batch-dept').click(); assert.equal($('#save').disabled, true);
    $('#target').value = '产品部'; $('#target').dispatchEvent(new w.Event('change'));
    assert.match($('#preview').textContent, /3 台设备将变更/);
    $('#confirm').click(); assert.equal($('#save').disabled, false); $('#save').click();
    assert.equal($('#dialog').open, false); assert.equal($('#members').children.length, 3);
    assert.equal(w.eval("devices.filter(d=>d.groups.includes('研发工作站')&&d.department==='产品部').length"),3);
    $('#dept-tab').click(); $('[data-scope="产品部"]').click(); assert.equal($('#members').children.length,4);
  } finally { w.close() }
});
test('new group starts empty, membership can be added then removed', () => {
  const dom = page('device-ownership'); const w = dom.window; const $ = s => w.document.querySelector(s);
  try {
    $('#create').click(); const name = $('#new-name'); name.value='预发布'; name.dispatchEvent(new w.Event('input'));
    $('#create-save').click(); assert.equal($('#members').children.length, 0);
    $('#add').click(); $('[data-candidate="d1"]').click(); $('#confirm').click(); $('#save').click();
    assert.equal($('#members').children.length, 1);
    $('#select-all').click(); $('#remove').click(); $('#confirm').click(); $('#save').click();
    assert.equal($('#members').children.length, 0);
    assert.equal(w.eval("devices[0].groups.includes('研发工作站')"),true);
    assert.equal(w.eval("devices[0].department"),'研发部');
  } finally { w.close() }
});
