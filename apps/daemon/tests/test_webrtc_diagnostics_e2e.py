"""Exercise diagnostic evidence using Chromium with no available ICE candidates."""
import pytest

from tests import test_webrtc_browser_e2e as browser_suite


@pytest.mark.timeout(180)
@pytest.mark.asyncio
async def test_direct_connection_diagnostics(tmp_path, monkeypatch, caplog):
    previous = browser_suite._build_node_runner

    def runner():
        source = previous()
        marker = '    if (screenshotDir) {\n      // Also capture remote read-only'
        assert marker in source
        injection = r'''
    const failedPage = await context.newPage();
    await failedPage.addInitScript(() => {
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(config) { super({...config, iceTransportPolicy:'relay', iceServers:[]}); }
      };
    });
    await failedPage.setViewportSize({width:390,height:844});
    await failedPage.goto(cfg.p2pUrl+'#pair_key='+encodeURIComponent(cfg.pairKey));
    await failedPage.locator('.webrtc-stage-list [data-failed="true"]').waitFor({timeout:30000});
    const failure = await failedPage.locator('.webrtc-pair-error').textContent();
    if (!failure.includes('未收集到可用网络地址')) throw new Error('Missing local candidate diagnosis: '+failure);
    const details = failedPage.locator('.webrtc-diagnostics');
    if (!await details.evaluate(el=>el.open)) throw new Error('Failure diagnostics must open automatically');
    const evidence = await details.textContent();
    if (!evidence.includes('本地 0 · 映射 0') || !evidence.includes('/ws/webrtc/client')) throw new Error('Missing ICE/signaling evidence');
    if (evidence.includes(cfg.pairKey) || evidence.includes('session_token=')) throw new Error('Credentials exposed in diagnostics');
    for (const viewport of [{width:320,height:568},{width:390,height:844}]) {
      await failedPage.setViewportSize(viewport);
      await failedPage.locator('.webrtc-pair-footer').scrollIntoViewIfNeeded();
      const geometry = await failedPage.evaluate(()=>({
        overflow:document.documentElement.scrollWidth>innerWidth,
        footer:document.querySelector('.webrtc-pair-footer').getBoundingClientRect().bottom,
        height:innerHeight,
      }));
      if (geometry.overflow || geometry.footer>geometry.height+1) throw new Error('Diagnostic mobile layout inaccessible');
      if (screenshotDir) await failedPage.screenshot({path:path.join(screenshotDir,'diagnostics-failed-'+viewport.width+'.png')});
    }
    await failedPage.close();
'''
        return source.replace(marker, injection + marker)

    monkeypatch.setattr(browser_suite, '_build_node_runner', runner)
    await browser_suite.test_chromium_direct_webrtc_p2p_e2e(
        tmp_path, monkeypatch, caplog, done_timeout=120,
    )
