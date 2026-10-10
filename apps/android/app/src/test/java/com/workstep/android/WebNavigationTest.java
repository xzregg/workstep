package com.workstep.android;

import static org.junit.Assert.*;
import org.junit.Test;

public class WebNavigationTest {
    @Test public void keepsPlatformAndEnterpriseAuthorizationInsideWebView() {
        ServerAddress server = ServerAddress.parse("https://gateway.test");
        assertTrue(WebNavigation.staysInWebView(server, "https://gateway.test/auth?next=%2F"));
        assertTrue(WebNavigation.staysInWebView(server, "https://login.dingtalk.com/oauth2/auth?state=test"));
        assertTrue(WebNavigation.staysInWebView(server, "https://account.dingtalk.com/login"));
        assertTrue(WebNavigation.staysInWebView(server, "https://open.work.weixin.qq.com/wwopen/sso/qrConnect"));
        assertTrue(WebNavigation.staysInWebView(server, "https://gateway.test/api/auth/external/source/callback?code=test"));
    }
    @Test public void externalSitesAndLookalikeOriginsStayExternal() {
        ServerAddress server = ServerAddress.parse("https://gateway.test");
        for (String url : new String[]{"https://example.com", "https://login.dingtalk.com.evil.test/", "http://login.dingtalk.com/", "https://login.dingtalk.com:8443/", "https://user@login.dingtalk.com/", "dingtalk://login", "not a url"}) {
            assertFalse(url, WebNavigation.staysInWebView(server, url));
        }
        assertFalse(server.contains("https://login.dingtalk.com/oauth2/auth"));
        assertEquals("https://gateway.test/", server.pageOrRoot("https://login.dingtalk.com/oauth2/auth"));
    }
}
