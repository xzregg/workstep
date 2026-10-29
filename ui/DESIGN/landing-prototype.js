(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const localeData = window.WORKSTEP_PROTOTYPE_LOCALES;
  let currentLanguage = 'zh-CN';
  const t = key => key.split('.').reduce((value, part) => value?.[part], localeData.locales[currentLanguage].dictionary) || key;
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const screenshotRoot = '../../apps/landing/src/manual/screenshots/';
  const manualRoot = 'https://xzregg.github.io/workstep/#docs/';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const themeButton = $('#theme-toggle');
  const themePreference = matchMedia('(prefers-color-scheme: dark)');
  let explicitTheme = false;
  try { explicitTheme = ['light', 'dark'].includes(localStorage.getItem('workstep-prototype-theme')); } catch {}
  function syncEmbeddedMediaTheme() {
    $('#original-media')?.contentWindow?.postMessage({ type: 'workstep-prototype-language', lang: currentLanguage }, '*');
    $('#original-media')?.contentWindow?.postMessage({ type: 'workstep-prototype-theme', theme: document.documentElement.dataset.theme }, '*');
  }
  $('#original-media')?.addEventListener('load', syncEmbeddedMediaTheme);
  window.addEventListener('message', (event) => {
    const frame = $('#original-media');
    if (!frame || event.source !== frame.contentWindow || (event.origin !== location.origin && event.origin !== 'null')) return;
    if (event.data?.type === 'workstep-prototype-media-ready') syncEmbeddedMediaTheme();
    if (event.data?.type === 'workstep-prototype-media-height' && Number.isFinite(event.data.height)) {
      frame.style.height = `${Math.min(5000, Math.max(300, Math.ceil(event.data.height) + 2))}px`;
    }
  });
  function syncThemeButton() {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeButton.setAttribute('aria-pressed', String(dark));
    themeButton.setAttribute('aria-label', t(dark ? 'nav.themeLight' : 'nav.themeDark'));
    themeButton.title = t(dark ? 'nav.themeLight' : 'nav.themeDark');
    syncEmbeddedMediaTheme();
  }
  themeButton.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    explicitTheme = true;
    try { localStorage.setItem('workstep-prototype-theme', next); } catch {}
    syncThemeButton();
    drawFlow();
  });
  themePreference.addEventListener('change', (event) => {
    if (explicitTheme) return;
    document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
    syncThemeButton();
    drawFlow();
  });
  syncThemeButton();

  const panels = [
    `<div class="panel-kicker mono"><span>BRIEF / 明确目标</span><span>由你提出</span></div>
      <h3>一句需求，一份明确的交付物。</h3>
      <div class="prompt-block">请阅读 <code>README.md</code> 和 <code>example.txt</code>，先输出执行计划，再新建一份 <code>使用说明.md</code>。列出五项操作，每项用一句话说明。保留原文件。</div>
      <div class="file-row"><div class="file-chip">README.md <span>输入材料</span></div><div class="file-chip">example.txt <span>输入材料</span></div></div>
      <div class="panel-bottom"><p>先说清要读什么、做什么，以及交付什么。</p><button class="button button-solid" type="button" data-next-stage="1">看执行过程 <span aria-hidden="true">→</span></button></div>`,
    `<div class="panel-kicker mono"><span>EXECUTION / 步骤衔接</span><span>按依赖推进</span></div>
      <h3>上一份结果，就是下一步的起点。</h3>
      <div class="execution-entry"><span class="execution-marker" aria-hidden="true">✓</span><div><strong>需求分析</strong><p>读取两份材料，梳理约束，输出执行计划。</p></div><small>示例完成态</small></div>
      <div class="transfer-label">↳ 执行计划.md · 传递给下一步</div>
      <div class="execution-entry"><span class="execution-marker" aria-hidden="true">✓</span><div><strong>执行任务</strong><p>按照计划编写说明，核对五项操作与原文件。</p></div><small>示例完成态</small></div>
      <div class="panel-bottom"><p>同一个引擎可以执行两个步骤，无需先配置多个工具。</p><button class="button button-solid" type="button" data-next-stage="2">打开成果 <span aria-hidden="true">→</span></button></div>`,
    `<div class="panel-kicker mono"><span>DELIVERY / 可检查的结果</span><span>由你核对</span></div>
      <h3>得到一个文件，也知道它怎么来的。</h3>
      <div class="document-preview"><div class="document-header"><strong>使用说明.md</strong><small>示例内容</small></div><ol><li><b>连接 AI 工具</b>，验证后保存默认执行配置。</li><li><b>接入项目</b>，选择准备好的本地文件夹。</li><li><b>创建流程</b>，确定分析和执行的先后顺序。</li><li><b>运行任务</b>，查看每一步的执行过程。</li><li><b>核对成果</b>，检查生成文件与原始要求。</li></ol></div>
      <div class="panel-bottom"><p>完成状态只是起点，还要打开文件检查内容。</p><button class="button button-solid" type="button" data-open-result>看真实截图 <span aria-hidden="true">↗</span></button></div>`,
  ];
  function selectStage(index, focus = false) {
    if (!Number.isInteger(index) || !panels[index]) return;
    $$('.stage-tabs [role="tab"]').forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      if (focus && i === index) tab.focus();
    });
    $('#stage-panel').innerHTML = panels[index];
    $('#stage-panel').setAttribute('aria-labelledby', `stage-tab-${index}`);
    $('#demo-position').textContent = `0${index + 1} / 03`;
  }
  $$('.stage-tabs button').forEach((tab) => tab.addEventListener('click', () => selectStage(Number(tab.dataset.stage))));
  $('#stage-panel').addEventListener('click', (event) => {
    const next = event.target.closest('[data-next-stage]');
    if (next) selectStage(Number(next.dataset.nextStage), true);
    if (event.target.closest('[data-open-result]')) showScreenshot('first-task-result', '双步骤任务的真实结果', '演示项目完成“需求分析 → 执行任务”，并生成使用说明.md。截图来自中文操作手册。');
  });
  function keyboardTabs(container, count, selected, select) {
    container.addEventListener('keydown', (event) => {
      if (!event.target.matches('[role="tab"]')) return;
      let next = selected();
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (next + 1) % count();
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (next - 1 + count()) % count();
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = count() - 1;
      else return;
      event.preventDefault();
      select(next, true);
    });
  }
  keyboardTabs($('.stage-tabs'), () => 3, () => Number($('.stage-tabs [aria-selected="true"]').dataset.stage), selectStage);
  selectStage(0);

  const examplePrompt = '请阅读 README.md 和 example.txt，先输出执行计划，再在项目根目录新建使用说明.md。使用 Markdown 列出五项操作，每项用一句话说明。只读取这两个已有文件，不修改它们；允许新增使用说明.md，不修改其他文件。完成后说明生成文件的位置。';
  const sharedProject = {
    label: '接入演示项目', title: '先拿一个小文件夹练习。',
    intro: '用演示材料体验完整过程，再把流程用到自己的项目。',
    path: '侧边栏 → 添加项目 → 本地项目',
    items: ['准备一个独立文件夹，例如 <code>workstep-demo</code>。放入 <code>README.md</code> 和 <code>example.txt</code>；前者写五项需要介绍的操作，后者放补充说明。', '在“添加项目”中选择这个文件夹，确认后从侧边栏进入它。新项目没有流程，下一步再创建。'],
    image: 'project-connect-local', imageTitle: '选择本地项目目录',
    caption: '真实添加项目界面。首次练习使用独立目录。',
    detailTitle: '已经看到“默认工作区”，还需要添加项目吗？',
    detail: '默认工作区可以进行普通聊天；它不代表已经接入你的代码。这里添加独立演示目录，是为了让任务明确知道读取和保存文件的位置。项目数据默认保存在所选目录的 .workstep/ 中。',
    chapter: 'local-projects',
  };
  const sharedTask = {
    label: '完成第一个任务', title: '从分析，到一份真实文件。',
    intro: '第一次先使用“分析与执行”双步骤示例。先后关系已经明确，重点是跑通和核对。',
    path: '新手引导 → 创建示例流程 → 创建任务',
    items: ['在新手引导中点击“创建示例流程”。如果引导已关闭，可从“设置 → 系统设置 → 新手引导”重新打开。', '在任务页选择“分析与执行”，新建任务“整理项目说明”，从“需求分析”开始，粘贴下面的需求。选择“手动开始”，创建后再点击“开始任务”。', '等待两个步骤执行完成。打开 <code>使用说明.md</code> 核对五项操作，并检查原来的两个文件没有被修改。'],
    image: 'first-task-result', imageTitle: '双步骤任务完成后的真实结果',
    caption: '真实任务结果，来自操作手册演示项目。点击可放大。',
    detailTitle: '任务停住了，应该看哪里？',
    detail: '先分清状态：等待开始需要点击启动；等待提问或审批需要回应；执行中查看过程记录。失败时保留错误信息，先回到引擎卡片测试连接，再使用任务的恢复或重试入口。',
    chapter: 'first-task', prompt: true,
  };
  const routes = {
    existing: [
      {
        label: '连接已有工具', title: '从你熟悉的工具开始。',
        intro: '已在本机安装并完成认证的 Codex 或 Claude Code，可以走这条路径。无需为了体验先安装多个 SDK。',
        path: '设置 → 执行引擎',
        items: ['找到与你本机工具对应的 <b>CLI 引擎卡片</b>，确认应用能识别已安装的版本。', '检查该工具自己的登录或认证仍然有效，再在对应引擎卡片完成配置与测试。只有测试通过，才继续下一步。'],
        image: 'faq-sdk-cli', imageTitle: '区分 SDK 与 CLI 接入方式',
        caption: '中文手册中的引擎界面；本路径选择已有 CLI 工具。',
        detailTitle: '工具已安装，为什么还不能用？',
        detail: '“已安装”不等于“已认证”。先确认原工具能在本机正常调用，再检查 WorkStep 是否识别了正确的执行程序。网页聊天账号也不一定等同于 CLI 或 API 的访问权限。没有现成环境时，切换到“我还没有配置 AI 工具”路线。',
        chapter: 'sdk-credentials',
      },
      {
        label: '设为默认工具', title: '让新步骤知道该找谁执行。',
        intro: '首次只选择一个测试通过的引擎，后面两个步骤都可以使用它。',
        path: '设置 → 执行引擎 → 默认执行引擎',
        items: ['在引擎卡片检查默认模型；使用原生认证时，按该工具实际可用的模型选择。', '在“默认执行引擎”中选择刚才测试通过的工具，点击“保存默认值”。保存成功后再离开。'],
        image: 'execution-default-engine', imageTitle: '默认执行引擎的设置入口',
        caption: '此图仅展示入口：图中的 Pydantic AI 待配置，并非推荐你切换工具。',
        detailTitle: '默认值会改变已有任务吗？',
        detail: '不会覆盖已经明确指定引擎和模型的任务或步骤。助手对话也有自己的配置入口。这里先完成新建流程所需的默认执行配置。',
        chapter: 'execution-defaults',
      }, sharedProject, sharedTask,
    ],
    new: [
      {
        label: '安装一个工具', title: '只安装你准备使用的那一个。',
        intro: 'SDK 是 WorkStep 调用 AI 工具所需的组件。在软件界面里安装即可，不需要先学习终端命令。',
        path: '设置 → 执行引擎 → 安装与版本',
        items: ['根据你准备使用的服务，选择 Codex SDK 或 Claude Agent SDK 对应的 <b>sdk 模式卡片</b>。', '展开“安装与版本”，选择适用版本并点击安装。按界面要求阅读条款、确认安装，等待依赖安装与版本校验完成。', '按界面提示重启后台；桌面用户可退出后重新打开 WorkStep，再检查引擎是否显示已安装。'],
        image: 'sdk-install-version', imageTitle: '在软件界面中安装 SDK',
        caption: '真实安装入口：安装与版本 → 选择版本 → 安装所选版本。',
        detailTitle: '应该选哪一个？下载完就能使用吗？',
        detail: '选择取决于你的模型服务：Codex SDK 需要兼容的 OpenAI Responses 接口，Claude Agent SDK 需要兼容的 Anthropic Messages 接口。仅写“支持 OpenAI”不一定兼容。安装完成后，还需要下一步的服务认证；没有可用凭据时，应先确认服务提供方的接入方式。',
        chapter: 'sdk-installation',
      },
      {
        label: '连接并验证', title: '接通模型服务，再验证一次。',
        intro: '供应商提供模型服务与凭据；刚安装的引擎负责执行任务。只需把两者连接起来。',
        path: '设置 → 供应商；设置 → 执行引擎',
        items: ['添加供应商，按服务方说明填写兼容协议、API 地址与 API Key，保存并测试连接。获取模型后选择要用的模型，点击“保存所选”。', '回到引擎配置，绑定该供应商，保存配置并选择模型。Claude Agent SDK 还需阅读并确认必填的权限模式。点击引擎“测试”，等待“已验证”。', '在“默认执行引擎”中选择该引擎，点击“保存默认值”。测试会实际调用服务，可能产生费用。'],
        image: 'provider-create-test', imageTitle: '供应商与模型服务的配置入口',
        caption: '真实配置界面；API Key 由所选服务方提供。',
        detailTitle: '为什么供应商测试成功，还要测试引擎？',
        detail: '供应商测试确认模型接口可连通；引擎测试确认所选执行工具能够实际工作。若模型列表为空，先回供应商页面获取模型并保存所选，再返回引擎刷新。API 地址保留服务方要求的版本路径，不粘贴完整聊天接口路径。',
        chapter: 'sdk-credentials',
      }, sharedProject, sharedTask,
    ],
  };
  let route = 'new';
  let guideIndex = 0;
  function selectGuide(index, focus = false) {
    const entry = routes[route][index];
    if (!entry) return;
    if (currentLanguage !== 'zh-CN') { renderLocalizedGuide(index, focus); return; }
    guideIndex = index;
    $$('#guide-tabs button').forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      if (focus && i === index) tab.focus();
    });
    $('#guide-panel').setAttribute('aria-labelledby', `guide-tab-${index}`);
    $('#guide-panel').innerHTML = `<p class="guide-step-label mono">STEP 0${index + 1} / 04</p><h3>${entry.title}</h3><p class="guide-intro">${entry.intro}</p><div class="guide-path"><span>实际入口</span>${entry.path}</div><ol class="guide-instructions">${entry.items.map((item) => `<li>${item}</li>`).join('')}</ol>${entry.prompt ? `<blockquote class="guide-prompt">${examplePrompt}</blockquote><button type="button" class="copy-prompt" id="copy-prompt">复制示例需求 ↗</button><span id="copy-status" role="status"></span>` : ''}<button class="guide-image-button" type="button" data-guide-image aria-label="放大查看：${entry.imageTitle}"><img src="${screenshotRoot}${entry.image}.jpg" alt="${entry.imageTitle}" loading="lazy"><span>真实截图 · 点击放大 ↗</span></button><p class="guide-image-caption">${entry.caption}</p><details class="guide-extra"><summary>${entry.detailTitle}</summary><p>${entry.detail}</p></details><div class="guide-footer"><a href="${manualRoot}${entry.chapter}">阅读这一步的完整说明 ↗</a>${index < 3 ? '<button class="button button-solid" type="button" data-next-guide>下一步 <span aria-hidden="true">→</span></button>' : '<a class="button button-solid" href="#download">下载并开始 <span aria-hidden="true">↗</span></a>'}</div>`;
  }
  function selectRoute(next) {
    if (!routes[next]) return;
    route = next;
    $$('.route-picker > button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.route === route)));
    $('#guide-route-label').textContent = `${route === 'existing' ? '已有工具' : '从零开始'} / 4 个阶段`;
    $('#guide-tabs').innerHTML = routes[route].map((step, i) => `<button type="button" id="guide-tab-${i}" role="tab" aria-controls="guide-panel" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-guide="${i}"><span>${i + 1}</span><span>${step.label}</span></button>`).join('');
    if (currentLanguage !== 'zh-CN') localizeGuideTabs();
    selectGuide(0);
  }
  $$('.route-picker > button').forEach((button) => button.addEventListener('click', () => selectRoute(button.dataset.route)));
  $('#guide-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-guide]');
    if (tab) selectGuide(Number(tab.dataset.guide));
  });
  keyboardTabs($('#guide-tabs'), () => routes[route].length, () => guideIndex, selectGuide);
  $('#guide-panel').addEventListener('click', async (event) => {
    if (event.target.closest('[data-next-guide]')) {
      selectGuide(guideIndex + 1, true);
      if (matchMedia('(max-width: 800px)').matches) $('.guide-layout').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
    }
    if (event.target.closest('[data-guide-image]')) {
      const entry = routes[route][guideIndex];
      const chapter = localeData.locales[currentLanguage].chapters.find(item => item.id === entry.chapter);
      showScreenshot(entry.image, chapter?.title || entry.imageTitle, chapter ? t('manual.screenshotNotice') : entry.caption);
    }
    if (event.target.closest('#copy-prompt')) {
      const button = $('#copy-prompt');
      const status = $('#copy-status');
      try {
        await navigator.clipboard.writeText(examplePrompt);
        button.textContent = '已复制 ✓';
        status.textContent = '示例需求已复制，可以粘贴到任务描述。';
      } catch {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents($('.guide-prompt'));
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = '已选中，请手动复制';
        status.textContent = '浏览器未允许写入剪贴板，请复制已选中的文字。';
      }
    }
  });
  selectRoute('new');

  const screenshotDialog = $('#screenshot-dialog');
  function showScreenshot(id, title, caption) {
    $('#screenshot-title').textContent = title;
    $('#screenshot-caption').textContent = caption;
    $('#screenshot-image').src = `${screenshotRoot}${id}.jpg`;
    $('#screenshot-image').alt = title;
    $('.dialog-image-wrap').scrollTop = 0;
    screenshotDialog.showModal();
  }
  $('#close-screenshot').addEventListener('click', () => screenshotDialog.close());
  screenshotDialog.addEventListener('click', (event) => {
    const rect = screenshotDialog.getBoundingClientRect();
    if (event.target === screenshotDialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) screenshotDialog.close();
  });
  $('#show-real-result').addEventListener('click', () => showScreenshot('first-task-result', '双步骤任务的真实结果', '来自操作手册演示项目的真实截图。需求分析产出计划，执行任务生成使用说明.md。'));

  const platform = navigator.userAgent;
  const download = $('#platform-download');
  if (/Windows/i.test(platform)) {
    download.textContent = '下载 Windows 版 ↗';
    download.href = 'https://github.com/xzregg/workstep/releases/latest/download/WorkStep-windows-x64.exe';
    $('#platform-hint').textContent = 'Windows · x64';
  } else if (/Macintosh|Mac OS X/.test(platform) && !/iPhone|iPad/.test(platform) && navigator.maxTouchPoints < 2) {
    download.textContent = '选择 macOS 版本 ↗';
    $('#platform-hint').textContent = 'M 系列芯片选择 arm64；Intel 选择 x64';
  }

  // A bounded canvas field: no external assets, no WebGL, no background work offscreen.
  const canvas = $('#flow-field');
  const context = canvas.getContext('2d');
  const motionButton = $('#motion-toggle');
  let fieldWidth = 0;
  let fieldHeight = 0;
  let frame = null;
  let visible = true;
  let paused = reducedMotion.matches;
  let time = 0;
  let lastFrame = 0;
  let mouseX = 0;
  let mouseY = 0;
  function flowPoint(progress, strand) {
    const t = progress;
    const bend = Math.sin(t * Math.PI * 1.18 + strand * .026 + time * .12);
    return {
      x: fieldWidth * (.38 + t * .8) + mouseX * 8 * t,
      y: fieldHeight * (.73 - .44 * t) + bend * fieldHeight * .22 + strand * 5.6 + Math.sin(t * 7 + time * .2) * 5 + mouseY * 6 * t,
    };
  }
  function drawFlow() {
    if (!context || !fieldWidth || !fieldHeight) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    context.clearRect(0, 0, fieldWidth, fieldHeight);
    for (let strand = -15; strand < 22; strand++) {
      context.beginPath();
      for (let step = 0; step <= 75; step++) {
        const point = flowPoint(step / 75, strand);
        if (!step) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
      }
      context.strokeStyle = strand % 7 === 0 ? (dark ? 'rgba(240,138,96,.25)' : 'rgba(160,79,44,.19)') : (dark ? 'rgba(172,190,151,.10)' : 'rgba(100,123,91,.15)');
      context.lineWidth = strand % 7 === 0 ? 1 : .6;
      context.stroke();
      if (strand % 7 === 0) {
        const point = flowPoint(((time * .035 + strand * .032) % 1 + 1) % 1, strand);
        context.beginPath();
        context.arc(point.x, point.y, 2, 0, Math.PI * 2);
        context.fillStyle = dark ? 'rgba(240,138,96,.8)' : 'rgba(195,74,40,.65)';
        context.fill();
      }
    }
  }
  function animate(stamp) {
    frame = null;
    if (paused || !visible || document.hidden || reducedMotion.matches) return;
    if (stamp - lastFrame > 32) {
      time += Math.min((stamp - lastFrame) / 1000, .05);
      lastFrame = stamp;
      drawFlow();
    }
    frame = requestAnimationFrame(animate);
  }
  function updateMotion() {
    const stopped = paused || reducedMotion.matches;
    motionButton.setAttribute('aria-pressed', String(stopped));
    motionButton.textContent = currentLanguage === 'zh-CN' ? (reducedMotion.matches ? '已跟随系统减少动效' : paused ? '播放背景动效 ▷' : '暂停背景动效 Ⅱ') : t(paused || reducedMotion.matches ? 'common.play' : 'common.pause');
    motionButton.disabled = reducedMotion.matches;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (!stopped && visible && !document.hidden && context) {
      lastFrame = performance.now();
      frame = requestAnimationFrame(animate);
    }
    drawFlow();
  }
  function resizeFlow() {
    const bounds = canvas.getBoundingClientRect();
    fieldWidth = bounds.width;
    fieldHeight = bounds.height;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(fieldWidth * ratio);
    canvas.height = Math.round(fieldHeight * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawFlow();
  }
  new ResizeObserver(resizeFlow).observe($('.hero'));
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    updateMotion();
  }).observe($('.hero'));
  $('.hero').addEventListener('pointermove', (event) => {
    if (paused || reducedMotion.matches || event.pointerType === 'touch') return;
    const bounds = canvas.getBoundingClientRect();
    mouseX = (event.clientX - bounds.left) / bounds.width - .5;
    mouseY = (event.clientY - bounds.top) / bounds.height - .5;
  }, { passive: true });
  motionButton.addEventListener('click', () => { paused = !paused; updateMotion(); });
  reducedMotion.addEventListener('change', () => { paused = reducedMotion.matches; updateMotion(); });
  document.addEventListener('visibilitychange', updateMotion);
  window.addEventListener('pagehide', () => { if (frame !== null) cancelAnimationFrame(frame); });

  // The prototype reuses published translations; Chinese keeps the new editorial copy.
  const translatedElements = [
    ['.skip-link', 'manual.home'], ['.hero-kicker', 'hero.eyebrow'], ['#hero-title', 'hero.titleA'],
    ['.hero-description', 'hero.lede'], ['.hero-buttons .button-solid', 'hero.ctaPrimary'],
    ['.hero-buttons .button-text', 'hero.ctaSecondary'], ['.hero-footnote', 'hero.setup'],
    ['.request-slip p', 'scene.stream.user'], ['.slip-bottom', 'heroPreview.statusReady'],
    ['.delivery-slip strong', 'scene.stream.artifact1'], ['.delivery-bottom', 'hero.promise'],
    ['.art-note span:last-child', 'hero.meta2'], ['.hero-bottom p', 'engines.label'],
    ['.hero-bottom a', 'common.watchDemo'], ['#media-title', 'walkthrough.label'],
    ['.media-section .section-lede', 'walkthrough.duration'], ['.media-fallback a', 'common.watchDemo'],
    ['#work-title', 'philosophy.title'], ['.work-section .eyebrow', 'demos.eyebrow'],
    ['.work-section .section-lede', 'philosophy.lede'], ['.workbench-top > span:nth-child(2)', 'heroPreview.project'],
    ['.demo-badge', 'demos.eyebrow'], ['.workbench-sidebar h3', 'scene.stream.title'],
    ['.workbench-sidebar > p:not(.mono)', 'philosophy.statement'], ['.sidebar-note', 'features.item2Title'],
    ['.workbench-bottom > span:first-child', 'features.item4Title'], ['.example-caption p', 'manual.screenshotNotice'],
    ['#show-real-result', 'manual.enlarge'], ['#start-title', 'features.item2Title'],
    ['.getting-started .eyebrow', 'manual.groups.getting-started'], ['.getting-started .section-lede', 'hero.setup'],
    ['[data-route="existing"] strong', 'engines.codex'], ['[data-route="existing"] small', 'engines.claude'],
    ['[data-route="new"] strong', 'features.item2Title'], ['[data-route="new"] small', 'manual.groups.getting-started'],
    ['.guide-manual-link', 'manual.title'], ['.setup-truth', 'hero.setup'],
    ['#ownership-title', 'features.item6Title'], ['.ownership-copy > p:not(.privacy-note)', 'features.item6Desc'],
    ['.ownership-notes span:nth-child(1)', 'hero.meta4'], ['.ownership-notes span:nth-child(2)', 'hero.meta2'],
    ['.ownership-notes span:nth-child(3)', 'hero.meta3'], ['.privacy-note', 'privacy.externalServices'],
    ['.download-inner h2', 'finalCta.title'], ['.download-inner > div > p:not(.eyebrow)', 'finalCta.lede'],
    ['#platform-download', 'download.choosePlatform'], ['.download-actions .text-link', 'common.download'],
    ['.site-footer > span', 'footer.tagline'], ['.site-footer > small', 'footer.rights'],
    ['.nav-download', 'common.download'],
  ].map(([selector, key]) => ({ node: $(selector), key, original: $(selector).innerHTML }));
  const originalPanels = [...panels];
  const originalHint = $('#platform-hint').textContent;
  const originalFallbackText = $('.media-fallback').firstChild.textContent;
  const originalStageLabels = $$('.stage-tabs button > span:nth-child(2)').map(node => node.innerHTML);
  const originalBenefits = $$('.benefit-row article').map(node => [node.querySelector('h3').innerHTML, node.querySelector('p').innerHTML]);
  function chapterFor(index) {
    const id = routes[route][index].chapter;
    return localeData.locales[currentLanguage].chapters.find(chapter => chapter.id === id);
  }
  function localizeGuideTabs() {
    $('#guide-route-label').textContent = t('manual.groups.getting-started');
    $$('#guide-tabs button > span:last-child').forEach((node, index) => { node.textContent = chapterFor(index).title; });
  }
  function renderLocalizedGuide(index, focus) {
    guideIndex = index;
    const chapter = chapterFor(index);
    const entry = routes[route][index];
    $$('#guide-tabs button').forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1;
      if (focus && i === index) tab.focus();
    });
    $('#guide-panel').setAttribute('aria-labelledby', `guide-tab-${index}`);
    $('#guide-panel').innerHTML = `<p class="guide-step-label mono">0${index + 1} / 04</p><h3>${escapeHtml(chapter.title)}</h3><p class="guide-intro">${escapeHtml(chapter.summary)}</p>${chapter.sections.map(section => `<details class="guide-extra" ${section === chapter.sections[0] ? 'open' : ''}><summary>${escapeHtml(section.title)}</summary><ol class="guide-instructions">${(section.steps || []).map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>${(section.tips || []).map(tip => `<p>${escapeHtml(tip)}</p>`).join('')}</details>`).join('')}<button type="button" class="guide-image-button" data-guide-image aria-label="${escapeHtml(t('manual.enlarge'))}"><img src="${screenshotRoot}${entry.image}.jpg" alt="${escapeHtml(chapter.title)}" loading="lazy"><span>${escapeHtml(t('manual.enlarge'))} ↗</span></button><p class="guide-image-caption">${escapeHtml(t('manual.screenshotNotice'))}</p><div class="guide-footer"><a href="${manualRoot}${entry.chapter}">${escapeHtml(t('manual.title'))} ↗</a>${index < 3 ? `<button class="button button-solid" type="button" data-next-guide aria-label="${escapeHtml(t('manual.pagination'))}">0${index + 2} →</button>` : `<a class="button button-solid" href="#download">${escapeHtml(t('common.download'))} ↗</a>`}</div>`;
  }
  function applyLanguage(language) {
    if (!localeData.locales[language]) return;
    currentLanguage = language;
    $('#prototype-language').value = language;
    document.documentElement.lang = language;
    document.documentElement.dir = ['ar', 'he-IL'].includes(language) ? 'rtl' : 'ltr';
    document.title = t('meta.title');
    const chinese = language === 'zh-CN';
    translatedElements.forEach(({node, key, original}) => { if (chinese) node.innerHTML = original; else node.textContent = t(key); });
    $$('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    $('#prototype-language').setAttribute('aria-label', t('nav.language'));
    $('#close-screenshot').setAttribute('aria-label', t('common.close'));
    $('.nav-github').setAttribute('aria-label', 'GitHub');
    $('.site-footer a[href^="mailto:"]').textContent = chinese ? '联系' : 'Email';
    $('.media-fallback').firstChild.textContent = chinese ? originalFallbackText : '';
    $('#platform-hint').textContent = chinese ? originalHint : 'macOS · Windows · Linux';
    $$('.stage-tabs button > span:nth-child(2)').forEach((node, i) => {
      if (chinese) node.innerHTML = originalStageLabels[i]; else node.textContent = t(`philosophy.old${i+1}`);
    });
    $$('.benefit-row article').forEach((node, i) => {
      node.querySelector('h3').textContent = chinese ? originalBenefits[i][0] : t(`hero.meta${i+1}`);
      node.querySelector('p').textContent = chinese ? originalBenefits[i][1] : t(`features.item${i+2}Desc`);
    });
    for (let i = 0; i < 3; i++) panels[i] = chinese ? originalPanels[i] : `<div class="panel-kicker mono">0${i+1} / 03</div><h3>${escapeHtml(t(`philosophy.old${i+1}`))}</h3><div class="prompt-block">${escapeHtml(t(`philosophy.new${i+1}`))}</div><p>${escapeHtml(t('philosophy.lede'))}</p><div class="panel-bottom"><a class="button button-solid" href="#showcase">${escapeHtml(t('common.watchDemo'))} ↗</a></div>`;
    selectStage(0); selectRoute(route); syncThemeButton(); updateMotion();
    try { localStorage.setItem('workstep-prototype-language', language); } catch {}
  }
  $('#prototype-language').innerHTML = localeData.languages.map(({locale, label}) => `<option value="${locale}">${escapeHtml(label)}</option>`).join('');
  $('#prototype-language').addEventListener('change', event => applyLanguage(event.target.value));
  let savedLanguage = 'zh-CN';
  try { savedLanguage = localStorage.getItem('workstep-prototype-language') || 'zh-CN'; } catch {}
  applyLanguage(savedLanguage);
  resizeFlow();
  updateMotion();
})();
