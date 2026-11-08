package com.workstep.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class WebPageRecoveryTest {
    private final ServerAddress server = ServerAddress.parse("https://gateway.example.com");

    @Test public void checksLocalAndDevicePagesButNotAuthenticationOrAssets() {
        for (String path : new String[]{"/chat", "/tasks", "/workspace/one/", "/workspace/one/chat", "/workspace/two/tasks"}) {
            assertTrue(path, WebPageRecovery.needsRootCheck(server, server.origin() + path + "?project=private"));
        }
        for (String path : new String[]{"/", "/login", "/workspace/one/assets/app.js", "/workspace/one/api/health"}) {
            assertFalse(path, WebPageRecovery.needsRootCheck(server, server.origin() + path));
        }
        assertFalse(WebPageRecovery.needsRootCheck(server, "https://login.example.com/chat"));
    }

    @Test public void nativeEscapeGoesToDevicePickerWithoutAutomaticReentry() {
        assertEquals(server.origin() + "/devices", WebPageRecovery.devicePicker(server,
                server.origin() + "/workspace/one/chat?session=private"));
        assertNull(WebPageRecovery.devicePicker(server, server.origin() + "/chat"));
        assertNull(WebPageRecovery.devicePicker(server, "https://evil.example/workspace/one/"));
        assertNull(WebPageRecovery.devicePicker(server, null));
    }

    @Test public void consoleSummaryKeepsErrorKindsWithoutLoggingArbitraryContent() {
        assertEquals("动态模块加载失败", WebPageRecovery.consoleSummary("TypeError: Failed to fetch dynamically imported module: https://private/assets/app.js?ticket=secret"));
        assertEquals("SyntaxError", WebPageRecovery.consoleSummary("Uncaught SyntaxError: Unexpected token 'private chat'"));
        assertEquals("TypeError", WebPageRecovery.consoleSummary("Uncaught TypeError: Cannot read properties of undefined (reading 'private')"));
        assertEquals("控制台错误（原文未记录）", WebPageRecovery.consoleSummary("private chat token=secret"));
        assertEquals("控制台错误（原文未记录）", WebPageRecovery.consoleSummary(null));
    }

    @Test public void sourceLocationExcludesCredentialsAndQueryAndRejectsNonWebSources() {
        assertEquals("/workspace/one/assets/app-ab12.js", WebPageRecovery.sourcePath("https://user:secret@example.com/workspace/one/assets/app-ab12.js?token=secret#private"));
        assertEquals("[非网页来源]", WebPageRecovery.sourcePath("data:text/javascript,private"));
        assertEquals("[未知来源]", WebPageRecovery.sourcePath(null));
    }

    @Test public void cspSummaryIdentifiesDirectiveAndRedactsResourceSecrets() {
        assertEquals("内容安全策略拦截；规则=connect-src；操作=网络连接；资源来源=wss://example.com:8443",
                WebPageRecovery.consoleSummary("Refused to connect to 'wss://user:secret@example.com:8443/private?token=secret#secret' because it violates the following Content Security Policy directive: \"connect-src 'self' https://private\"."));
        assertEquals("内容安全策略拦截；规则=script-src；操作=内联脚本",
                WebPageRecovery.consoleSummary("Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'nonce-secret'\"."));
        assertEquals("内容安全策略拦截；规则=img-src；操作=图片加载；资源来源=data:[内容已省略]",
                WebPageRecovery.consoleSummary("Refused to load the image 'data:image/png;base64,secret' because it violates the following Content Security Policy directive: \"img-src 'self'\"."));
    }

    @Test public void cspSummarySupportsModernMessagesAndSafeFallbacks() {
        assertEquals("内容安全策略拦截；规则=script-src-elem；操作=脚本加载；资源来源=https://cdn.example.com",
                WebPageRecovery.consoleSummary("Loading the script 'https://cdn.example.com/private.js?secret' violates the following Content Security Policy directive: \"script-src-elem 'self'\". The action has been blocked."));
        assertEquals("内容安全策略报告（未强制拦截）；规则=default-src；操作=网络连接；资源来源=[未知资源]",
                WebPageRecovery.consoleSummary("[Report Only] Refused to connect to 'not a url secret' because it violates the following Content Security Policy directive: \"default-src 'none'\"."));
        assertEquals("内容安全策略拦截；规则=未知", WebPageRecovery.consoleSummary("Content Security Policy private secret"));
        assertEquals("内容安全策略拦截；规则=未知", WebPageRecovery.consoleSummary("Content Security Policy directive: \"private-secret value\""));
    }
}
