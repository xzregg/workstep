package com.workstep.android;

import static org.junit.Assert.*;
import org.junit.Test;

public class GatewayLoginNavigationTest {
    private static final ServerAddress LOCAL = ServerAddress.parse("https://phone.workstep.test");
    private static final String LOGIN = "https://gateway.test/desktop/login?state=abc&redirect_uri="
            + "https%3A%2F%2Fphone.workstep.test%2Fapi%2Fgateway-platform%2Fcallback";

    @Test public void gatewayLoginAndIdentityProviderStayInAppUntilLocalCallback() {
        GatewayLoginNavigation navigation = new GatewayLoginNavigation();
        assertTrue(navigation.staysInWebView(LOCAL, LOGIN));
        assertTrue(navigation.staysInWebView(LOCAL, "https://gateway.test/auth?next=%2Fdesktop%2Flogin"));
        assertTrue(navigation.staysInWebView(LOCAL, "https://identity.example/authorize?state=abc"));
        assertTrue(navigation.staysInWebView(LOCAL, "https://gateway.test/api/auth/external/source/callback?code=abc"));
        assertTrue(navigation.staysInWebView(LOCAL,
                "https://phone.workstep.test/api/gateway-platform/callback?code=abc&state=abc"));
        navigation.pageStarted(LOCAL, "https://phone.workstep.test/?gateway_auth=complete");
        assertFalse(navigation.staysInWebView(LOCAL, "https://identity.example/another-page"));
        assertFalse(navigation.staysInWebView(LOCAL, "https://gateway.test/admin"));
    }

    @Test public void forgedOrUnrelatedExternalLinksStillUseBrowser() {
        for (String url : new String[]{
                "https://gateway.test/desktop/login?redirect_uri=https%3A%2F%2Fevil.test%2Fapi%2Fgateway-platform%2Fcallback",
                "https://gateway.test/desktop/login?redirect_uri=https%3A%2F%2Fphone.workstep.test.evil.test%2Fapi%2Fgateway-platform%2Fcallback",
                "https://gateway.test/desktop/login?redirect_uri=https%3A%2F%2Fphone.workstep.test%2Fwrong",
                LOGIN + "&redirect_uri=https%3A%2F%2Fphone.workstep.test%2Fapi%2Fgateway-platform%2Fcallback",
                "https://gateway.test/other?redirect_uri=https%3A%2F%2Fphone.workstep.test%2Fapi%2Fgateway-platform%2Fcallback"}) {
            assertFalse(url, new GatewayLoginNavigation().staysInWebView(LOCAL, url));
        }
        assertFalse(new GatewayLoginNavigation().staysInWebView(LOCAL, "https://gateway.test/admin"));
    }

    @Test public void navigatingBackOrOpeningAnotherServerEndsLoginAllowance() {
        GatewayLoginNavigation navigation = new GatewayLoginNavigation();
        assertTrue(navigation.staysInWebView(LOCAL, LOGIN));
        navigation.pageStarted(LOCAL, "https://phone.workstep.test/projects");
        assertFalse(navigation.staysInWebView(LOCAL, "https://gateway.test/admin"));
        assertTrue(navigation.staysInWebView(LOCAL, LOGIN));
        navigation.reset();
        assertFalse(navigation.staysInWebView(LOCAL, "https://gateway.test/admin"));
    }

    @Test public void privateHttpGatewayCanReturnToPrivateHttpWorkStep() {
        ServerAddress local = ServerAddress.parse("http://192.168.1.10:8765");
        GatewayLoginNavigation navigation = new GatewayLoginNavigation();
        assertTrue(navigation.staysInWebView(local, "http://192.168.1.20:8700/desktop/login?redirect_uri="
                + "http%3A%2F%2F192.168.1.10%3A8765%2Fapi%2Fgateway-platform%2Fcallback"));
        assertTrue(navigation.staysInWebView(local, "http://192.168.1.20:8700/auth"));
        assertFalse(navigation.staysInWebView(local, "http://unrelated.test/"));
    }
}
