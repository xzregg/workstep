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
}
