package com.workstep.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Set;
import java.util.Locale;

/** Keep enterprise web authorization and its platform callback in one cookie store. */
final class WebNavigation {
    private static final Set<String> AUTH_HOSTS = Set.of(
            "login.dingtalk.com", "account.dingtalk.com", "open.work.weixin.qq.com");

    static boolean staysInWebView(ServerAddress server, String url) {
        if (server == null || url == null) return false;
        if (server.contains(url)) return true;
        try {
            URI uri = new URI(url);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
                    && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443)
                    && AUTH_HOSTS.contains(uri.getHost().toLowerCase(Locale.ROOT));
        } catch (URISyntaxException error) {
            return false;
        }
    }
}
