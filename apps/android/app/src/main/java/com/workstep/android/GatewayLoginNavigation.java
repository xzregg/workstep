package com.workstep.android;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

/** Keeps one Gateway login and its HTTPS identity redirects in the current WebView. */
final class GatewayLoginNavigation {
    private ServerAddress gateway;

    boolean staysInWebView(ServerAddress server, String url) {
        if (WebNavigation.staysInWebView(server, url)) return true;
        if (server == null || url == null) return false;
        try {
            URI target = new URI(url);
            if (target.getHost() == null || target.getRawUserInfo() != null
                    || !("https".equalsIgnoreCase(target.getScheme())
                    || "http".equalsIgnoreCase(target.getScheme()))) return false;
            if (gateway != null) {
                return gateway.contains(url) || "https".equalsIgnoreCase(target.getScheme());
            }
            if (!"/desktop/login".equals(target.getPath()) || target.getRawFragment() != null) return false;
            String callback = callbackParameter(target.getRawQuery());
            if (callback == null || !server.contains(callback)) return false;
            URI redirect = new URI(callback);
            if (!"/api/gateway-platform/callback".equals(redirect.getPath())
                    || redirect.getRawQuery() != null || redirect.getRawFragment() != null) return false;
            gateway = ServerAddress.parse(target.getScheme() + "://" + target.getRawAuthority());
            return true;
        } catch (IllegalArgumentException | URISyntaxException | UnsupportedEncodingException error) {
            return false;
        }
    }

    void pageStarted(ServerAddress server, String url) {
        if (server != null && server.contains(url)) reset();
    }

    void reset() {
        gateway = null;
    }

    private static String callbackParameter(String query) throws UnsupportedEncodingException {
        if (query == null) return null;
        String callback = null;
        for (String pair : query.split("&")) {
            String[] parts = pair.split("=", 2);
            if (!"redirect_uri".equals(parts[0])) continue;
            if (callback != null || parts.length != 2) return null;
            callback = URLDecoder.decode(parts[1], StandardCharsets.UTF_8.name());
        }
        return callback;
    }
}
